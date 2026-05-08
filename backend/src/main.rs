// Color Studio vote collector.
//
// Single-binary Axum service backed by SQLite. Crash-safe (WAL mode), starts
// fresh if the DB file does not exist, and stays online for any single subject
// or set of surfaces — vote payloads are stored as JSON so the schema does not
// need to know about specific subjects.

use std::{
    env,
    net::SocketAddr,
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

use axum::{
    extract::{ConnectInfo, Query, State},
    http::{HeaderMap, HeaderValue, Method, StatusCode},
    response::{IntoResponse, Json},
    routing::{get, post},
    Router,
};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use tower_http::{
    cors::{Any, CorsLayer},
    trace::TraceLayer,
};

#[derive(Debug, thiserror::Error)]
enum AppError {
    #[error("bad request: {0}")]
    BadRequest(String),
    #[error("internal: {0}")]
    Internal(String),
}

impl IntoResponse for AppError {
    fn into_response(self) -> axum::response::Response {
        let (code, msg) = match &self {
            AppError::BadRequest(m) => (StatusCode::BAD_REQUEST, m.clone()),
            AppError::Internal(m) => {
                tracing::error!("internal error: {m}");
                (StatusCode::INTERNAL_SERVER_ERROR, "internal error".into())
            }
        };
        (code, Json(serde_json::json!({"error": msg}))).into_response()
    }
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[derive(Clone)]
struct AppState {
    db: Arc<Mutex<Connection>>,
}

fn open_db(path: &str) -> Result<Connection, rusqlite::Error> {
    let conn = Connection::open(path)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS votes (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            subject     TEXT    NOT NULL,
            palette_idx INTEGER,
            palette_name TEXT,
            choice_json TEXT    NOT NULL,
            choice_key  TEXT    NOT NULL,
            ip_hash     TEXT,
            created_at  INTEGER NOT NULL
         );
         CREATE INDEX IF NOT EXISTS votes_subject_idx ON votes(subject);
         CREATE INDEX IF NOT EXISTS votes_subject_key_idx ON votes(subject, choice_key);",
    )?;
    Ok(conn)
}

#[derive(Debug, Deserialize)]
struct VoteIn {
    subject: String,
    #[serde(default, rename = "paletteIdx")]
    palette_idx: Option<i64>,
    #[serde(default, rename = "paletteName")]
    palette_name: Option<String>,
    colors: BTreeMap<String, String>,
}

#[derive(Debug, Serialize)]
struct VoteOut {
    ok: bool,
    #[serde(rename = "totalForSubject")]
    total_for_subject: i64,
}

fn validate_subject(s: &str) -> Result<(), AppError> {
    if s.is_empty() || s.len() > 64 {
        return Err(AppError::BadRequest("subject length".into()));
    }
    if !s
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(AppError::BadRequest("subject charset".into()));
    }
    Ok(())
}

fn validate_hex(h: &str) -> Result<(), AppError> {
    if h.len() != 7 || !h.starts_with('#') {
        return Err(AppError::BadRequest(format!("hex {h}")));
    }
    if !h[1..].chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(AppError::BadRequest(format!("hex {h}")));
    }
    Ok(())
}

fn ip_fingerprint(headers: &HeaderMap, addr: SocketAddr) -> String {
    let raw = headers
        .get("x-forwarded-for")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.split(',').next())
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|| addr.ip().to_string());
    let salt = env::var("IP_HASH_SALT").unwrap_or_else(|_| "color-studio".into());
    let mut hasher = Sha256::new();
    hasher.update(salt.as_bytes());
    hasher.update(raw.as_bytes());
    let digest = hasher.finalize();
    format!("{:x}", digest)[..16].to_string()
}

fn choice_key(colors: &BTreeMap<String, String>) -> String {
    colors
        .iter()
        .map(|(k, v)| format!("{k}:{}", v.to_lowercase()))
        .collect::<Vec<_>>()
        .join("|")
}

