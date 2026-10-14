use super::*;
use crate::{
    app::{AppError, Command},
    store::atomic_json,
    twitch::oauth::Session,
};
use serde_json::json;
use tokio::time::{Duration, Instant};

fn session(user: u64) -> Session {
    let mut session = crate::twitch::tests::session();
    session.user_id = user;
    session
}

async fn manager() -> (tempfile::TempDir, Arc<AccountManager>) {
    let directory = tempfile::tempdir().unwrap();
    session(42).save(directory.path()).unwrap();
    let (manager, commands) = AccountManager::open(directory.path().into()).unwrap();
    mock_worker(&manager, manager.primary.clone(), commands);
    (directory, manager)
}

fn mock_worker(
    manager: &Arc<AccountManager>,
    app: Arc<Application>,
    mut commands: mpsc::Receiver<CommandRequest>,
) {
    let cancel = manager.shutdown.clone();
    manager.tasks.spawn(async move {
        loop {
            let request = tokio::select! { biased;
                _ = cancel.cancelled() => break,
                _ = app.shutdown.cancelled() => break,
                request = commands.recv() => match request { Some(request) => request, None => break },
            };
            if matches!(request.command, Command::Logout) {
                Session::remove(&app.data.path).unwrap();
                app.cancel_notifications();
                app.snapshot.write().await.login = Default::default();
            }
            let _ = request.complete.send(Ok(()));
        }
    });
}

async fn verified(manager: &AccountManager, user: u64, target: Option<&str>) -> String {
    let id = random_hex::<16>().unwrap();
    *manager.login.lock().await = Some(login::Attempt {
        view: LoginView {
            id: id.clone(),
            target: target.map(str::to_owned),
            code: None,
            user_id: Some(user),
            name: Some(format!("user{user}")),
            avatar_url: None,
            error: None,
        },
        cancel: manager.shutdown.child_token(),
        confirmed: Arc::new(tokio::sync::Notify::new()),
        expires: Instant::now() + Duration::from_secs(600),
        session: Some(session(user)),
        profile: None,
    });
    id
}

async fn add(manager: &Arc<AccountManager>, user: u64) -> String {
    let attempt = verified(manager, user, None).await;
    let result = manager
        .request(Request::FinishLogin {
            attempt,
            label: format!("Account {user}"),
            copy_from: None,
            copy_auto_claim: false,
        })
        .await
        .unwrap();
    let id = result["id"].as_str().unwrap().to_owned();
    let mut entries = manager.entries.write().await;
    let entry = entries.get_mut(&id).unwrap();
    if let Some(commands) = entry.commands.take() {
        mock_worker(manager, entry.app.clone(), commands);
    }
    id
}

async fn target(manager: &AccountManager, id: &str) -> Target {
    Target {
        id: id.into(),
        revision: manager
            .account(id)
            .await
            .unwrap()
            .snapshot
            .read()
            .await
            .settings
            .revision
            .clone(),
    }
}

#[tokio::test]
async fn original_files_stay_in_place_and_profiles_have_independent_storage_and_identity() {
    let (directory, manager) = manager().await;
    assert_eq!(manager.primary.data.path, directory.path());
    let original = std::fs::read(directory.path().join("twitch_session.json")).unwrap();
    let id = add(&manager, 73).await;
    let second = manager.account(&id).await.unwrap();
    assert_eq!(
        second.data.path,
        directory.path().join("accounts").join(&id)
    );
    assert_eq!(
        std::fs::read(directory.path().join("twitch_session.json")).unwrap(),
        original
    );
    assert!(manager.identity_matches(PRIMARY, 42).await);
    assert!(!manager.identity_matches(PRIMARY, 73).await);
    assert!(manager.identity_matches(&id, 73).await);
    assert!(matches!(manager.sole_account().await, Err(Error::Required)));
    assert!(manager.account("../primary").await.is_err());
    assert!(Arc::ptr_eq(&manager.primary.telegram, &second.telegram));
    second
        .update_settings(json!({"games_to_watch":["Rust"],"mining_paused":true}))
        .await
        .unwrap();
    assert!(
        manager
            .primary
            .settings
            .read()
            .await
            .games_to_watch
            .is_empty()
    );
    assert!(!manager.primary.settings.read().await.mining_paused);
    manager.shutdown().await;
}

