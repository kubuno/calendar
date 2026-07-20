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
    models::calendar::{CreateCalendarDto, ShareCalendarDto, SubscribeCalendarDto, UpdateCalendarDto},
    services::{
        calendar_service::CalendarService,
        icalendar_service::ICalendarService,
        subscription_service::SubscriptionService,
    },
    state::AppState,
};

pub async fn list(
    State(state): State<AppState>,
    Extension(user): Extension<CalendarUser>,
) -> Result<Json<serde_json::Value>> {
    let mut calendars = CalendarService::list(user.id, &state.db).await?;

    // First access: create a default personal calendar
    if calendars.is_empty() {
        let default_cal = CalendarService::create(
            user.id,
            CreateCalendarDto {
                id: None,
                name:        "Mon calendar".to_string(),
                description: None,
                color:       Some("#4D38DB".to_string()),
                cal_type:    Some("personal".to_string()),
                timezone:    None,
                is_public:   Some(false),
            },
            &state.db,
        )
        .await?;
        calendars.push(default_cal);
    }

    Ok(Json(serde_json::json!({ "calendars": calendars })))
}

pub async fn create(
    State(state): State<AppState>,
    Extension(user): Extension<CalendarUser>,
    Json(dto): Json<CreateCalendarDto>,
) -> Result<(StatusCode, Json<serde_json::Value>)> {
    use validator::Validate;
    dto.validate()
        .map_err(|e| crate::errors::CalendarError::Validation(e.to_string()))?;

    let cal = CalendarService::create(user.id, dto, &state.db).await?;
    Ok((StatusCode::CREATED, Json(serde_json::json!({ "calendar": cal }))))
}

pub async fn get(
    State(state): State<AppState>,
    Extension(user): Extension<CalendarUser>,
    Path(id): Path<Uuid>,
) -> Result<Json<serde_json::Value>> {
    let cal = CalendarService::get(id, user.id, &state.db).await?;
    Ok(Json(serde_json::json!({ "calendar": cal })))
}

pub async fn update(
    State(state): State<AppState>,
    Extension(user): Extension<CalendarUser>,
    Path(id): Path<Uuid>,
    Json(dto): Json<UpdateCalendarDto>,
) -> Result<Json<serde_json::Value>> {
    let cal = CalendarService::update(id, user.id, dto, &state.db).await?;
    Ok(Json(serde_json::json!({ "calendar": cal })))
}

pub async fn delete(
    State(state): State<AppState>,
    Extension(user): Extension<CalendarUser>,
    Path(id): Path<Uuid>,
) -> Result<StatusCode> {
    CalendarService::delete(id, user.id, &state.db).await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn share(
    State(state): State<AppState>,
    Extension(user): Extension<CalendarUser>,
    Path(id): Path<Uuid>,
    Json(dto): Json<ShareCalendarDto>,
) -> Result<(StatusCode, Json<serde_json::Value>)> {
    let share = CalendarService::share(id, user.id, dto, &state.db).await?;
    Ok((StatusCode::CREATED, Json(serde_json::json!({ "share": share }))))
}

pub async fn unshare(
    State(state): State<AppState>,
    Extension(user): Extension<CalendarUser>,
    Path((id, shared_with)): Path<(Uuid, Uuid)>,
) -> Result<StatusCode> {
    CalendarService::unshare(id, user.id, shared_with, &state.db).await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn list_shares(
    State(state): State<AppState>,
    Extension(user): Extension<CalendarUser>,
    Path(id): Path<Uuid>,
) -> Result<Json<serde_json::Value>> {
    let shares = CalendarService::list_shares(id, user.id, &state.db).await?;
    Ok(Json(serde_json::json!({ "shares": shares })))
}

/// Subscribe to a remote iCalendar feed (creates a mirror calendar + first sync).
pub async fn subscribe(
    State(state): State<AppState>,
    Extension(user): Extension<CalendarUser>,
    Json(dto): Json<SubscribeCalendarDto>,
) -> Result<(StatusCode, Json<serde_json::Value>)> {
    use validator::Validate;
    dto.validate()
        .map_err(|e| crate::errors::CalendarError::Validation(e.to_string()))?;

    let cal = SubscriptionService::subscribe(user.id, dto, &state.db).await?;
    Ok((StatusCode::CREATED, Json(serde_json::json!({ "calendar": cal }))))
}

/// Manually refresh a subscription calendar.
pub async fn refresh(
    State(state): State<AppState>,
    Extension(user): Extension<CalendarUser>,
    Path(id): Path<Uuid>,
) -> Result<Json<serde_json::Value>> {
    let cal = CalendarService::get(id, user.id, &state.db).await?;
    if cal.owner_id != user.id {
        return Err(crate::errors::CalendarError::Forbidden);
    }
    let url = cal
        .subscription_url
        .ok_or_else(|| crate::errors::CalendarError::Validation("Ce calendrier n'est pas un abonnement".into()))?;
    let (imported, updated, removed) = SubscriptionService::sync(id, user.id, &url, &state.db).await?;
    Ok(Json(serde_json::json!({
        "imported": imported, "updated": updated, "removed": removed,
    })))
}

pub async fn export(
    State(state): State<AppState>,
    Extension(user): Extension<CalendarUser>,
    Path(id): Path<Uuid>,
) -> Result<([(axum::http::HeaderName, String); 2], String)> {
    let cal = CalendarService::get(id, user.id, &state.db).await?;

    // Load all the calendar's events
    let events: Vec<crate::models::event::Event> = sqlx::query_as::<_, crate::models::event::Event>(
        "SELECT * FROM calendar.events WHERE calendar_id = $1 ORDER BY starts_at",
    )
    .bind(id)
    .fetch_all(&state.db)
    .await?;

    let ics = ICalendarService::calendar_to_ics(&events, &cal.name);

    Ok((
        [
            (
                axum::http::header::CONTENT_TYPE,
                "text/calendar; charset=utf-8".to_string(),
            ),
            (
                axum::http::header::CONTENT_DISPOSITION,
                format!("attachment; filename=\"{}.ics\"", cal.name),
            ),
        ],
        ics,
    ))
}
