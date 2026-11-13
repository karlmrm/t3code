//! iroh for the T3 Code app: one endpoint per app process, whose key is the
//! phone's mesh member key, and loopback TCP forwards to mesh servers that
//! speak dumbpipe's protocol (ALPN `DUMBPIPEV0`, `hello` first), the way the
//! server's own `IrohTunnels` does.

mod jni_api;

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use anyhow::{Context, Result, anyhow};
use iroh::endpoint::{Connection, IdleTimeout, QuicTransportConfig, presets};
use iroh::{
    Endpoint, EndpointAddr, RelayConfig, RelayMap, RelayMode, RelayUrl, SecretKey, TransportAddr,
};
use iroh_tickets::endpoint::EndpointTicket;
use tokio::io::AsyncWriteExt;
use tokio::net::{TcpListener, TcpStream};
use tokio::runtime::Runtime;
use tokio::sync::Mutex as AsyncMutex;

const ALPN: &[u8] = b"DUMBPIPEV0";
const HANDSHAKE: &[u8] = b"hello";
/// A stream that does not open this fast rides a dead path, say after a network switch.
const OPEN_STREAM_TIMEOUT: Duration = Duration::from_secs(6);
/// QUIC gives up on a connection that hears nothing this long; the lower of the
/// two sides' values applies. iroh's 30 seconds kept a connection whose only
/// path died (the peer left our relay, say) for half a minute before a redial.
const MAX_IDLE: Duration = Duration::from_secs(10);
const KEEP_ALIVE: Duration = Duration::from_secs(2);
const DIAL_TIMEOUT: Duration = Duration::from_secs(4);
const RELAY_CHECK: Duration = Duration::from_secs(5);
const RELAY_RETRY: Duration = Duration::from_secs(3);
const RELAY_PING_TIMEOUT: Duration = Duration::from_secs(5);
/// A connection that hears nothing this long, two keep-alives, is redialed.
const SILENCE: Duration = Duration::from_secs(4);

/// Sends iroh's warnings and this crate's info to logcat under the tag `t3-iroh`.
fn init_logging() {
    static ONCE: OnceLock<()> = OnceLock::new();
    ONCE.get_or_init(|| {
        #[cfg(target_os = "android")]
        {
            use tracing_subscriber::layer::SubscriberExt;
            let filter = tracing_subscriber::EnvFilter::new("warn,t3_iroh=info");
            let subscriber = tracing_subscriber::registry()
                .with(filter)
                .with(paranoid_android::layer("t3-iroh"));
            let _ = tracing::subscriber::set_global_default(subscriber);
        }
    });
}

fn runtime() -> &'static Runtime {
    static RUNTIME: OnceLock<Runtime> = OnceLock::new();
    RUNTIME.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .thread_name("t3-iroh")
            .build()
            .expect("tokio runtime")
    })
}

#[derive(Clone, PartialEq, Eq)]
pub struct RelaySettings {
    pub url: String,
    pub token: Option<String>,
}

struct Node {
    endpoint: Endpoint,
    relay: Option<RelaySettings>,
    on_fallback: Arc<Mutex<bool>>,
}

struct Forward {
    port: u16,
    peer: Arc<Mutex<EndpointAddr>>,
    connection: Arc<AsyncMutex<Option<Connection>>>,
}

#[derive(Default)]
struct State {
    secret: Option<SecretKey>,
    node: Option<Node>,
    generation: u64,
    forwards: HashMap<String, Forward>,
}

fn state() -> &'static Mutex<State> {
    static STATE: OnceLock<Mutex<State>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(State::default()))
}

fn current_endpoint() -> Result<Endpoint> {
    state()
        .lock()
        .unwrap()
        .node
        .as_ref()
        .map(|node| node.endpoint.clone())
        .ok_or_else(|| anyhow!("iroh has not started"))
}

