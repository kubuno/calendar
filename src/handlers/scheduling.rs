use axum::{
    extract::{Path, State},
    http::StatusCode,
    Extension,
    Json,
};
use uuid::Uuid;

use crate::{
    errors::Result,
    middleware::CalendarUser,
    models::scheduling::{AvailabilityQuery, ConfirmPollDto, CreatePollDto, PollRespondDto},
    services::{
        availability_service::AvailabilityService,
        scheduling_service::SchedulingService,
    },
    state::AppState,
};

// ── Meeting Polls ─────────────────────────────────────────────────────────────

pub async fn list_polls(
    State(state): State<AppState>,
    Extension(user): Extension<CalendarUser>,
) -> Result<Json<serde_json::Value>> {
    let polls = SchedulingService::list_polls(user.id, &state.db).await?;
    Ok(Json(serde_json::json!({ "polls": polls })))
}

pub async fn create_poll(
    State(state): State<AppState>,
    Extension(user): Extension<CalendarUser>,
    Json(dto): Json<CreatePollDto>,
) -> Result<(StatusCode, Json<serde_json::Value>)> {
    use validator::Validate;
    dto.validate()
        .map_err(|e| crate::errors::CalendarError::Validation(e.to_string()))?;

    let poll = SchedulingService::create_poll(user.id, dto, &state.db).await?;
    Ok((StatusCode::CREATED, Json(serde_json::json!({ "poll": poll }))))
}

pub async fn get_poll(
    State(state): State<AppState>,
    Extension(user): Extension<CalendarUser>,
    Path(id): Path<Uuid>,
) -> Result<Json<serde_json::Value>> {
    let poll  = SchedulingService::get_poll(id, user.id, &state.db).await?;
    let slots = SchedulingService::get_poll_slots(id, &state.db).await?;
    let responses = SchedulingService::get_poll_responses(id, &state.db).await?;
    Ok(Json(serde_json::json!({
        "poll":      poll,
        "slots":     slots,
        "responses": responses,
    })))
}

pub async fn update_poll(
    State(state): State<AppState>,
    Extension(user): Extension<CalendarUser>,
    Path(id): Path<Uuid>,
    Json(dto): Json<ConfirmPollDto>,
) -> Result<Json<serde_json::Value>> {
    let poll = SchedulingService::confirm_poll(id, user.id, dto, &state.db).await?;
    Ok(Json(serde_json::json!({ "poll": poll })))
}

pub async fn delete_poll(
    State(state): State<AppState>,
    Extension(user): Extension<CalendarUser>,
    Path(id): Path<Uuid>,
) -> Result<StatusCode> {
    SchedulingService::delete_poll(id, user.id, &state.db).await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn respond_poll(
    State(state): State<AppState>,
    Extension(user): Extension<CalendarUser>,
    Path(id): Path<Uuid>,
    Json(dto): Json<PollRespondDto>,
) -> Result<Json<serde_json::Value>> {
    let email = dto.email.clone().unwrap_or(user.email.clone());
    let responses = SchedulingService::respond_to_poll(
        id,
        Some(user.id),
        &email,
        dto,
        &state.db,
    )
    .await?;
    Ok(Json(serde_json::json!({ "responses": responses })))
}

// ── Availability ──────────────────────────────────────────────────────────────

pub async fn find_common_slots(
    State(state): State<AppState>,
    Extension(_user): Extension<CalendarUser>,
    Json(query): Json<AvailabilityQuery>,
) -> Result<Json<serde_json::Value>> {
    let slots = AvailabilityService::find_common_slots(query, &state.db).await?;
    Ok(Json(serde_json::json!({ "slots": slots })))
}

pub async fn my_availability(
    State(state): State<AppState>,
    Extension(user): Extension<CalendarUser>,
    axum::extract::Query(params): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> Result<Json<serde_json::Value>> {
    use chrono::Utc;
    let from = params
        .get("from")
        .and_then(|s| s.parse().ok())
        .unwrap_or_else(Utc::now);
    let until = params
        .get("until")
        .and_then(|s| s.parse().ok())
        .unwrap_or_else(|| from + chrono::Duration::days(7));

    let busy = AvailabilityService::get_user_availability(user.id, from, until, &state.db).await?;
    let busy_json: Vec<_> = busy
        .iter()
        .map(|(s, e)| serde_json::json!({ "starts_at": s, "ends_at": e }))
        .collect();

    Ok(Json(serde_json::json!({ "busy": busy_json })))
}
