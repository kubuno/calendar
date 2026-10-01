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
    models::time_block::{CreateTimeBlockDto, UpdateTimeBlockDto},
    services::time_block_service::TimeBlockService,
    state::AppState,
};

pub async fn list(
    State(state): State<AppState>,
    Extension(user): Extension<CalendarUser>,
) -> Result<Json<serde_json::Value>> {
    let blocks = TimeBlockService::list(user.id, &state.db).await?;
    Ok(Json(serde_json::json!({ "time_blocks": blocks })))
}

pub async fn create(
    State(state): State<AppState>,
    Extension(user): Extension<CalendarUser>,
    Json(dto): Json<CreateTimeBlockDto>,
) -> Result<(StatusCode, Json<serde_json::Value>)> {
    use validator::Validate;
    dto.validate()
        .map_err(|e| crate::errors::CalendarError::Validation(e.to_string()))?;

    let block = TimeBlockService::create(user.id, dto, &state.db).await?;
    Ok((StatusCode::CREATED, Json(serde_json::json!({ "time_block": block }))))
}

pub async fn update(
    State(state): State<AppState>,
    Extension(user): Extension<CalendarUser>,
    Path(id): Path<Uuid>,
    Json(dto): Json<UpdateTimeBlockDto>,
) -> Result<Json<serde_json::Value>> {
    let block = TimeBlockService::update(id, user.id, dto, &state.db).await?;
    Ok(Json(serde_json::json!({ "time_block": block })))
}

pub async fn delete(
    State(state): State<AppState>,
    Extension(user): Extension<CalendarUser>,
    Path(id): Path<Uuid>,
) -> Result<StatusCode> {
    TimeBlockService::delete(id, user.id, &state.db).await?;
    Ok(StatusCode::NO_CONTENT)
}
