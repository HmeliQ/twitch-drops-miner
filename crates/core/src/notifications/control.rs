use super::{Config, Error, MessageKind, html, response_json};
use crate::{
    app::{
        AppError, Application,
        activity::{ActivityEvent, Category, Severity},
        message,
    },
    dto::{MiningState, Snapshot},
};
use chrono::Utc;
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};
use tokio_util::sync::CancellationToken;

struct Session {
    config: Config,
    epoch: u64,
    cancel: CancellationToken,
    started: i64,
}

#[derive(Debug, PartialEq, Eq)]
enum Failure {
    Cancelled,
    Unavailable,
    Oversized,
    Conflict,
    RateLimited(u64),
}

#[derive(Debug, PartialEq, Eq)]
enum Command {
    Accounts,
    Help,
    Status,
    Pause,
    Resume,
    Mine(String),
}

#[derive(Default)]
struct Cursor {
    offset: Option<i64>,
    last_date: i64,
}

struct Picker {
    nonce: String,
    created: i64,
    accounts: Vec<String>,
}

enum Selection {
    Account(String),
    Page(usize),
}

impl Picker {
    fn callback(
        &self,
        update: &Value,
        owner: i64,
        token: &str,
        now: i64,
    ) -> Option<(String, Selection)> {
        let callback = update.get("callback_query")?;
        let message = &callback["message"];
        let id = callback["id"].as_str()?;
        let data = callback["data"].as_str()?;
        let bot_id = token.split_once(':')?.0.parse::<u64>().ok()?;
        if owner <= 0
            || now < self.created
            || now - self.created > 120
            || id.is_empty()
            || id.len() > 128
            || id.chars().any(char::is_control)
            || data.len() > 64
            || callback["from"]["id"].as_i64() != Some(owner)
            || callback["from"]["is_bot"] != false
            || message["chat"]["id"].as_i64() != Some(owner)
            || message["chat"]["type"] != "private"
            || message["from"]["id"].as_u64() != Some(bot_id)
            || message["from"]["is_bot"] != true
            || [
                "forward_origin",
                "forward_date",
                "forward_from",
                "sender_chat",
                "via_bot",
                "edit_date",
                "business_connection_id",
            ]
            .iter()
            .any(|key| message.get(key).is_some())
            || callback.get("inline_message_id").is_some()
        {
            return None;
        }
        let (nonce, action) = data.split_once(':')?;
        if nonce != self.nonce {
            return None;
        }
        let (kind, value) = action.split_once(':')?;
        let selection = match kind {
            "a" if self.accounts.iter().any(|id| id == value) => Selection::Account(value.into()),
            "p" => {
                let page = value.parse::<usize>().ok()?;
                if page >= self.accounts.len().div_ceil(5) {
                    return None;
                }
                Selection::Page(page)
            }
            _ => return None,
        };
        Some((id.into(), selection))
    }
}

impl Cursor {
    fn advance(&mut self, update: &Value, now: i64) -> bool {
        let id = update["update_id"].as_i64().unwrap();
        let date = update["message"]["date"]
            .as_i64()
            .filter(|date| *date <= now + 5);
        // Telegram chooses a new random ID after a week without updates.
        let idle_reset = date.is_some_and(|date| date.saturating_sub(self.last_date) >= 7 * 86400);
        if self.offset.is_some_and(|offset| id < offset) && !idle_reset {
            return false;
        }
        self.offset = Some(id + 1);
        self.last_date = self.last_date.max(date.unwrap_or(now));
        true
    }
}

fn text(key: &str, args: &[(&str, &str)]) -> String {
    message(&format!("telegram.{key}"), args)
}