async fn vote(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<VoteIn>,
) -> Result<Json<VoteOut>, AppError> {
    validate_subject(&body.subject)?;
    if body.colors.is_empty() {
        return Err(AppError::BadRequest("colors empty".into()));
    }
    if body.colors.len() > 16 {
        return Err(AppError::BadRequest("too many surfaces".into()));
    }
    for (k, v) in &body.colors {
        if k.len() > 32 || !k.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
            return Err(AppError::BadRequest(format!("surface id {k}")));
        }
        validate_hex(v)?;
    }

    let key = choice_key(&body.colors);
    let json = serde_json::to_string(&body.colors)
        .map_err(|e| AppError::Internal(e.to_string()))?;
    let ip_h = ip_fingerprint(&headers, addr);
    let now = now_secs();

    let total = {
        let conn = state.db.lock().map_err(|e| AppError::Internal(e.to_string()))?;
        conn.execute(
            "INSERT INTO votes (subject, palette_idx, palette_name, choice_json, choice_key, ip_hash, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                body.subject,
                body.palette_idx,
                body.palette_name,
                json,
                key,
                ip_h,
                now,
            ],
        )
        .map_err(|e| AppError::Internal(e.to_string()))?;

        conn.query_row(
            "SELECT COUNT(*) FROM votes WHERE subject = ?1",
            params![body.subject],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|e| AppError::Internal(e.to_string()))?
    };

    Ok(Json(VoteOut { ok: true, total_for_subject: total }))
}

#[derive(Debug, Deserialize)]
struct TallyQuery {
    subject: String,
}

#[derive(Debug, Serialize)]
struct TallyRow {
    #[serde(rename = "paletteName")]
    palette_name: Option<String>,
    #[serde(rename = "paletteIdx")]
    palette_idx: Option<i64>,
    colors: Value,
    count: i64,
}

#[derive(Debug, Serialize)]
struct TallyOut {
    subject: String,
    total: i64,
    rows: Vec<TallyRow>,
}

async fn tally(
    State(state): State<AppState>,
    Query(q): Query<TallyQuery>,
) -> Result<Json<TallyOut>, AppError> {
    validate_subject(&q.subject)?;
    let conn = state.db.lock().map_err(|e| AppError::Internal(e.to_string()))?;
    let mut stmt = conn
        .prepare(
            "SELECT palette_idx, palette_name, choice_json, COUNT(*) AS n
             FROM votes WHERE subject = ?1
             GROUP BY choice_key, palette_idx, palette_name
             ORDER BY n DESC, palette_name",
        )
        .map_err(|e| AppError::Internal(e.to_string()))?;
    let rows: Vec<TallyRow> = stmt
        .query_map(params![q.subject], |row| {
            let palette_idx: Option<i64> = row.get(0)?;
            let palette_name: Option<String> = row.get(1)?;
            let choice_json: String = row.get(2)?;
            let n: i64 = row.get(3)?;
            let colors: Value = serde_json::from_str(&choice_json)
                .unwrap_or(Value::Object(serde_json::Map::new()));
            Ok(TallyRow { palette_idx, palette_name, colors, count: n })
        })
        .map_err(|e| AppError::Internal(e.to_string()))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| AppError::Internal(e.to_string()))?;

    let total: i64 = rows.iter().map(|r| r.count).sum();
    Ok(Json(TallyOut { subject: q.subject, total, rows }))
}

async fn health() -> &'static str {
    "ok"
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,tower_http=info".into()),
        )
        .init();

    let db_path = env::var("DB_PATH").unwrap_or_else(|_| "votes.sqlite".into());
    let conn = open_db(&db_path)?;
    let state = AppState { db: Arc::new(Mutex::new(conn)) };

    let cors_origin = env::var("CORS_ORIGIN").unwrap_or_else(|_| "*".into());
    let cors = if cors_origin == "*" {
        CorsLayer::new()
            .allow_origin(Any)
            .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
            .allow_headers(Any)
    } else {
        let origin: HeaderValue = cors_origin
            .parse()
            .map_err(|e: axum::http::header::InvalidHeaderValue| e.to_string())?;
        CorsLayer::new()
            .allow_origin(origin)
            .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
            .allow_headers(Any)
    };

    let app = Router::new()
        .route("/health", get(health))
        .route("/vote", post(vote))
        .route("/tally", get(tally))
        .with_state(state)
        .layer(cors)
        .layer(TraceLayer::new_for_http());

    let port: u16 = env::var("PORT").unwrap_or_else(|_| "8080".into()).parse()?;
    let bind: SocketAddr = ([0, 0, 0, 0], port).into();
    tracing::info!("listening on {bind} (db={db_path})");
    let listener = tokio::net::TcpListener::bind(bind).await?;
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown_signal())
    .await?;
    Ok(())
}

async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c().await.ok();
    };
    #[cfg(unix)]
    let term = async {
        let mut sig = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("install sigterm");
        sig.recv().await;
    };
    #[cfg(not(unix))]
    let term = std::future::pending::<()>();
    tokio::select! { _ = ctrl_c => {}, _ = term => {} }
    tracing::info!("shutdown signal received");
}