/// Loads the key at `path`, or makes one and writes it there.
fn load_or_create_key(path: &str) -> Result<SecretKey> {
    if let Ok(bytes) = std::fs::read(path) {
        let seed: [u8; 32] = bytes
            .as_slice()
            .try_into()
            .map_err(|_| anyhow!("the iroh key file is not 32 bytes"))?;
        return Ok(SecretKey::from_bytes(&seed));
    }
    let key = SecretKey::generate();
    if let Some(parent) = std::path::Path::new(path).parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = format!("{path}.tmp");
    std::fs::write(&tmp, key.to_bytes())?;
    std::fs::rename(&tmp, path)?;
    Ok(key)
}

fn relay_config(relay: &RelaySettings) -> Result<RelayConfig> {
    let url: RelayUrl = relay.url.parse().context("relay url")?;
    let config = RelayConfig::new(url, None);
    Ok(match &relay.token {
        Some(token) => config.with_auth_token(token.clone()),
        None => config,
    })
}

async fn bind(secret: SecretKey, relay: Option<&RelaySettings>) -> Result<Endpoint> {
    let transport = QuicTransportConfig::builder()
        .keep_alive_interval(KEEP_ALIVE)
        .max_idle_timeout(Some(IdleTimeout::try_from(MAX_IDLE)?))
        .build();
    let mut builder = Endpoint::builder(presets::N0)
        .secret_key(secret)
        .transport_config(transport);
    if let Some(relay) = relay {
        let map: RelayMap = [relay_config(relay)?].into_iter().collect();
        builder = builder.relay_mode(RelayMode::Custom(map));
    }
    Ok(builder.bind().await?)
}

/// Starts the endpoint, or restarts it when the relay changed. Returns the endpoint id.
pub fn start(key_path: &str, relay: Option<RelaySettings>) -> Result<String> {
    init_logging();
    let (secret, previous, generation) = {
        let mut st = state().lock().unwrap();
        if st.secret.is_none() {
            st.secret = Some(load_or_create_key(key_path)?);
        }
        let secret = st.secret.clone().unwrap();
        if let Some(node) = &st.node {
            if node.relay == relay && !node.endpoint.is_closed() {
                return Ok(node.endpoint.id().to_string());
            }
        }
        st.generation += 1;
        (secret, st.node.take(), st.generation)
    };
    runtime().block_on(async move {
        if let Some(old) = previous {
            old.endpoint.close().await;
        }
        let endpoint = bind(secret, relay.as_ref()).await?;
        let id = endpoint.id().to_string();
        tracing::info!(id = %id, relay = ?relay.as_ref().map(|r| &r.url), "endpoint started");
        let on_fallback = Arc::new(Mutex::new(false));
        tokio::spawn(watch_silence(generation));
        if let Some(relay) = &relay {
            tokio::spawn(watch_relay(
                endpoint.clone(),
                relay_config(relay)?,
                generation,
                on_fallback.clone(),
            ));
        }
        let mut st = state().lock().unwrap();
        // Connections of the old endpoint are gone; forwards dial afresh.
        for forward in st.forwards.values() {
            if let Ok(mut slot) = forward.connection.try_lock() {
                *slot = None;
            }
        }
        st.node = Some(Node {
            endpoint,
            relay,
            on_fallback,
        });
        Ok(id)
    })
}

