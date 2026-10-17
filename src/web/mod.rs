mod releases;
pub mod socket;
#[cfg(test)]
mod tests;

use std::{net::SocketAddr, path::PathBuf, sync::Arc};

use anyhow::Result;
use axum::{
    Json, Router,
    body::{Body, to_bytes},
    extract::{ConnectInfo, Path, Query, Request, State},
    http::{HeaderMap, Method, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Redirect, Response},
    routing::{get, post},
};
use serde::Deserialize;
use serde_json::{Value, json};
use socketioxide::SocketIo;
use tokio::sync::mpsc;

use crate::{
    auth::{
        AuthAction, AuthError, AuthSettingsRequest, LoginRequest, WebAuth, session_cookie,
        token_from_headers, unix_now,
    },
    dto::SettingsView,
    origin::DashboardOrigin,
};
use socket::SocketHub;

use crate::app::{
    AppError, Application, ENGLISH,
    api::{ChannelSelection, HistoryQuery},
};
pub use crate::app::{Command, CommandRequest, message};

pub struct WebState {
    pub accounts: Arc<crate::accounts::AccountManager>,
    pub shutdown: tokio_util::sync::CancellationToken,
    pub application: Arc<Application>,
    pub auth: Arc<WebAuth>,
    pub origin: DashboardOrigin,
    pub sockets: SocketHub,
    releases: releases::Releases,
    #[cfg(feature = "dashboard-fixture")]
    pub fixture: bool,
}

// Routes compose the application with transport security; the miner owns no HTTP state.
impl std::ops::Deref for WebState {
    type Target = Arc<Application>;
    fn deref(&self) -> &Self::Target {
        &self.application
    }
}

pub type App = WebState;

impl WebState {
    pub fn open(
        directory: PathBuf,
        public_base_url: &str,
    ) -> Result<(Arc<Self>, mpsc::Receiver<CommandRequest>)> {
        let (accounts, receiver) = crate::accounts::AccountManager::open(directory)?;
        let application = accounts.primary.clone();
        let auth = Arc::new(WebAuth::open(&application.data.path)?);
        Ok((
            Arc::new(Self {
                shutdown: accounts.shutdown.clone(),
                accounts,
                application,
                sockets: SocketHub::new(auth.clone()),
                auth,
                origin: DashboardOrigin::new(public_base_url)?,
                releases: releases::Releases::new()?,
                #[cfg(feature = "dashboard-fixture")]
                fixture: false,
            }),
            receiver,
        ))
    }
}