#[tokio::test]
async fn duplicate_login_does_not_replace_credentials_and_reauthentication_cannot_change_identity()
{
    let (directory, manager) = manager().await;
    let original = std::fs::read(directory.path().join("twitch_session.json")).unwrap();
    let duplicate = add(&manager, 42).await;
    assert_eq!(duplicate, PRIMARY);
    assert_eq!(manager.overview().await.accounts.len(), 1);
    assert_eq!(
        std::fs::read(directory.path().join("twitch_session.json")).unwrap(),
        original
    );
    let attempt = verified(&manager, 99, Some(PRIMARY)).await;
    assert!(matches!(
        manager
            .request(Request::FinishLogin {
                attempt,
                label: String::new(),
                copy_from: None,
                copy_auto_claim: false
            })
            .await,
        Err(AppError::Account(Error::Identity))
    ));
    assert_eq!(
        std::fs::read(directory.path().join("twitch_session.json")).unwrap(),
        original
    );
    manager.shutdown().await;
}

#[tokio::test]
async fn bulk_actions_report_stale_accounts_without_replacing_newer_preferences() {
    let (_directory, manager) = manager().await;
    let id = add(&manager, 73).await;
    let targets = vec![target(&manager, PRIMARY).await, target(&manager, &id).await];
    let second = manager.account(&id).await.unwrap();
    second
        .update_settings(json!({"games_to_watch":["Rust"]}))
        .await
        .unwrap();
    let result = manager
        .request(Request::Pause {
            targets,
            paused: true,
        })
        .await
        .unwrap();
    assert_eq!(result["results"][0]["ok"], true);
    assert_eq!(result["results"][1]["error"], "settings_conflict");
    assert!(manager.primary.settings.read().await.mining_paused);
    assert!(!second.settings.read().await.mining_paused);
    assert_eq!(second.settings.read().await.games_to_watch, ["Rust"]);
    manager.shutdown().await;
}

#[tokio::test]
async fn copying_preferences_preserves_target_pause_display_connection_and_claim_setting() {
    let (_directory, manager) = manager().await;
    let id = add(&manager, 73).await;
    manager
        .primary
        .update_settings(
            json!({"games_to_watch":["Rust"],"auto_claim_drops":false,"inventory_list_view":true}),
        )
        .await
        .unwrap();
    let second = manager.account(&id).await.unwrap();
    second
        .update_settings(json!({"mining_paused":true}))
        .await
        .unwrap();
    let result = manager
        .request(Request::CopyPreferences {
            source: target(&manager, PRIMARY).await,
            targets: vec![target(&manager, &id).await],
            auto_claim: false,
        })
        .await
        .unwrap();
    assert_eq!(result["results"][0]["ok"], true);
    let settings = second.settings.read().await.clone();
    assert_eq!(settings.games_to_watch, ["Rust"]);
    assert!(settings.mining_paused && settings.auto_claim_drops);
    assert!(!settings.inventory_list_view);
    manager.shutdown().await;
}

