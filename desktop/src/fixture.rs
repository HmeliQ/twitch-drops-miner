//! Offline native smoke test. This module is absent from production packages.
use std::{path::PathBuf, sync::Arc};
use tauri::Manager;
use twitch_drops_miner_core::{
    accounts::AccountManager,
    app::{AppError, Application, Command, CommandRequest},
    dto::{MiningState, Snapshot},
};

pub async fn start(directory: PathBuf) -> anyhow::Result<Arc<AccountManager>> {
    let (accounts, commands) = AccountManager::open(directory)?;
    let app = accounts.primary.clone();
    app.telegram.disable_for_fixture();
    let mut snapshot: Snapshot =
        serde_json::from_str(include_str!("../../frontend/tests/fixture.json"))?;
    snapshot.settings.refresh_game_keys();
    app.data.save_settings(&snapshot.settings.values)?;
    *app.settings.write().await = snapshot.settings.values.clone();
    *app.snapshot.write().await = snapshot;
    accounts.fixture_observe().await;
    accounts.fixture_profiles(vec![]).await?;
    worker(&accounts, app, commands);
    Ok(accounts)
}

pub async fn pending_workers(accounts: &Arc<AccountManager>) {
    for (app, commands) in accounts.fixture_pending_workers().await {
        worker(accounts, app, commands);
    }
}

fn worker(
    accounts: &Arc<AccountManager>,
    owned: Arc<Application>,
    mut commands: tokio::sync::mpsc::Receiver<CommandRequest>,
) {
    let shutdown = accounts.shutdown.clone();
    let worker = tokio::spawn(async move {
        loop {
            let request = tokio::select! {
                biased;
                _ = shutdown.cancelled() => break,
                _ = owned.shutdown.cancelled() => break,
                value = commands.recv() => { let Some(value) = value else { break; }; value },
            };
            if matches!(request.command, Command::SettingsChanged) {
                let mut snapshot = owned.snapshot.write().await;
                snapshot.mining.state = if snapshot.settings.values.mining_paused {
                    MiningState::Paused
                } else {
                    MiningState::Watching
                };
            }
            if matches!(request.command, Command::Logout) {
                twitch_drops_miner_core::twitch::oauth::Session::remove(&owned.data.path)
                    .expect("fixture session removal");
                owned.cancel_notifications();
                owned.snapshot.write().await.login = Default::default();
            }
            let _ = request.complete.send(Ok(()));
        }
    });
    accounts.fixture_worker(worker);
}

#[tauri::command]
pub async fn smoke_account_state(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    stop: Option<String>,
) -> Result<Option<String>, crate::ipc::Error> {
    crate::ipc::local(&window)?;
    let state = app.state::<crate::Desktop>();
    if let Some(id) = stop {
        let accounts = state.accounts().await?;
        accounts
            .account(&id)
            .await
            .map_err(AppError::from)?
            .shutdown
            .cancel();
        accounts.overview().await;
    }
    Ok(state.selected.read().unwrap().clone())
}

#[tauri::command]
pub fn smoke_tray_status(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
) -> Result<Option<(String, bool)>, crate::ipc::Error> {
    crate::ipc::local(&window)?;
    let Some(status) = app.try_state::<tauri::menu::MenuItem<tauri::Wry>>() else {
        return Ok(None);
    };
    Ok(Some((
        status.text().map_err(|_| AppError::Unavailable)?,
        status.is_enabled().map_err(|_| AppError::Unavailable)?,
    )))
}

#[tauri::command]
pub async fn smoke_result(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    error: Option<String>,
) -> Result<(), crate::ipc::Error> {
    crate::ipc::local(&window)?;
    let state = app.state::<crate::Desktop>();
    state.updates.cancel.cancel();
    state.updates.tasks.close();
    state.updates.tasks.wait().await;
    state.drain().await;
    if let Some(error) = error {
        eprintln!("Native smoke failed: {error}");
        app.exit(1);
    } else {
        println!(
            "Native smoke passed: snapshot, pause/resume, settings, inline updates and account recovery"
        );
        app.exit(0);
    }
    Ok(())
}
