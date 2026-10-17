use std::net::SocketAddr;

use clap::Parser;
use twitch_drops_miner::{fixture, web};

#[derive(Parser)]
struct Args {
    #[arg(long, default_value = "127.0.0.1:8765")]
    bind: SocketAddr,
    #[arg(long, default_value = "")]
    public_base_url: String,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args = Args::parse();
    anyhow::ensure!(
        args.bind.ip().is_loopback(),
        "browser fixture must bind to loopback"
    );
    let directory = tempfile::tempdir()?;
    let (app, worker) = fixture::create(directory.path().to_owned(), &args.public_base_url).await?;
    let listener = tokio::net::TcpListener::bind(args.bind).await?;
    let shutdown = app.shutdown.clone();
    axum::serve(
        listener,
        web::router(app.clone()).into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(async move {
        let _ = tokio::signal::ctrl_c().await;
        shutdown.cancel();
    })
    .await?;
    app.shutdown.cancel();
    app.accounts.shutdown().await;
    worker.await?;
    app.drain_writes().await;
    app.sockets.close().await;
    Ok(())
}