#[tokio::test]
async fn connection_is_global_revision_checked_and_injected_on_restart() {
    let (directory, manager) = manager().await;
    let id = add(&manager, 73).await;
    let second = manager.account(&id).await.unwrap();
    assert!(
        second
            .update_settings(json!({"connection_quality":6}))
            .await
            .is_err()
    );
    let revision = manager.connection().await["revision"]
        .as_str()
        .unwrap()
        .to_owned();
    let values = Connection {
        proxy: String::new(),
        connection_quality: 6,
        minimum_refresh_interval_minutes: 45,
    };
    manager
        .request(Request::Connection {
            revision: revision.clone(),
            values: values.clone(),
        })
        .await
        .unwrap();
    assert_eq!(manager.primary.settings.read().await.connection_quality, 6);
    assert_eq!(second.settings.read().await.connection_quality, 6);
    assert!(
        manager
            .request(Request::Connection { revision, values })
            .await
            .is_err()
    );
    drop(second);
    manager.shutdown().await;
    drop(manager);
    let (reopened, _) = AccountManager::open(directory.path().into()).unwrap();
    assert_eq!(
        reopened
            .account(&id)
            .await
            .unwrap()
            .settings
            .read()
            .await
            .minimum_refresh_interval_minutes,
        45
    );
    reopened.shutdown().await;
}

#[tokio::test]
async fn remove_preserves_data_and_readding_restores_the_same_identity() {
    let (_directory, manager) = manager().await;
    let id = add(&manager, 73).await;
    let second = manager.account(&id).await.unwrap();
    second
        .update_settings(json!({"games_to_watch":["Rust"]}))
        .await
        .unwrap();
    let path = second.data.path.clone();
    manager
        .request(Request::TelegramAccount { id: id.clone() })
        .await
        .unwrap();
    manager
        .request(Request::Remove { id: id.clone() })
        .await
        .unwrap();
    assert!(!path.join("twitch_session.json").exists());
    assert!(path.join("settings.json").exists());
    assert!(manager.account(&id).await.is_err());
    let restored = add(&manager, 73).await;
    assert_eq!(restored, id);
    assert_eq!(
        manager
            .account(&id)
            .await
            .unwrap()
            .settings
            .read()
            .await
            .games_to_watch,
        ["Rust"]
    );
    assert!(second.shutdown.is_cancelled());
    manager.shutdown().await;
}

#[tokio::test]
async fn old_unassigned_data_requires_explicit_association_and_is_not_used_for_a_new_account() {
    let directory = tempfile::tempdir().unwrap();
    atomic_json(
        &directory.path().join("completed_campaigns.json"),
        &json!({"version":1,"campaigns":[]}),
    )
    .unwrap();
    let (manager, commands) = AccountManager::open(directory.path().into()).unwrap();
    mock_worker(&manager, manager.primary.clone(), commands);
    assert!(manager.overview().await.accounts[0].unassigned);
    assert!(matches!(
        manager.start_login(Some(PRIMARY.into()), false).await,
        Err(Error::Identity)
    ));
    let id = add(&manager, 73).await;
    assert_ne!(id, PRIMARY);
    assert!(manager.overview().await.accounts[0].unassigned);
    manager.shutdown().await;
}

#[tokio::test]
async fn twenty_accounts_have_bounded_registry_and_shutdown_without_network() {
    let (_directory, manager) = manager().await;
    for user in 100..119 {
        add(&manager, user).await;
    }
    assert_eq!(manager.overview().await.accounts.len(), 20);
    let attempt = verified(&manager, 200, None).await;
    assert!(matches!(
        manager
            .request(Request::FinishLogin {
                attempt,
                label: String::new(),
                copy_from: None,
                copy_auto_claim: false
            })
            .await,
        Err(AppError::Account(Error::Limit))
    ));
    tokio::time::timeout(Duration::from_secs(3), manager.shutdown())
        .await
        .unwrap();
    assert!(manager.tasks.is_empty() && manager.writes.is_empty());
}

#[test]
fn corrupt_or_unsupported_registry_is_preserved() {
    let directory = tempfile::tempdir().unwrap();
    for original in [
        b"{broken".to_vec(),
        serde_json::to_vec(&json!({"version":20,"accounts":[]})).unwrap(),
    ] {
        std::fs::write(directory.path().join("accounts.json"), &original).unwrap();
        assert!(AccountManager::open(directory.path().into()).is_err());
        assert_eq!(
            std::fs::read(directory.path().join("accounts.json")).unwrap(),
            original
        );
    }
}