/// Swaps the configured relay for n0's while it does not answer, and back once it
/// does. iroh picks a new home relay at once only when its home leaves the map;
/// merely adding relays waits for the next net report.
async fn watch_relay(
    endpoint: Endpoint,
    own: RelayConfig,
    generation: u64,
    on_fallback: Arc<Mutex<bool>>,
) {
    let url = own.url.to_string();
    let fallback = RelayMode::Default.relay_map();
    let client = reqwest::Client::builder()
        .tls_backend_preconfigured(endpoint.tls_config().clone())
        .timeout(RELAY_PING_TIMEOUT)
        // A pooled connection the relay closed while idle fails the next ping.
        .pool_max_idle_per_host(0)
        .build();
    let Ok(client) = client else { return };
    let ping = format!("{}/ping", url.trim_end_matches('/'));
    let mut failures = 0u32;
    loop {
        if endpoint.is_closed() || state().lock().unwrap().generation != generation {
            return;
        }
        match client.get(&ping).send().await {
            Ok(response) if response.status().is_success() => failures = 0,
            Ok(response) => {
                failures += 1;
                tracing::info!(status = %response.status(), failures, "relay ping");
            }
            Err(error) => {
                failures += 1;
                tracing::info!(failures, "relay ping: {error:#}");
            }
        }
        // One lost ping is noise; two in a row mean the relay is gone.
        let up = failures < 2;
        let falling_back = *on_fallback.lock().unwrap();
        if up == falling_back {
            tracing::info!(up, "configured relay");
        }
        if !up && !falling_back {
            for config in fallback.relays::<Vec<_>>() {
                endpoint.insert_relay(config.url.clone(), config).await;
            }
            endpoint.remove_relay(&own.url).await;
            *on_fallback.lock().unwrap() = true;
        } else if up && falling_back {
            endpoint
                .insert_relay(own.url.clone(), Arc::new(own.clone()))
                .await;
            for config in fallback.relays::<Vec<_>>() {
                endpoint.remove_relay(&config.url).await;
            }
            *on_fallback.lock().unwrap() = false;
        }
        let pause = if failures == 1 {
            RELAY_RETRY
        } else {
            RELAY_CHECK
        };
        tokio::time::sleep(pause).await;
    }
}

/// Tells iroh the network changed, so it probes new paths now instead of on its timer.
/// `interface` is the new default network's interface, which iroh cannot read itself
/// on Android; without it iroh waits five seconds before dropping dead paths.
pub fn network_changed(interface: Option<String>) {
    tracing::info!(?interface, "network changed");
    #[cfg(target_os = "android")]
    netwatch::interfaces::set_android_default_interface(interface);
    #[cfg(not(target_os = "android"))]
    let _ = interface;
    if let Ok(endpoint) = current_endpoint() {
        runtime().spawn(async move { endpoint.network_change().await });
    }
}

/// Closes forward connections that have heard nothing for `SILENCE`. Keep-alives
/// go out every `KEEP_ALIVE`, so a live connection always hears acks; a silent
/// one rides a dead path (a network switch, a relay that went away) and would
/// otherwise hang until `MAX_IDLE`. The next stream redials, which takes well
/// under a second.
async fn watch_silence(generation: u64) {
    let mut heard: HashMap<usize, (u64, tokio::time::Instant)> = HashMap::new();
    loop {
        tokio::time::sleep(Duration::from_millis(500)).await;
        let slots: Vec<Arc<AsyncMutex<Option<Connection>>>> = {
            let st = state().lock().unwrap();
            if st.generation != generation {
                return;
            }
            st.forwards
                .values()
                .map(|forward| forward.connection.clone())
                .collect()
        };
        let now = tokio::time::Instant::now();
        let mut seen = Vec::new();
        for slot in slots {
            let Some(open) = slot.lock().await.clone() else {
                continue;
            };
            if open.close_reason().is_some() {
                continue;
            }
            let id = open.stable_id();
            seen.push(id);
            let stats = open.stats();
            // Acks arrive only for packets the peer received; datagrams alone may be
            // the peer's own keep-alives reaching us over a path it cannot hear back on.
            let rx = stats.frame_rx.acks + stats.frame_rx.path_acks;
            let entry = heard.entry(id).or_insert((rx, now));
            if entry.0 != rx {
                *entry = (rx, now);
            } else if now - entry.1 >= SILENCE {
                tracing::info!(peer = %open.remote_id().fmt_short(), "silent; redialing");
                open.close(0u32.into(), b"silent");
                let mut guard = slot.lock().await;
                if guard
                    .as_ref()
                    .is_some_and(|current| current.stable_id() == id)
                {
                    *guard = None;
                }
            }
        }
        heard.retain(|id, _| seen.contains(id));
    }
}