#[derive(Debug)]
pub struct ApiError(pub StatusCode, pub &'static str);

struct AccountApp(Arc<Application>);

impl axum::extract::FromRequestParts<Arc<App>> for AccountApp {
    type Rejection = ApiError;
    async fn from_request_parts(
        parts: &mut axum::http::request::Parts,
        state: &Arc<App>,
    ) -> Result<Self, ApiError> {
        let uri = parts
            .extensions
            .get::<axum::extract::OriginalUri>()
            .map(|uri| &uri.0)
            .unwrap_or(&parts.uri);
        let result = if let Some(path) = uri.path().strip_prefix("/api/accounts/") {
            state
                .accounts
                .account(path.split('/').next().unwrap_or_default())
                .await
        } else {
            state.accounts.sole_account().await
        };
        result
            .map(Self)
            .map_err(|error| AppError::from(error).into())
    }
}

async fn accounts(State(app): State<Arc<App>>) -> Json<crate::accounts::Overview> {
    Json(app.accounts.overview().await)
}
async fn account_action(
    State(app): State<Arc<App>>,
    request: Request,
) -> Result<Json<Value>, ApiError> {
    let result = app.accounts.request(document(request).await?).await?;
    #[cfg(feature = "dashboard-fixture")]
    if app.fixture {
        crate::fixture::pending_workers(&app).await;
    }
    Ok(Json(result))
}
async fn connection(State(app): State<Arc<App>>) -> Json<Value> {
    Json(app.accounts.connection().await)
}

async fn games(
    AccountApp(app): AccountApp,
    Json(query): Json<crate::app::commands::GameQuery>,
) -> Result<Json<Vec<crate::config::GameMetadata>>, ApiError> {
    Ok(Json(app.games(query).await?))
}
async fn search_channels(
    AccountApp(app): AccountApp,
    Json(query): Json<crate::app::commands::ChannelQuery>,
) -> Result<Json<Vec<crate::dto::ChannelSearchResult>>, ApiError> {
    Ok(Json(app.search_channels(query).await?))
}

impl ApiError {
    fn invalid() -> Self {
        Self(StatusCode::BAD_REQUEST, "invalid_request")
    }
    fn unavailable() -> Self {
        Self(StatusCode::SERVICE_UNAVAILABLE, "request_failed")
    }
}
impl From<AppError> for ApiError {
    fn from(error: AppError) -> Self {
        match error {
            AppError::Account(error) => Self(
                if matches!(error, crate::accounts::Error::NotFound) {
                    StatusCode::NOT_FOUND
                } else {
                    StatusCode::CONFLICT
                },
                error.code(),
            ),
            AppError::Telegram(error) => Self(
                if error == twitch_drops_miner_core::notifications::Error::Conflict {
                    StatusCode::CONFLICT
                } else {
                    StatusCode::BAD_REQUEST
                },
                error.code(),
            ),
            AppError::InvalidRequest => Self::invalid(),
            AppError::InvalidManualDuration => {
                Self(StatusCode::BAD_REQUEST, "invalid_manual_duration")
            }
            AppError::InvalidChannel => Self(StatusCode::BAD_REQUEST, "invalid_channel"),
            AppError::ChannelNotFound => Self(StatusCode::NOT_FOUND, "channel_not_found"),
            AppError::ShuttingDown => Self(StatusCode::CONFLICT, "shutting_down"),
            AppError::LoginRequired => Self(StatusCode::CONFLICT, "twitch_login_required"),
            AppError::SettingsConflict => Self(StatusCode::CONFLICT, "settings_conflict"),
            AppError::InvalidSettings => Self(StatusCode::BAD_REQUEST, "invalid_settings"),
            AppError::Unavailable => Self::unavailable(),
        }
    }
}
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(json!({"detail":self.1}))).into_response()
    }
}
impl IntoResponse for AuthError {
    fn into_response(self) -> Response {
        let mut response =
            (self.status(), Json(json!({"detail":self.to_string()}))).into_response();
        if self == Self::RateLimited {
            response
                .headers_mut()
                .insert(header::RETRY_AFTER, "60".parse().unwrap());
        }
        response
    }
}

pub fn router(app: Arc<App>) -> Router {
    let (layer, io) = SocketIo::builder().max_payload(1024 * 1024).build_layer();
    SocketHub::attach(&app, io);
    let mut routes = Router::new()
        .route("/healthz", get(|| async { Json(json!({"status":"ok"})) }))
        .route("/", get(index))
        .route("/campaigns", get(index))
        .route("/history", get(index))
        .route("/activity", get(index))
        .route("/settings", get(index))
        .route("/login", get(login_page))
        .route("/assets/{*path}", get(asset))
        .route("/manifest.webmanifest", get(manifest))
        .route("/api/auth/status", get(auth_status))
        .route("/api/auth/login", post(auth_login))
        .route("/api/auth/logout", post(auth_logout))
        .route("/api/auth/settings", post(auth_settings))
        .nest("/api/accounts/{account}", account_routes())
        .nest("/api", account_routes())
        .route("/api/accounts", get(accounts).post(account_action))
        .route("/api/connection", get(connection))
        .route("/api/telegram", get(telegram).post(save_telegram))
        .route("/api/telegram/bot", get(telegram_bot))
        .route("/api/telegram/test", post(test_telegram))
        .route("/api/settings/verify-proxy", post(verify_proxy))
        .route("/api/version", get(version))
        .route("/api/close", post(close));
    #[cfg(feature = "dashboard-fixture")]
    if app.fixture {
        routes = super::fixture::routes(routes);
    }
    for path in APP_ICONS {
        routes = routes.route(path, get(app_icon));
    }
    routes = routes
        .layer(layer)
        .layer(middleware::from_fn_with_state(app.clone(), guard));
    routes.with_state(app)
}