fn command(update: &Value, owner: i64, started: i64, now: i64) -> Option<Command> {
    let m = update.get("message")?;
    let date = m["date"].as_i64()?;
    if owner <= 0
        || m["chat"]["id"].as_i64() != Some(owner)
        || m["chat"]["type"] != "private"
        || m["from"]["id"].as_i64() != Some(owner)
        || m["from"]["is_bot"] != false
        || date < started
        || date > now + 5
        || date < now - 120
        || [
            "forward_origin",
            "forward_date",
            "forward_from",
            "sender_chat",
            "via_bot",
            "edit_date",
            "business_connection_id",
        ]
        .iter()
        .any(|key| m.get(key).is_some())
    {
        return None;
    }
    let input = m["text"].as_str()?;
    if input.len() > 256 || input.chars().any(char::is_control) {
        return None;
    }
    let (name, argument) = input.trim().split_once(' ').unwrap_or((input.trim(), ""));
    let argument = argument.trim();
    match (name, argument.is_empty()) {
        ("/start" | "/help", true) => Some(Command::Help),
        ("/status", true) => Some(Command::Status),
        ("/accounts", true) => Some(Command::Accounts),
        ("/pause", true) => Some(Command::Pause),
        ("/resume", true) => Some(Command::Resume),
        ("/mine", false) if argument.len() <= 100 => Some(Command::Mine(argument.into())),
        _ if name.starts_with('/') => Some(Command::Help),
        _ => None,
    }
}

fn status(snapshot: &Snapshot) -> String {
    let state = if snapshot.login.user_id.is_none() {
        "account_required"
    } else if snapshot.settings.values.mining_paused {
        "paused"
    } else {
        match snapshot.mining.state {
            MiningState::Watching => "watching",
            MiningState::Paused => "paused",
            MiningState::AccountRequired => "account_required",
            MiningState::NoSelection => "no_selection",
            MiningState::Discovering => "discovering",
            MiningState::AwaitingClaim => "awaiting_claim",
            MiningState::AwaitingProgress => "awaiting_progress",
            MiningState::WaitingChannel => "waiting_channel",
            MiningState::NoRewards => "no_rewards",
            MiningState::ManualOffline => "manual_offline",
            MiningState::ManualWatching => "manual_watching",
            MiningState::Unknown => "unknown",
        }
    };
    let label = if state == "watching" {
        text("watching", &[])
    } else {
        message(&format!("gui.redesign.mining_state_{state}"), &[])
    };
    let mut lines = vec![html(&label)];
    if snapshot.login.user_id.is_some() {
        if let Some(channel) = snapshot.channels.iter().find(|c| c.watching) {
            lines.push(text("channel", &[("channel", &html(&channel.name))]));
        }
        if let Some(drop) = &snapshot.current_drop {
            lines.push(format!(
                "<b>{}</b> — {}",
                html(&drop.game_name),
                html(&drop.drop_name)
            ));
            lines.push(if drop.confirmed_at.is_some() {
                text(
                    "progress",
                    &[
                        ("current", &drop.confirmed_minutes.to_string()),
                        ("required", &drop.required_minutes.to_string()),
                    ],
                )
            } else {
                text("progress_unknown", &[])
            });
        }
        if snapshot.manual_mode.active || snapshot.manual_mode.pending_channel.is_some() {
            lines.push(text("manual", &[]));
        }
    }
    lines.join("\n")
}

impl Session {
    async fn picker(
        &self,
        app: &Application,
        page: usize,
        picker: &mut Option<Picker>,
    ) -> Result<Option<Value>, AppError> {
        let Some(accounts) = app.accounts() else {
            return Ok(None);
        };
        let overview = accounts.overview().await;
        if overview.accounts.is_empty() {
            *picker = None;
            return Ok(None);
        }
        let pages = overview.accounts.len().div_ceil(5);
        let page = page.min(pages - 1);
        let nonce = crate::random_hex::<8>().map_err(|_| AppError::Unavailable)?;
        let mut rows: Vec<Value> = overview
            .accounts
            .iter()
            .skip(page * 5)
            .take(5)
            .map(|account| {
                let label: String = account.name.chars().take(40).collect();
                json!([{"text":label,"callback_data":format!("{nonce}:a:{}", account.id)}])
            })
            .collect();
        let mut navigation = vec![];
        if page > 0 {
            navigation.push(json!({"text":text("previous", &[]),"callback_data":format!("{nonce}:p:{}", page - 1)}));
        }
        if page + 1 < pages {
            navigation.push(
                json!({"text":text("next", &[]),"callback_data":format!("{nonce}:p:{}", page + 1)}),
            );
        }
        if !navigation.is_empty() {
            rows.push(json!(navigation));
        }
        *picker = Some(Picker {
            nonce,
            created: Utc::now().timestamp(),
            accounts: overview.accounts.into_iter().map(|a| a.id).collect(),
        });
        Ok(Some(json!({"inline_keyboard":rows})))
    }

