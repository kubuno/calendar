use axum::Json;
use serde_json::{json, Value};

pub async fn health() -> Json<Value> {
    Json(json!({
        "status":  "ok",
        "module":  "calendar",
        "version": env!("CARGO_PKG_VERSION"),
    }))
}