fn account_routes() -> Router<Arc<App>> {
    Router::new()
        .route("/status", get(status))
        .route("/channels", get(channels))
        .route("/channels/select", post(select_channel))
        .route("/channels/search", post(search_channels))
        .route("/campaigns", get(campaigns))
        .route("/console", get(console))
        .route("/settings", get(settings).post(update_settings))
        .route("/games", post(games))
        .route("/history", get(history))
        .route("/history/stats", get(history_stats))
        .route("/twitch/logout", post(logout_twitch))
        .route("/oauth/confirm", post(confirm_oauth))
        .route("/reload", post(reload))
        .route("/cache/clear", post(clear_cache))
        .route("/mode/exit-manual", post(exit_manual))
}

async fn guard(State(app): State<Arc<App>>, mut request: Request, next: Next) -> Response {
    let path = request.uri().path().to_owned();
    let secure_transport = request.uri().scheme_str() == Some("https");
    if !app
        .origin
        .permits(request.method(), &path, request.headers(), secure_transport)
    {
        return private(ApiError(StatusCode::FORBIDDEN, "forbidden").into_response());
    }
    let asset =
        path.starts_with("/assets/") && matches!(*request.method(), Method::GET | Method::HEAD);
    let app_metadata = matches!(*request.method(), Method::GET | Method::HEAD)
        && (path == "/manifest.webmanifest" || APP_ICONS.contains(&path.as_str()));
    let public = asset
        || app_metadata
        || matches!(
            path.as_str(),
            "/login" | "/healthz" | "/api/auth/status" | "/api/auth/login"
        );
    #[cfg(feature = "dashboard-fixture")]
    let public = public
        || app.fixture
            && matches!(
                path.as_str(),
                "/__test/health" | "/__test/reset" | "/__test/event"
            );
    if !public
        && !app
            .auth
            .state
            .lock()
            .await
            .allowed(&token_from_headers(request.headers()), unix_now())
    {
        let response = if matches!(
            path.as_str(),
            "/" | "/campaigns" | "/history" | "/activity" | "/settings"
        ) {
            Redirect::to("/login").into_response()
        } else {
            ApiError(StatusCode::UNAUTHORIZED, "authentication_required").into_response()
        };
        return private(response);
    }
    // Bound every submitted document and suppress extractor errors that could echo secrets.
    if !matches!(
        *request.method(),
        Method::GET | Method::HEAD | Method::OPTIONS
    ) && !path.starts_with("/socket.io")
    {
        let limit = if path.starts_with("/api/auth/") {
            16384
        } else {
            1024 * 1024
        };
        let (parts, body) = request.into_parts();
        let Ok(body) = to_bytes(body, limit).await else {
            return private(
                ApiError(StatusCode::PAYLOAD_TOO_LARGE, "invalid_request").into_response(),
            );
        };
        request = Request::from_parts(parts, Body::from(body));
    }
    let response = next.run(request).await;
    if asset && response.status().is_success() {
        no_sniff(response)
    } else {
        private(response)
    }
}

// The browser counterpart of the desktop window policy: only bundled code runs, connections
// stay same-origin, and remote content is limited to HTTPS images such as Twitch artwork.
const DOCUMENT_POLICY: &str = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; frame-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'";

fn no_sniff(mut response: Response) -> Response {
    response
        .headers_mut()
        .insert(header::X_CONTENT_TYPE_OPTIONS, "nosniff".parse().unwrap());
    response
}

fn private(response: Response) -> Response {
    let mut response = no_sniff(response);
    if !response.headers().contains_key(header::CACHE_CONTROL) {
        response
            .headers_mut()
            .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    }
    response
        .headers_mut()
        .insert(header::X_FRAME_OPTIONS, "DENY".parse().unwrap());
    response
        .headers_mut()
        .insert(header::REFERRER_POLICY, "same-origin".parse().unwrap());
    response
}

#[derive(rust_embed::RustEmbed)]
#[folder = "web/"]
struct Assets;

async fn index() -> Response {
    let mut response = serve_asset("index.html", false);
    response.headers_mut().insert(
        header::CONTENT_SECURITY_POLICY,
        DOCUMENT_POLICY.parse().unwrap(),
    );
    response
}
async fn login_page(State(app): State<Arc<App>>, headers: HeaderMap) -> Response {
    if app
        .auth
        .state
        .lock()
        .await
        .allowed(&token_from_headers(&headers), unix_now())
    {
        Redirect::to("/").into_response()
    } else {
        index().await
    }
}
async fn asset(Path(path): Path<String>) -> Response {
    serve_asset(&format!("assets/{path}"), true)
}
const APP_ICONS: [&str; 4] = [
    "/pwa/icon-192.png",
    "/pwa/icon-512.png",
    "/pwa/maskable-512.png",
    "/pwa/apple-touch-icon.png",
];

