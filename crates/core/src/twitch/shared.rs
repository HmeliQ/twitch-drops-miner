use super::*;
use tokio::sync::{OwnedSemaphorePermit, watch};
use tokio_util::task::TaskTracker;

struct Lane {
    concurrent: Arc<Semaphore>,
    next: Mutex<Instant>,
    spacing: Duration,
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::{
        Mock, MockServer, ResponseTemplate,
        matchers::{method, path},
    };

    #[tokio::test]
    async fn twenty_account_reads_share_one_public_fetch_and_individual_cancellation_does_not_abort_it()
     {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/catalog"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_delay(Duration::from_millis(100))
                    .set_body_json(serde_json::json!({"public":true})),
            )
            .expect(1)
            .mount(&server)
            .await;
        let shared = SharedNetwork::new(CancellationToken::new());
        let mut reads = vec![];
        for index in 0..20 {
            let mut http = super::super::tests::http(&server);
            http.shared = Some(shared.clone());
            if index == 0 {
                let cancel = http.cancel.clone();
                tokio::spawn(async move {
                    tokio::time::sleep(Duration::from_millis(20)).await;
                    cancel.cancel();
                });
            }
            reads.push(tokio::spawn(async move { http.catalog().await }));
        }
        let mut cancelled = 0;
        for read in reads {
            match read.await.unwrap() {
                Ok(value) => assert_eq!(value["public"], true),
                Err(TwitchError::Cancelled) => cancelled += 1,
                other => panic!("unexpected result: {other:?}"),
            }
        }
        assert_eq!(cancelled, 1);
        for request in server.received_requests().await.unwrap() {
            assert!(!request.headers.contains_key("Authorization"));
            assert!(!request.headers.contains_key("Cookie"));
            assert!(!request.headers.contains_key("X-Device-Id"));
        }
        shared.shutdown().await;
    }

    #[tokio::test(start_paused = true)]
    async fn discovery_saturation_leaves_capacity_for_watch_and_claims_and_waiters_cancel() {
        let discovery = Lane::new(4, 4);
        let realtime = Lane::new(8, 8);
        let cancel = CancellationToken::new();
        let mut held = vec![];
        for _ in 0..4 {
            held.push(discovery.acquire(&cancel).await.unwrap());
        }
        let watching = realtime.acquire(&cancel).await.unwrap();
        assert_eq!(discovery.concurrent.available_permits(), 0);
        assert_eq!(realtime.concurrent.available_permits(), 7);
        cancel.cancel();
        assert!(matches!(
            discovery.acquire(&cancel).await,
            Err(TwitchError::Cancelled)
        ));
        drop(watching);
        drop(held);
        assert_eq!(discovery.concurrent.available_permits(), 4);
    }

    #[tokio::test]
    async fn twenty_accounts_send_independent_watch_and_progress_requests_during_discovery_saturation()
     {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/gql"))
            .respond_with(ResponseTemplate::new(200).set_body_json(
                serde_json::json!({"data":{"currentUser":{"dropCurrentSession":null}}}),
            ))
            .expect(20)
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/"))
            .respond_with(ResponseTemplate::new(204))
            .expect(20)
            .mount(&server)
            .await;
        let shared = SharedNetwork::new(CancellationToken::new());
        let cancel = CancellationToken::new();
        let mut held = vec![];
        for _ in 0..4 {
            held.push(shared.discovery.acquire(&cancel).await.unwrap());
        }
        let start = Instant::now();
        let mut workers = vec![];
        for user in 1..=20 {
            let mut http = super::super::tests::http(&server);
            // Give the unused OAuth endpoint a distinct origin, as in production.
            http.endpoints.oauth = Url::parse("http://127.0.0.1:1").unwrap();
            http.shared = Some(shared.clone());
            let mut session = serde_json::to_value(super::super::tests::session()).unwrap();
            session["user_id"] = serde_json::json!(user);
            session["access_token"] = serde_json::json!(format!("fixture-{user}"));
            let session = serde_json::from_value(session).unwrap();
            let mut channel = crate::domain::Channel::offline(
                crate::domain::ChannelIdentity {
                    id: user,
                    login: format!("channel{user}"),
                    name: format!("Channel {user}"),
                },
                false,
            );
            channel.broadcast_id = Some(format!("broadcast{user}"));
            channel.beacon_url = Some(http.endpoints.web.clone());
            let client = TwitchClient::new(Arc::new(http), &session);
            workers.push(tokio::spawn(async move {
                assert!(
                    client
                        .send_watch(&mut channel, chrono::Utc::now())
                        .await
                        .unwrap()
                );
                assert_eq!(client.current_drop(user).await.unwrap(), None);
            }));
        }
        tokio::time::timeout(Duration::from_secs(12), async {
            for worker in workers {
                worker.await.unwrap();
            }
        })
        .await
        .expect("watch traffic must not wait for saturated discovery");
        assert!(start.elapsed() < Duration::from_secs(12));
        let requests = server.received_requests().await.unwrap();
        let credentials: std::collections::HashSet<_> = requests
            .iter()
            .filter(|r| r.url.path() == "/gql")
            .map(|r| {
                r.headers
                    .get("authorization")
                    .unwrap()
                    .to_str()
                    .unwrap()
                    .to_owned()
            })
            .collect();
        assert_eq!(credentials.len(), 20);
        drop(held);
        shared.shutdown().await;
    }
}