    async fn api(&self, app: &Application, method: &str, body: Value) -> Result<Value, Failure> {
        let shutdown = app.process_cancel();
        let operation = async {
            let proxy = app.connection_proxy().await;
            let client = app
                .telegram
                .client(&proxy)
                .map_err(|_| Failure::Unavailable)?;
            let response = client
                .post(format!(
                    "{}/bot{}/{method}",
                    app.telegram.endpoint, self.config.token
                ))
                .timeout(Duration::from_secs(if method == "getUpdates" {
                    30
                } else {
                    10
                }))
                .json(&body)
                .send()
                .await
                .map_err(|_| Failure::Unavailable)?;
            let status = response.status().as_u16();
            if status == 409 {
                return Err(Failure::Conflict);
            }
            let value = response_json(response).await.map_err(|error| match error {
                Error::Oversized if status == 200 => Failure::Oversized,
                _ => Failure::Unavailable,
            })?;
            if status == 429 {
                return Err(Failure::RateLimited(
                    value["parameters"]["retry_after"]
                        .as_u64()
                        .unwrap_or(60)
                        .clamp(1, 60),
                ));
            }
            if status != 200 || value["ok"] != true {
                return Err(Failure::Unavailable);
            }
            value.get("result").cloned().ok_or(Failure::Unavailable)
        };
        tokio::select! { biased;
            _ = shutdown.cancelled() => Err(Failure::Cancelled),
            _ = self.cancel.cancelled() => Err(Failure::Cancelled),
            result = operation => result,
        }
    }

    async fn execute(&self, app: &Arc<Application>, command: Command) -> Result<String, AppError> {
        if matches!(command, Command::Help | Command::Accounts) {
            return Ok(text("help", &[]));
        }
        let (app, name) = if let Some(accounts) = app.accounts() {
            let Ok(selected) = accounts.telegram_account().await else {
                return Ok(text("choose_account", &[]));
            };
            let overview = accounts.overview().await;
            let name = (overview.accounts.len() > 1)
                .then(|| {
                    overview
                        .accounts
                        .iter()
                        .find(|a| a.id == selected.account_id)
                        .map(|a| a.name.clone())
                })
                .flatten();
            (selected, name)
        } else {
            (app.clone(), None)
        };
        let operation = async {
            // Serialize acceptance with configuration saves; accepted settings writes remain owned.
            let _permit = app
                .telegram
                .writes
                .acquire()
                .await
                .map_err(|_| Error::Cancelled)?;
            if self.cancel.is_cancelled() || app.telegram.epoch() != self.epoch {
                return Err(Error::Cancelled.into());
            }
            let snapshot = app.snapshot.read().await;
            match command {
                Command::Help => return Ok(text("help", &[])),
                Command::Status => return Ok(status(&snapshot)),
                _ => {}
            }
            if snapshot.login.user_id.is_none() {
                return Ok(text("login_required", &[]));
            }
            let mut patch = json!({"revision":snapshot.settings.revision});
            let reply = match command {
                Command::Pause | Command::Resume => {
                    patch["mining_paused"] = json!(command == Command::Pause);
                    text(
                        if command == Command::Pause {
                            "paused"
                        } else {
                            "resumed"
                        },
                        &[],
                    )
                }
                Command::Mine(name) => {
                    let key = crate::config::fold(&name);
                    let Some(game) = snapshot
                        .settings
                        .values
                        .games_to_watch
                        .iter()
                        .chain(
                            snapshot
                                .campaigns
                                .iter()
                                .filter(|c| !c.expired && !c.finished)
                                .map(|c| &c.game_name),
                        )
                        .find(|game| crate::config::fold(game) == key)
                    else {
                        return Ok(text("unknown_game", &[]));
                    };
                    let mut games = snapshot.settings.values.games_to_watch.clone();
                    if !games.iter().any(|g| crate::config::fold(g) == key) {
                        games.push(game.clone());
                    }
                    patch["games_to_watch"] = json!(games);
                    text("selected", &[("game", &html(game))])
                }
                _ => unreachable!(),
            };
            drop(snapshot);
            app.update_settings(patch).await?;
            Ok(reply)
        };
        let result = tokio::select! { biased;
            _ = app.shutdown.cancelled() => Err(Error::Cancelled.into()),
            _ = self.cancel.cancelled() => Err(Error::Cancelled.into()),
            result = tokio::time::timeout(Duration::from_secs(15), operation) => result.unwrap_or(Err(AppError::Unavailable)),
        };
        result.map(|reply| {
            name.map_or_else(|| reply.clone(), |name| format!("{}\n{reply}", html(&name)))
        })
    }

