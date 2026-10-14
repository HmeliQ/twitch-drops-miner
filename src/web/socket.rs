use std::{
    sync::{Arc, OnceLock},
    time::Duration,
};

use serde::Serialize;
use socketioxide::{SocketIo, extract::SocketRef};
use tokio::sync::Notify;
use tokio_util::{sync::CancellationToken, task::TaskTracker};

use crate::auth::{SESSION_SECONDS, WebAuth, token_from_headers, unix_now};

use super::{App, Command};

#[derive(Clone)]
struct SocketSession {
    account: Option<Arc<crate::app::Application>>,
    token: String,
    cancelled: CancellationToken,
    resync: Arc<Notify>,
    versioned: bool,
}

pub struct SocketHub {
    pub io: OnceLock<SocketIo>,
    auth: Arc<WebAuth>,
    tasks: TaskTracker,
}

impl SocketHub {
    pub fn new(auth: Arc<WebAuth>) -> Self {
        Self {
            io: OnceLock::new(),
            auth,
            tasks: TaskTracker::new(),
        }
    }

    pub fn attach(app: &Arc<App>, io: SocketIo) {
        let weak = Arc::downgrade(app);
        io.ns("/", async move |socket: SocketRef| {
            if let Some(app) = weak.upgrade() {
                app.sockets.connected(socket, &app).await;
            } else {
                let _ = socket.disconnect();
            }
        });
        assert!(
            app.sockets.io.set(io).is_ok(),
            "socket server already attached"
        );
    }

    async fn connected(&self, socket: SocketRef, app: &Arc<App>) {
        let account_id = url::form_urlencoded::parse(
            socket
                .req_parts()
                .uri
                .query()
                .unwrap_or_default()
                .as_bytes(),
        )
        .find_map(|(key, value)| (key == "account").then(|| value.into_owned()));
        if account_id.as_deref() == Some("overview") {
            self.connected_overview(socket, app).await;
            return;
        }
        let account = match match account_id {
            Some(id) => app.accounts.account(&id).await,
            None => app.accounts.sole_account().await,
        } {
            Ok(account) => account,
            Err(_) => {
                let _ = socket.disconnect();
                return;
            }
        };
        let protocol = url::form_urlencoded::parse(
            socket
                .req_parts()
                .uri
                .query()
                .unwrap_or_default()
                .as_bytes(),
        )
        .find_map(|(key, value)| (key == "protocol").then(|| value.into_owned()));
        if protocol.as_deref().is_some_and(|value| value != "2") {
            let _ = socket.emit("protocol_mismatch", &serde_json::json!({"protocol":2}));
            let _ = socket.disconnect();
            return;
        }
        let versioned = protocol.is_some();
        let mut changes = account.snapshot.subscribe();
        let mut notifications = account.notifications.subscribe();
        let initial = account.snapshot.read().await.clone();
        let token = token_from_headers(&socket.req_parts().headers);
        let state = self.auth.state.lock().await;
        let now = unix_now();
        if !state.allowed(&token, now) {
            let _ = socket.disconnect();
            return;
        }
        let cancelled = app.shutdown.child_token();
        let resync = Arc::new(Notify::new());
        socket.extensions.insert(SocketSession {
            account: Some(account.clone()),
            token: token.clone(),
            cancelled: cancelled.clone(),
            resync: resync.clone(),
            versioned,
        });
        socket.on_disconnect(async |socket: SocketRef| {
            if let Some(session) = socket.extensions.remove::<SocketSession>() {
                session.cancelled.cancel();
            }
        });
        if state.enabled() {
            let remaining = expiry_delay(state.expires_at(&token).unwrap_or(now), now);
            let expiring = socket.clone();
            self.tasks
                .spawn(expire_after(remaining, cancelled.clone(), move || {
                    let _ = expiring.disconnect();
                }));
        }
        // Hold the auth policy through emission so enabling protection cannot race
        // an anonymous initial snapshot. No state writer holds a lock while emitting.
        if socket
            .emit(
                if versioned {
                    "state_snapshot"
                } else {
                    "initial_state"
                },
                &initial,
            )
            .is_err()
        {
            let _ = socket.clone().disconnect();
        }
        drop(state);
        socket.on("state_resync", async |socket: SocketRef| {
            if let Some(session) = socket.extensions.get::<SocketSession>() {
                session.resync.notify_one();
            }
        });
        let weak = Arc::downgrade(app);
        let outgoing = socket.clone();
        self.tasks.spawn(async move {
            let mut previous = initial;
            loop {
                let force = tokio::select! {
                    biased;
                    _ = cancelled.cancelled() => break,
                    _ = account.shutdown.cancelled() => { let _ = outgoing.clone().disconnect(); break; },
                    _ = resync.notified() => true,
                    result = changes.changed() => { if result.is_err() { break; } false },
                    result = notifications.recv() => {
                        if matches!(result, Err(tokio::sync::broadcast::error::RecvError::Closed)) { break; }
                        if let Ok(value) = result {
                            let Some(app) = weak.upgrade() else { break };
                            let auth = app.auth.state.lock().await;
                            if !Self::allowed(&outgoing, &auth) || outgoing.emit("notification", &value).is_err() {
                                let _ = outgoing.clone().disconnect(); break;
                            }
                        }
                        continue;
                    }
                };
                let Some(app) = weak.upgrade() else { break };
                let next = account.snapshot.read().await.clone();
                if !force && next.revision <= previous.revision { continue; }
                let patch = crate::app::projection::StatePatch::between(&previous, &next);
                let auth = app.auth.state.lock().await;
                if !Self::allowed(&outgoing, &auth) { let _ = outgoing.clone().disconnect(); break; }
                let sent = if force {
                    outgoing.emit(if versioned { "state_snapshot" } else { "initial_state" }, &next).is_ok()
                } else if versioned {
                    outgoing.emit("state_patch", &patch).is_ok()
                } else {
                    legacy_patch(&outgoing, &previous, &next)
                };
                if !sent { let _ = outgoing.clone().disconnect(); break; }
                previous = next;
            }
        });
        for (event, command) in [
            ("request_reload", Command::Refresh { clear_cache: false }),
            ("request_login", Command::ConfirmOAuth),
        ] {
            let weak = Arc::downgrade(app);
            socket.on(event, async move |socket: SocketRef| {
                if let Some(app) = weak.upgrade()
                    && app.sockets.authorized(&socket).await
                {
                    let Some(account) = socket
                        .extensions
                        .get::<SocketSession>()
                        .and_then(|session| session.account.clone())
                    else {
                        return;
                    };
                    if matches!(command, Command::Refresh { clear_cache: false }) {
                        let _ = account.refresh_inventory().await;
                    } else {
                        let _ = account.command(command.clone()).await;
                    }
                }
            });
        }
        let weak = Arc::downgrade(app);
        socket.on("get_wanted_items", async move |socket: SocketRef| {
            if let Some(app) = weak.upgrade() {
                let Some(account) = socket
                    .extensions
                    .get::<SocketSession>()
                    .and_then(|session| session.account.clone())
                else {
                    return;
                };
                let wanted_items = account.snapshot.read().await.wanted_items.clone();
                let auth = app.auth.state.lock().await;
                if Self::allowed(&socket, &auth) {
                    let _ = socket.emit("wanted_items_update", &wanted_items);
                } else {
                    let _ = socket.disconnect();
                }
            }
        });
    }