async fn manifest() -> Response {
    let mut response = serve_asset("manifest.webmanifest", false);
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        "application/manifest+json".parse().unwrap(),
    );
    response
}

async fn app_icon(request: Request) -> Response {
    serve_asset(request.uri().path().trim_start_matches('/'), false)
}

fn serve_asset(path: &str, immutable: bool) -> Response {
    if path
        .split('/')
        .any(|part| matches!(part, "." | "..") || part.contains('\\'))
    {
        return StatusCode::NOT_FOUND.into_response();
    }
    let Some(asset) = Assets::get(path) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    (
        [
            (
                header::CONTENT_TYPE,
                mime_guess::from_path(path)
                    .first_or_octet_stream()
                    .to_string(),
            ),
            (
                header::CACHE_CONTROL,
                if immutable {
                    "public, max-age=31536000, immutable"
                } else {
                    "no-cache"
                }
                .to_owned(),
            ),
        ],
        asset.data.into_owned(),
    )
        .into_response()
}

async fn document<T: serde::de::DeserializeOwned>(request: Request) -> Result<T, ApiError> {
    let bytes = to_bytes(request.into_body(), 1024 * 1024)
        .await
        .map_err(|_| ApiError::invalid())?;
    serde_json::from_slice(&bytes).map_err(|_| ApiError::invalid())
}

async fn auth_status(State(app): State<Arc<App>>, headers: HeaderMap) -> Json<Value> {
    let state = app.auth.state.lock().await;
    Json(
        json!({"enabled":state.enabled(),"authenticated":state.allowed(&token_from_headers(&headers),unix_now()),"translations":ENGLISH["gui"]["auth"]}),
    )
}

fn peer(request: &Request) -> Option<std::net::IpAddr> {
    request
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|v| v.0.ip())
}
fn cookie_secure(app: &App, request: &Request) -> bool {
    app.origin
        .secure_cookie(request.uri().scheme_str() == Some("https"))
}
async fn auth_response(
    app: &App,
    token: &str,
    remember: bool,
    secure: bool,
    disconnect_all: bool,
) -> Response {
    app.sockets.prune(disconnect_all).await;
    let enabled = app.auth.state.lock().await.enabled();
    (
        [(header::SET_COOKIE, session_cookie(token, remember, secure))],
        Json(json!({"success":true,"enabled":enabled})),
    )
        .into_response()
}
async fn auth_login(State(app): State<Arc<App>>, request: Request) -> Response {
    let previous = token_from_headers(request.headers());
    let peer = peer(&request);
    let secure = cookie_secure(&app, &request);
    let data = match document::<LoginRequest>(request).await {
        Ok(v) => v,
        Err(e) => return e.into_response(),
    };
    let remember = data.remember;
    match app.auth.login(data, &previous, peer).await {
        Ok(token) => auth_response(&app, &token, remember, secure, false).await,
        Err(e) => e.into_response(),
    }
}
async fn auth_logout(State(app): State<Arc<App>>, request: Request) -> Response {
    let token = token_from_headers(request.headers());
    let secure = cookie_secure(&app, &request);
    match app.auth.logout(&token).await {
        Ok(()) => auth_response(&app, "", false, secure, false).await,
        Err(e) => e.into_response(),
    }
}
async fn auth_settings(State(app): State<Arc<App>>, request: Request) -> Response {
    let token = token_from_headers(request.headers());
    let peer = peer(&request);
    let secure = cookie_secure(&app, &request);
    let data = match document::<AuthSettingsRequest>(request).await {
        Ok(v) => v,
        Err(e) => return e.into_response(),
    };
    let disable = data.action == AuthAction::Disable;
    match app.auth.configure(data, &token, peer).await {
        Ok(token) => auth_response(&app, &token, false, secure, disable).await,
        Err(e) => e.into_response(),
    }
}