    async fn poll(&self, app: &Arc<Application>) {
        let shutdown = app.process_cancel();
        let mut picker = None;
        let mut cursor = Cursor::default();
        let mut tail = false;
        loop {
            let bootstrap = cursor.offset.is_none();
            let result = self
                .api(
                    app,
                    "getUpdates",
                    json!({
                        "offset":if tail { -1 } else { cursor.offset.unwrap_or(-1) }, "limit":1,
                        "timeout":if bootstrap { 0 } else { 25 }, "allowed_updates":["message", "callback_query"]
                    }),
                )
                .await;
            let updates = result.and_then(|value| {
                let updates = value
                    .as_array()
                    .filter(|v| v.len() <= 1)
                    .ok_or(Failure::Unavailable)?;
                if updates.iter().any(|v| {
                    !v["update_id"]
                        .as_i64()
                        .is_some_and(|id| (0..i64::MAX).contains(&id))
                }) {
                    return Err(Failure::Unavailable);
                }
                Ok(updates.clone())
            });
            match updates {
                Err(Failure::Cancelled) => return,
                Err(failure) => {
                    // Skip the blocked queue when a later update arrives; never parse/execute a partial body.
                    tail |= failure == Failure::Oversized;
                    let conflict = failure == Failure::Conflict;
                    app.record_activity(event(conflict)).await;
                    let seconds = match failure {
                        Failure::RateLimited(delay) => delay,
                        Failure::Conflict => 60,
                        _ => 10,
                    };
                    if !self.wait(app, Duration::from_secs(seconds)).await {
                        return;
                    }
                    continue;
                }
                Ok(updates) => {
                    tail = false;
                    app.recover_activity(&event(false)).await;
                    app.recover_activity(&event(true)).await;
                    for update in updates {
                        if !cursor.advance(&update, Utc::now().timestamp()) {
                            continue;
                        }
                        // Advance before execution/reply; failed replies must never repeat a command.
                        if bootstrap {
                            continue;
                        }
                        let owner = self.config.chat_id.parse().unwrap_or(0);
                        let now = Utc::now().timestamp();
                        let (command, markup) = if update.get("callback_query").is_some() {
                            let Some((callback_id, selection)) =
                                picker.as_ref().and_then(|picker: &Picker| {
                                    picker.callback(&update, owner, &self.config.token, now)
                                })
                            else {
                                continue;
                            };
                            let Some(accounts) = app.accounts() else {
                                continue;
                            };
                            let result = match selection {
                                Selection::Account(id) => {
                                    let result = async {
                                        let _permit =
                                            app.telegram.writes.acquire().await.map_err(|_| {
                                                AppError::Telegram(Error::Cancelled)
                                            })?;
                                        if self.cancel.is_cancelled()
                                            || app.telegram.epoch() != self.epoch
                                        {
                                            return Err(Error::Cancelled.into());
                                        }
                                        accounts
                                            .request(crate::accounts::Request::TelegramAccount {
                                                id,
                                            })
                                            .await
                                    }
                                    .await;
                                    picker = None;
                                    result.map(|_| (Command::Status, None))
                                }
                                Selection::Page(page) => self
                                    .picker(app, page, &mut picker)
                                    .await
                                    .map(|markup| (Command::Accounts, markup)),
                            };
                            let _ = self
                                .api(
                                    app,
                                    "answerCallbackQuery",
                                    json!({"callback_query_id":callback_id}),
                                )
                                .await;
                            match result {
                                Ok(result) => result,
                                Err(_) => continue,
                            }
                        } else {
                            let Some(command) = command(&update, owner, self.started, now) else {
                                continue;
                            };
                            let markup = if command == Command::Accounts {
                                self.picker(app, 0, &mut picker).await.ok().flatten()
                            } else {
                                None
                            };
                            (command, markup)
                        };
                        let reply = match if command == Command::Accounts {
                            Ok(text("choose_account", &[]))
                        } else {
                            self.execute(app, command).await
                        } {
                            Ok(reply) => reply,
                            Err(AppError::Telegram(Error::Cancelled))
                                if self.cancel.is_cancelled() || shutdown.is_cancelled() =>
                            {
                                return;
                            }
                            Err(AppError::SettingsConflict) => text("conflict", &[]),
                            Err(_) => text("failed", &[]),
                        };
                        let proxy = app.connection_proxy().await;
                        let sent = app
                            .telegram
                            .send(
                                self.epoch,
                                &reply,
                                &proxy,
                                &shutdown,
                                markup
                                    .as_ref()
                                    .map_or(MessageKind::Reply, MessageKind::Keyboard),
                                None,
                            )
                            .await;
                        super::report(app, sent).await;
                    }
                    if bootstrap {
                        cursor.offset.get_or_insert(0);
                        let commands: Vec<_> = ["accounts", "status", "pause", "resume", "mine", "help"].into_iter()
                            .map(|command| json!({"command":command, "description":text(&format!("menu_{command}"), &[])})).collect();
                        // A missing menu does not disable typed commands, or replace another chat's menu.
                        let _ = self.api(app, "setMyCommands", json!({"scope":{"type":"chat", "chat_id":self.config.chat_id}, "commands":commands})).await;
                    }
                }
            }
            if !self.wait(app, Duration::from_secs(1)).await {
                return;
            }
        }
    }