    async fn connected_overview(&self, socket: SocketRef, app: &Arc<App>) {
        let mut changes = app.accounts.subscribe();
        let mut notifications = app.accounts.notifications.subscribe();
        let initial = app.accounts.overview().await;
        let token = token_from_headers(&socket.req_parts().headers);
        let auth = self.auth.state.lock().await;
        let now = unix_now();
        if !auth.allowed(&token, now) {
            let _ = socket.disconnect();
            return;
        }
        let cancelled = app.shutdown.child_token();
        let resync = Arc::new(Notify::new());
        socket.extensions.insert(SocketSession {
            account: None,
            token: token.clone(),
            cancelled: cancelled.clone(),
            resync: resync.clone(),
            versioned: true,
        });
        socket.on_disconnect(async |socket: SocketRef| {
            if let Some(session) = socket.extensions.remove::<SocketSession>() {
                session.cancelled.cancel();
            }
        });
        socket.on("state_resync", async |socket: SocketRef| {
            if let Some(session) = socket.extensions.get::<SocketSession>() {
                session.resync.notify_one();
            }
        });
        if auth.enabled() {
            let remaining = expiry_delay(auth.expires_at(&token).unwrap_or(now), now);
            let expiring = socket.clone();
            self.tasks
                .spawn(expire_after(remaining, cancelled.clone(), move || {
                    let _ = expiring.disconnect();
                }));
        }
        if socket.emit("accounts", &initial).is_err() {
            let _ = socket.clone().disconnect();
        }
        drop(auth);
        let weak = Arc::downgrade(app);
        self.tasks.spawn(async move {
            loop {
                let event = tokio::select! { biased;
                    _ = cancelled.cancelled() => break,
                    _ = resync.notified() => None,
                    result = changes.changed() => { if result.is_err() { break; } None },
                    result = notifications.recv() => match result { Ok(value) => Some(value), Err(_) => continue },
                };
                let Some(app) = weak.upgrade() else { break; };
                let overview = if event.is_none() { Some(app.accounts.overview().await) } else { None };
                let auth = app.auth.state.lock().await;
                if !Self::allowed(&socket, &auth) { let _ = socket.clone().disconnect(); break; }
                let sent = match (event, overview) {
                    (Some(event), _) => socket.emit("notification", &event),
                    (_, Some(overview)) => socket.emit("accounts", &overview),
                    _ => continue,
                };
                if sent.is_err() { let _ = socket.clone().disconnect(); break; }
            }
        });
    }

    fn allowed(socket: &SocketRef, state: &crate::auth::AuthState) -> bool {
        socket
            .extensions
            .get::<SocketSession>()
            .is_some_and(|session| state.allowed(&session.token, unix_now()))
    }