impl Lane {
    fn new(limit: usize, per_second: u32) -> Self {
        Self {
            concurrent: Arc::new(Semaphore::new(limit)),
            next: Mutex::new(Instant::now()),
            spacing: Duration::from_secs(1) / per_second,
        }
    }
    async fn acquire(
        &self,
        cancel: &CancellationToken,
    ) -> Result<OwnedSemaphorePermit, TwitchError> {
        let permit = tokio::select! { biased;
            _ = cancel.cancelled() => return Err(TwitchError::Cancelled),
            result = self.concurrent.clone().acquire_owned() => result.map_err(|_| TwitchError::Cancelled)?,
        };
        let due = {
            let mut next = self.next.lock().await;
            let due = (*next).max(Instant::now());
            *next = due + self.spacing;
            due
        };
        tokio::select! { biased;
            _ = cancel.cancelled() => Err(TwitchError::Cancelled),
            _ = tokio::time::sleep_until(due) => Ok(permit),
        }
    }
}

type CatalogResult = Result<Arc<Value>, TwitchError>;
#[derive(Default)]
struct CatalogState {
    saved: Option<(Instant, CatalogResult)>,
    pending: Option<(CancellationToken, watch::Receiver<Option<CatalogResult>>)>,
}

/// Only scheduling and public catalog bytes are shared, never an authenticated client.
pub(crate) struct SharedNetwork {
    realtime: Lane,
    discovery: Lane,
    catalog: Mutex<CatalogState>,
    cancel: CancellationToken,
    tasks: TaskTracker,
}

impl SharedNetwork {
    pub fn new(cancel: CancellationToken) -> Arc<Self> {
        Arc::new(Self {
            realtime: Lane::new(8, 8),
            discovery: Lane::new(4, 4),
            catalog: Mutex::new(CatalogState::default()),
            cancel,
            tasks: TaskTracker::new(),
        })
    }

    pub async fn acquire(
        &self,
        request: &reqwest::Request,
        http: &TwitchHttp,
    ) -> Result<OwnedSemaphorePermit, TwitchError> {
        let realtime = if request.url() == &http.endpoints.gql {
            request
                .body()
                .and_then(|body| body.as_bytes())
                .and_then(|bytes| serde_json::from_slice::<Value>(bytes).ok())
                .is_some_and(|body| {
                    matches!(
                        body["operationName"].as_str(),
                        Some(
                            "DropCurrentSessionContext"
                                | "DropsPage_ClaimDropRewards"
                                | "PlaybackAccessToken"
                        )
                    )
                })
        } else {
            request.method() == Method::POST
                && request.url().origin() != http.endpoints.oauth.origin()
        };
        if realtime {
            self.realtime.acquire(&http.cancel).await
        } else {
            self.discovery.acquire(&http.cancel).await
        }
    }

    pub async fn catalog(self: &Arc<Self>, http: &TwitchHttp) -> CatalogResult {
        let mut state = self.catalog.lock().await;
        if let Some((at, result)) = &state.saved {
            let age = if result.is_ok() { 30 } else { 5 };
            if at.elapsed() < Duration::from_secs(age) {
                return result.clone();
            }
        }
        let mut pending = if let Some((_, pending)) = &state.pending {
            pending.clone()
        } else {
            let (result, pending) = watch::channel(None);
            let cancel = self.cancel.child_token();
            state.pending = Some((cancel.clone(), pending.clone()));
            let mut reader = http.clone();
            reader.cancel = cancel.clone();
            let owned = self.clone();
            self.tasks.spawn(async move {
                let reply = reader.fetch_catalog().await.map(Arc::new);
                let mut state = owned.catalog.lock().await;
                if !cancel.is_cancelled() {
                    state.saved = Some((Instant::now(), reply.clone()));
                    state.pending = None;
                }
                result.send_replace(Some(reply));
            });
            pending
        };
        drop(state);
        loop {
            if let Some(result) = pending.borrow_and_update().clone() {
                return result;
            }
            tokio::select! { biased;
                _ = http.cancel.cancelled() => return Err(TwitchError::Cancelled),
                result = pending.changed() => if result.is_err() { return Err(TwitchError::Cancelled); },
            }
        }
    }

    pub async fn invalidate(&self) {
        let mut state = self.catalog.lock().await;
        if let Some((cancel, _)) = state.pending.take() {
            cancel.cancel();
        }
        state.saved = None;
    }

    pub async fn shutdown(&self) {
        self.cancel.cancel();
        self.tasks.close();
        self.tasks.wait().await;
    }
}
