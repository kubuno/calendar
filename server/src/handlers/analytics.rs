use axum::{extract::State, Extension, Json};

use crate::{
    errors::Result,
    middleware::CalendarUser,
    services::analytics_service::AnalyticsService,
    state::AppState,
};

pub async fn workload(
    State(state): State<AppState>,
    Extension(user): Extension<CalendarUser>,
) -> Result<Json<serde_json::Value>> {
    let data = AnalyticsService::workload(user.id, &state.db).await?;
    Ok(Json(serde_json::json!({ "workload": data })))
}

pub async fn distribution(
    State(state): State<AppState>,
    Extension(user): Extension<CalendarUser>,
) -> Result<Json<serde_json::Value>> {
    let data = AnalyticsService::distribution(user.id, &state.db).await?;
    Ok(Json(serde_json::json!({ "distribution": data })))
}

pub async fn trends(
    State(state): State<AppState>,
    Extension(user): Extension<CalendarUser>,
) -> Result<Json<serde_json::Value>> {
    let data = AnalyticsService::trends(user.id, &state.db).await?;
    let series: Vec<_> = data
        .iter()
        .map(|(week, count)| serde_json::json!({ "week": week, "count": count }))
        .collect();
    Ok(Json(serde_json::json!({ "trends": series })))
}
