use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    Extension,
    Json,
};
use uuid::Uuid;

use crate::{
    errors::Result,
    events::publisher,
    middleware::CalendarUser,
    models::event::{CreateEventDto, EventsQuery, RecurrenceScope, UpdateEventDto},
    services::{event_service::EventService, icalendar_service::ICalendarService},
    state::AppState,
};

#[derive(serde::Deserialize, Default)]
pub struct DeleteQuery {
    #[serde(default)]
    pub scope: RecurrenceScope,
    pub occurrence: Option<chrono::DateTime<chrono::Utc>>,
}

#[derive(serde::Deserialize, Default)]
pub struct UpdateQuery {
    #[serde(default)]
    pub scope: RecurrenceScope,
}

pub async fn list(
    State(state): State<AppState>,
    Extension(user): Extension<CalendarUser>,
    Query(query): Query<EventsQuery>,
) -> Result<Json<serde_json::Value>> {
    let instances = EventService::list(user.id, query, &state.db).await?;
    Ok(Json(serde_json::json!({ "events": instances, "count": instances.len() })))
}

pub async fn create(
    State(state): State<AppState>,
    Extension(user): Extension<CalendarUser>,
    Json(dto): Json<CreateEventDto>,
) -> Result<(StatusCode, Json<serde_json::Value>)> {
    use validator::Validate;
    dto.validate()
        .map_err(|e| crate::errors::CalendarError::Validation(e.to_string()))?;

    let event = EventService::create(user.id, dto, &state.db).await?;

    // Publier l'event vers le core (best-effort)
    let state2 = state.clone();
    let event_id = event.id;
    let user_id = user.id;
    tokio::spawn(async move {
        publisher::publish_event_created(&state2, event_id, user_id).await;
    });

    Ok((StatusCode::CREATED, Json(serde_json::json!({ "event": event }))))
}

pub async fn get(
    State(state): State<AppState>,
    Extension(user): Extension<CalendarUser>,
    Path(id): Path<Uuid>,
) -> Result<Json<serde_json::Value>> {
    let event = EventService::get(id, user.id, &state.db).await?;
    Ok(Json(serde_json::json!({ "event": event })))
}

pub async fn update(
    State(state): State<AppState>,
    Extension(user): Extension<CalendarUser>,
    Path(id): Path<Uuid>,
    Query(q): Query<UpdateQuery>,
    Json(dto): Json<UpdateEventDto>,
) -> Result<Json<serde_json::Value>> {
    let event = EventService::update(id, user.id, dto, q.scope, &state.db).await?;
    // Notifier les personnes avec qui l'événement est partagé.
    {
        let state2 = state.clone();
        let user_id = user.id;
        let title = event.title.clone();
        tokio::spawn(async move {
            publisher::publish_event_modified(&state2, id, user_id, &title, "updated").await;
        });
    }
    Ok(Json(serde_json::json!({ "event": event })))
}

pub async fn delete(
    State(state): State<AppState>,
    Extension(user): Extension<CalendarUser>,
    Path(id): Path<Uuid>,
    Query(q): Query<DeleteQuery>,
) -> Result<StatusCode> {
    let state2 = state.clone();
    let user_id = user.id;
    EventService::delete(id, user.id, q.scope, q.occurrence, &state.db).await?;

    tokio::spawn(async move {
        publisher::publish_event_deleted(&state2, id, user_id).await;
    });

    Ok(StatusCode::NO_CONTENT)
}

pub async fn export_ics(
    State(state): State<AppState>,
    Extension(user): Extension<CalendarUser>,
    Path(id): Path<Uuid>,
) -> Result<([(axum::http::HeaderName, String); 1], String)> {
    let event = EventService::get(id, user.id, &state.db).await?;
    let ics = ICalendarService::event_to_ics(&event, "Kubuno Calendar");

    Ok(([
        (axum::http::header::CONTENT_TYPE, "text/calendar; charset=utf-8".to_string()),
    ], ics))
}