/// Signs `message` with the member key; base64url without padding, as node's `base64url`.
pub fn sign(message: &str) -> Result<String> {
    let st = state().lock().unwrap();
    let secret = st
        .secret
        .as_ref()
        .ok_or_else(|| anyhow!("iroh has not started"))?;
    let signature = secret.sign(message.as_bytes());
    Ok(data_encoding::BASE64URL_NOPAD.encode(&signature.to_bytes()))
}

/// A loopback port reaching the endpoint in `ticket`. One per endpoint id; a later
/// ticket for the same id only updates the address new connections dial.
pub fn forward(ticket: &str) -> Result<u16> {
    let ticket: EndpointTicket = ticket.parse().context("iroh ticket")?;
    let addr = ticket.endpoint_addr().clone();
    let key = addr.id.to_string();
    {
        let st = state().lock().unwrap();
        if let Some(existing) = st.forwards.get(&key) {
            *existing.peer.lock().unwrap() = addr;
            return Ok(existing.port);
        }
    }
    let listener = runtime().block_on(TcpListener::bind("127.0.0.1:0"))?;
    let port = listener.local_addr()?.port();
    let peer = Arc::new(Mutex::new(addr));
    let connection = Arc::new(AsyncMutex::new(None));
    {
        let mut st = state().lock().unwrap();
        if let Some(existing) = st.forwards.get(&key) {
            return Ok(existing.port);
        }
        st.forwards.insert(
            key.clone(),
            Forward {
                port,
                peer: peer.clone(),
                connection: connection.clone(),
            },
        );
    }
    runtime().spawn(accept_loop(key, listener, peer, connection));
    Ok(port)
}

async fn accept_loop(
    key: String,
    listener: TcpListener,
    peer: Arc<Mutex<EndpointAddr>>,
    connection: Arc<AsyncMutex<Option<Connection>>>,
) {
    loop {
        let Ok((socket, _)) = listener.accept().await else {
            return;
        };
        if !state().lock().unwrap().forwards.contains_key(&key) {
            return;
        }
        let peer = peer.clone();
        let connection = connection.clone();
        tokio::spawn(async move {
            if let Err(error) = serve_socket(socket, peer, connection).await {
                tracing::warn!("forward: {error:#}");
            }
        });
    }
}

async fn connected(
    peer: &Arc<Mutex<EndpointAddr>>,
    slot: &Arc<AsyncMutex<Option<Connection>>>,
) -> Result<Connection> {
    let mut guard = slot.lock().await;
    if let Some(open) = guard.as_ref() {
        if open.close_reason().is_none() {
            return Ok(open.clone());
        }
    }
    let endpoint = current_endpoint()?;
    // A member whose relay went down is homed on one of n0's relays, and
    // discovery may still answer with the old one for a while. Initials go to
    // every known path, so offering all of them reaches it at once.
    let addr = peer.lock().unwrap().clone().with_addrs(
        RelayMode::Default
            .relay_map()
            .urls::<Vec<_>>()
            .into_iter()
            .map(TransportAddr::Relay),
    );
    tracing::info!(peer = %addr.id.fmt_short(), "dialing");
    // A handshake whose first packets went nowhere waits out the idle timeout;
    // a fresh dial gets through sooner.
    let open = tokio::time::timeout(DIAL_TIMEOUT, endpoint.connect(addr, ALPN))
        .await
        .map_err(|_| anyhow!("dial timed out"))??;
    tracing::info!(peer = %open.remote_id().fmt_short(), "connected");
    *guard = Some(open.clone());
    Ok(open)
}