    async fn authorized(&self, socket: &SocketRef) -> bool {
        let state = self.auth.state.lock().await;
        if Self::allowed(socket, &state) {
            true
        } else {
            let _ = socket.clone().disconnect();
            false
        }
    }

    pub async fn emit<T: Serialize + Sync>(&self, event: &str, data: &T) {
        let state = self.auth.state.lock().await;
        if let Some(io) = self.io.get() {
            for socket in io.sockets() {
                if Self::allowed(&socket, &state) {
                    if socket
                        .extensions
                        .get::<SocketSession>()
                        .is_some_and(|session| !session.versioned)
                        && socket.emit(event, data).is_err()
                    {
                        let _ = socket.disconnect();
                    }
                } else {
                    let _ = socket.disconnect();
                }
            }
        }
    }

    pub async fn prune(&self, all: bool) {
        let state = self.auth.state.lock().await;
        if let Some(io) = self.io.get() {
            for socket in io.sockets() {
                if all || !Self::allowed(&socket, &state) {
                    let _ = socket.disconnect();
                }
            }
        }
    }

    pub async fn close(&self) {
        self.prune(true).await;
        self.tasks.close();
        self.tasks.wait().await;
        if let Some(io) = self.io.get() {
            io.close().await;
        }
    }
}

fn legacy_patch(
    socket: &SocketRef,
    previous: &crate::dto::Snapshot,
    next: &crate::dto::Snapshot,
) -> bool {
    use serde_json::json;
    macro_rules! emit {
        ($event:expr, $value:expr) => {
            if socket.emit($event, &$value).is_err() {
                return false;
            }
        };
    }
    if previous.channels != next.channels {
        emit!("channels_batch_update", json!({"channels": next.channels}));
    }
    if previous.campaigns != next.campaigns {
        emit!(
            "inventory_batch_update",
            json!({"campaigns": next.campaigns})
        );
    }
    if previous.settings != next.settings {
        emit!("settings_updated", next.settings);
    }
    if previous.login != next.login {
        emit!("login_status", next.login);
    }
    if previous.status != next.status {
        emit!("status_update", json!({"status":next.status}));
    }
    if previous.manual_mode != next.manual_mode {
        emit!("manual_mode_update", next.manual_mode);
    }
    if previous.wanted_items != next.wanted_items {
        emit!("wanted_items_update", next.wanted_items);
    }
    if previous.inventory_status != next.inventory_status {
        emit!("inventory_status", next.inventory_status);
    }
    if previous.inventory_refresh != next.inventory_refresh {
        emit!("inventory_refresh", next.inventory_refresh);
    }
    if previous.history_clear_revision != next.history_clear_revision {
        emit!("history_cleared", json!({}));
    }
    if previous.current_drop != next.current_drop {
        if let Some(progress) = &next.current_drop {
            emit!("drop_progress", progress);
        } else {
            emit!("drop_progress_stop", json!({}));
        }
    }
    if previous.console != next.console {
        for line in next
            .console
            .iter()
            .filter(|line| !previous.console.contains(line))
        {
            emit!("console_output", json!({"message":line}));
        }
    }
    true
}

fn expiry_delay(expires_at: f64, now: f64) -> Duration {
    // A backward wall-clock adjustment must not create an unbounded live socket.
    Duration::from_secs_f64((expires_at - now).clamp(0.0, f64::from(SESSION_SECONDS)))
}

async fn expire_after(
    remaining: Duration,
    cancelled: CancellationToken,
    disconnect: impl FnOnce(),
) {
    tokio::select! {
        biased;
        _ = cancelled.cancelled()=>{},
        _ = tokio::time::sleep(remaining)=>disconnect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};

    #[tokio::test(start_paused = true)]
    async fn idle_expiry_uses_remaining_lifetime_and_cleans_cancelled_timers() {
        let remaining = expiry_delay(10_000.0, 6_400.0);
        assert_eq!(remaining, Duration::from_secs(3600));
        let tracker = TaskTracker::new();
        let closed = Arc::new(AtomicBool::new(false));
        let flag = closed.clone();
        let task = tracker.spawn(expire_after(
            remaining,
            CancellationToken::new(),
            move || {
                flag.store(true, Ordering::SeqCst);
            },
        ));
        tokio::task::yield_now().await;
        tokio::time::advance(Duration::from_secs(3599)).await;
        assert!(!closed.load(Ordering::SeqCst));
        tokio::time::advance(Duration::from_secs(1)).await;
        task.await.unwrap();
        assert!(closed.load(Ordering::SeqCst));
        assert!(tracker.is_empty());
        let cancellation = CancellationToken::new();
        let task = tracker.spawn(expire_after(remaining, cancellation.clone(), || {
            panic!("cancelled session must not disconnect again")
        }));
        tokio::task::yield_now().await;
        cancellation.cancel();
        task.await.unwrap();
        assert!(tracker.is_empty());
        assert_eq!(expiry_delay(99.0, 100.0), Duration::ZERO);
        assert_eq!(
            expiry_delay(f64::MAX, 100.0),
            Duration::from_secs(u64::from(SESSION_SECONDS))
        );
    }
}
