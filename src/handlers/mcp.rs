//! MCP tool endpoints — thin wrappers the core MCP gateway calls on the user's
//! behalf (identity via the injected `X-Kubuno-User-Id` header, like every other
//! authenticated route) so the assistant (jarvis) can act on the agenda.
//!
//! Tool names use underscores (`calendar_create_event`) because some LLM
//! providers reject dots in tool names. The mapping name → route is declared in
//! `main.rs` at registration (`mcp_tools`).

use axum::{
    extract::{Query, State},
    Extension, Json,
};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use sqlx::PgPool;
use uuid::Uuid;

use crate::{
    errors::Result,
    middleware::CalendarUser,
    models::event::{CreateEventDto, EventsQuery, RecurrenceScope},
    services::event_service::EventService,
    state::AppState,
};

/// Resolve the user's default calendar (first / `is_default`), creating a
/// personal one if none exists — so `create_event` works without the LLM ever
/// knowing a calendar UUID.
async fn default_calendar(user_id: Uuid, db: &PgPool) -> Result<Uuid> {
    if let Some(id) = sqlx::query_scalar::<_, Uuid>(
        "SELECT id FROM calendar.calendars WHERE owner_id = $1 \
         ORDER BY is_default DESC, created_at ASC LIMIT 1",
    )
    .bind(user_id)
    .fetch_optional(db)
    .await?
    {
        return Ok(id);
    }
    let id = sqlx::query_scalar::<_, Uuid>(
        "INSERT INTO calendar.calendars (owner_id, name, color, cal_type, is_default) \
         VALUES ($1, 'Mon calendrier', '#4D38DB', 'personal', TRUE) RETURNING id",
    )
    .bind(user_id)
    .fetch_one(db)
    .await?;
    Ok(id)
}

#[derive(Deserialize)]
pub struct ListEventsArgs {
    pub from:  Option<DateTime<Utc>>,
    pub until: Option<DateTime<Utc>>,
}

/// GET /mcp/list-events — events in a date range (defaults: now → +30 days).
pub async fn list_events(
    State(state): State<AppState>,
    Extension(user): Extension<CalendarUser>,
    Query(args): Query<ListEventsArgs>,
) -> Result<Json<serde_json::Value>> {
    let query = EventsQuery { from: args.from, until: args.until, calendar_id: None };
    let events = EventService::list(user.id, query, &state.db).await?;
    Ok(Json(serde_json::json!({ "count": events.len(), "events": events })))
}

#[derive(Deserialize)]
pub struct CreateEventArgs {
    pub title:       String,
    pub starts_at:   DateTime<Utc>,
    pub ends_at:     DateTime<Utc>,
    #[serde(default)]
    pub all_day:     Option<bool>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub location:    Option<String>,
}

/// POST /mcp/create-event — create an event in the user's default calendar.
pub async fn create_event(
    State(state): State<AppState>,
    Extension(user): Extension<CalendarUser>,
    Json(args): Json<CreateEventArgs>,
) -> Result<Json<serde_json::Value>> {
    let calendar_id = default_calendar(user.id, &state.db).await?;
    let dto = CreateEventDto {
        calendar_id,
        title:       args.title,
        description: args.description,
        location:    args.location,
        url:         None,
        starts_at:   args.starts_at,
        ends_at:     args.ends_at,
        all_day:     args.all_day,
        timezone:    None,
        color:       None,
        rrule:       None,
        reminders:   None,
        status:      None,
        visibility:  None,
        busy:        None,
    };
    let event = EventService::create(user.id, dto, &state.db).await?;
    Ok(Json(serde_json::json!({
        "ok": true,
        "event": { "id": event.id, "title": event.title, "starts_at": event.starts_at, "ends_at": event.ends_at },
    })))
}

#[derive(Deserialize)]
pub struct DeleteEventArgs {
    pub event_id: Uuid,
}

/// POST /mcp/delete-event — delete an event (whole series). Marked `confirm` in
/// the tool annotations so the assistant asks the user before calling it.
pub async fn delete_event(
    State(state): State<AppState>,
    Extension(user): Extension<CalendarUser>,
    Json(args): Json<DeleteEventArgs>,
) -> Result<Json<serde_json::Value>> {
    EventService::delete(args.event_id, user.id, RecurrenceScope::All, None, &state.db).await?;
    Ok(Json(serde_json::json!({ "ok": true, "deleted": args.event_id })))
}