async fn open_stream(
    peer: &Arc<Mutex<EndpointAddr>>,
    slot: &Arc<AsyncMutex<Option<Connection>>>,
) -> Result<(iroh::endpoint::SendStream, iroh::endpoint::RecvStream)> {
    let current = connected(peer, slot).await?;
    match tokio::time::timeout(OPEN_STREAM_TIMEOUT, current.open_bi()).await {
        Ok(Ok(stream)) => Ok(stream),
        outcome => {
            // Drop the connection so the next attempt dials afresh.
            current.close(0u32.into(), b"stale");
            let mut guard = slot.lock().await;
            if guard
                .as_ref()
                .is_some_and(|open| open.stable_id() == current.stable_id())
            {
                *guard = None;
            }
            Err(match outcome {
                Ok(Err(error)) => error.into(),
                _ => anyhow!("iroh stream did not open"),
            })
        }
    }
}

async fn serve_socket(
    socket: TcpStream,
    peer: Arc<Mutex<EndpointAddr>>,
    slot: Arc<AsyncMutex<Option<Connection>>>,
) -> Result<()> {
    let (mut send, mut recv) = match open_stream(&peer, &slot).await {
        Ok(stream) => stream,
        Err(_) => open_stream(&peer, &slot).await?,
    };
    send.write_all(HANDSHAKE).await?;
    let (mut read, mut write) = socket.into_split();
    let up = async {
        tokio::io::copy(&mut read, &mut send).await?;
        send.finish()?;
        anyhow::Ok(())
    };
    let down = async {
        tokio::io::copy(&mut recv, &mut write).await?;
        write.shutdown().await?;
        anyhow::Ok(())
    };
    let (a, b) = tokio::join!(up, down);
    a.and(b)
}

/// Closes the forward to `endpoint_id`, if one is open.
pub fn close_forward(endpoint_id: &str) {
    let removed = state().lock().unwrap().forwards.remove(endpoint_id);
    if let Some(forward) = removed {
        runtime().spawn(async move {
            if let Some(open) = forward.connection.lock().await.take() {
                open.close(0u32.into(), b"closed");
            }
            // Wakes the accept loop so it sees the forward is gone.
            let _ = TcpStream::connect(("127.0.0.1", forward.port)).await;
        });
    }
}

/// What the endpoint and each forward's connection look like now, as JSON.
pub fn status() -> String {
    let st = state().lock().unwrap();
    let Some(node) = &st.node else {
        return serde_json::json!({ "started": false }).to_string();
    };
    let endpoint = node.endpoint.clone();
    let on_fallback = *node.on_fallback.lock().unwrap();
    let relay = node.relay.as_ref().map(|relay| relay.url.clone());
    let forwards: Vec<(String, u16, Arc<AsyncMutex<Option<Connection>>>)> = st
        .forwards
        .iter()
        .map(|(id, forward)| (id.clone(), forward.port, forward.connection.clone()))
        .collect();
    drop(st);
    let peers: Vec<serde_json::Value> = forwards
        .into_iter()
        .map(|(id, port, slot)| {
            let open = slot.try_lock().ok().and_then(|guard| guard.clone());
            let path = open
                .as_ref()
                .filter(|c| c.close_reason().is_none())
                .and_then(|c| {
                    c.paths().iter().find(|p| p.is_selected()).map(|p| {
                        serde_json::json!({
                            "kind": if p.is_relay() { "relay" } else { "direct" },
                            "addr": format!("{:?}", p.remote_addr()),
                            "rttMs": p.rtt().as_millis() as u64,
                        })
                    })
                });
            serde_json::json!({ "id": id, "port": port, "path": path })
        })
        .collect();
    let home: Vec<serde_json::Value> = {
        use iroh::Watcher;
        endpoint
            .home_relay_status()
            .get()
            .iter()
            .map(|s| serde_json::json!({ "url": s.url().to_string(), "connected": s.is_connected() }))
            .collect()
    };
    serde_json::json!({
        "started": true,
        "id": endpoint.id().to_string(),
        "relay": relay,
        "onFallback": on_fallback,
        "home": home,
        "peers": peers,
    })
    .to_string()
}