    async fn wait(&self, app: &Application, duration: Duration) -> bool {
        let shutdown = app.process_cancel();
        tokio::select! { biased;
            _ = shutdown.cancelled() => false,
            _ = self.cancel.cancelled() => false,
            _ = tokio::time::sleep(duration) => true,
        }
    }
}

fn event(conflict: bool) -> ActivityEvent {
    ActivityEvent::new(
        if conflict {
            "gui.backend.telegram_controls_conflict"
        } else {
            "gui.backend.telegram_controls_failed"
        },
        Category::Connection,
        Severity::Warning,
        &[("operation", "telegram_controls")],
    )
}

pub(super) async fn run(app: Arc<Application>) {
    let shutdown = app.process_cancel();
    loop {
        if shutdown.is_cancelled() || app.telegram.delivery.is_closed() {
            return;
        }
        let (session, enabled) = {
            let state = app.telegram.state.lock().unwrap();
            (
                Session {
                    config: state.config.clone(),
                    epoch: state.epoch,
                    cancel: state.cancel.clone(),
                    started: Utc::now().timestamp(),
                },
                state.config.remote_control && !state.unreadable,
            )
        };
        if enabled {
            session.poll(&app).await;
        } else {
            tokio::select! {
                _ = shutdown.cancelled() => return,
                _ = session.cancel.cancelled() => {},
            }
        }
    }
}

#[cfg(test)]
#[path = "control_tests.rs"]
mod tests;