async fn status(AccountApp(app): AccountApp) -> Json<Value> {
    let state = app.snapshot.read().await;
    Json(json!({"status":state.status,"login":state.login,"manual_mode":state.manual_mode}))
}
async fn channels(AccountApp(app): AccountApp) -> Json<Value> {
    Json(json!({"channels":app.snapshot.read().await.channels}))
}
async fn campaigns(AccountApp(app): AccountApp) -> Json<Value> {
    Json(json!({"campaigns":app.snapshot.read().await.campaigns}))
}
async fn console(AccountApp(app): AccountApp) -> Json<Value> {
    Json(json!({"lines":app.snapshot.read().await.console}))
}
async fn settings(AccountApp(app): AccountApp) -> Json<SettingsView> {
    Json(app.snapshot.read().await.settings.clone())
}

async fn update_settings(
    AccountApp(app): AccountApp,
    request: Request,
) -> Result<Json<Value>, ApiError> {
    let patch: Value = document(request).await?;
    let settings = app.update_settings(patch).await?;
    Ok(Json(json!({"success":true,"settings":settings})))
}

async fn select_channel(
    AccountApp(app): AccountApp,
    request: Request,
) -> Result<Json<Value>, ApiError> {
    let selection: ChannelSelection = document(request).await?;
    app.select_channel(selection).await?;
    Ok(Json(json!({"success":true})))
}

async fn history(AccountApp(app): AccountApp, Query(query): Query<HistoryQuery>) -> Json<Value> {
    Json(app.history(query).await)
}

async fn history_stats(AccountApp(app): AccountApp) -> Json<Value> {
    Json(app.history.lock().await.stats())
}
async fn run_command(app: &Application, command: Command) -> Result<Json<Value>, ApiError> {
    app.command(command).await?;
    Ok(Json(json!({"success":true})))
}
async fn reload(AccountApp(app): AccountApp) -> Result<Json<Value>, ApiError> {
    app.refresh_inventory().await?;
    Ok(Json(json!({"success":true})))
}
async fn clear_cache(AccountApp(app): AccountApp) -> Result<Json<Value>, ApiError> {
    app.clear_cache().await?;
    Ok(Json(json!({"success":true})))
}
async fn logout_twitch(AccountApp(app): AccountApp) -> Result<Json<Value>, ApiError> {
    run_command(&app, Command::Logout).await
}
async fn confirm_oauth(AccountApp(app): AccountApp) -> Result<Json<Value>, ApiError> {
    run_command(&app, Command::ConfirmOAuth).await
}
async fn exit_manual(AccountApp(app): AccountApp) -> Result<Json<Value>, ApiError> {
    run_command(&app, Command::ExitManual).await
}
async fn close(State(app): State<Arc<App>>) -> Result<Json<Value>, ApiError> {
    app.shutdown.cancel();
    Ok(Json(json!({"success":true})))
}

async fn verify_proxy(
    State(app): State<Arc<App>>,
    request: Request,
) -> Result<Json<Value>, ApiError> {
    #[derive(Deserialize)]
    struct Proxy {
        proxy: String,
    }
    let Proxy { proxy } = document(request).await?;
    crate::config::validate_proxy(&proxy).map_err(|_| ApiError::invalid())?;
    if proxy.is_empty() {
        return Ok(Json(
            json!({"success":false,"message":message("gui.backend.proxy_empty",&[])}),
        ));
    }
    #[cfg(feature = "dashboard-fixture")]
    if app.fixture {
        return Ok(Json(json!({"success":true})));
    }
    Ok(Json(app.application.verify_proxy(&proxy).await?))
}

async fn version(State(app): State<Arc<App>>) -> Json<releases::ReleaseInfo> {
    #[cfg(feature = "dashboard-fixture")]
    if app.fixture {
        return Json(releases::ReleaseInfo::default());
    }
    Json(app.releases.check(&app.shutdown).await)
}

async fn telegram(
    State(app): State<Arc<App>>,
) -> Json<twitch_drops_miner_core::notifications::View> {
    Json(app.telegram.view())
}
async fn save_telegram(
    State(app): State<Arc<App>>,
    request: Request,
) -> Result<Json<twitch_drops_miner_core::notifications::View>, ApiError> {
    let update = document(request).await?;
    Ok(Json(app.application.save_telegram(update).await?))
}
async fn telegram_bot(
    State(app): State<Arc<App>>,
) -> Json<twitch_drops_miner_core::notifications::BotView> {
    Json(app.telegram_bot().await)
}
async fn test_telegram(State(app): State<Arc<App>>) -> Result<Json<Value>, ApiError> {
    app.test_telegram().await?;
    Ok(Json(json!({"success":true})))
}
