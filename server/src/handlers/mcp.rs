//! MCP tool endpoints — thin wrappers the core MCP gateway calls on the user's
//! behalf (identity via the injected `X-Kubuno-User-Id` header, like every other
//! authenticated route) so the assistant module can act on the agenda.
//!
//! Tool names use underscores (`calendar_create_event`) because some LLM
//! providers reject dots in tool names. The mapping name → route is declared in
//! `main.rs` at registration (`mcp_tools`).

use axum::{
    extract::{Query, State},
    Extension, Json,
};
use chrono::{DateTime, NaiveDate, NaiveDateTime, Utc};
use kubuno_db::{params, DbPool};
use serde::Deserialize;
use uuid::Uuid;

/// Flexible date-time parser for tool arguments: LLMs frequently emit a *naive*
/// ISO string without a timezone (e.g. `2026-06-28T16:00:00`). `DateTime<Utc>`'s
/// default serde expects an offset and otherwise fails with the confusing
/// "premature end of input". Accept RFC 3339 (with offset/Z) AND common naive
/// forms, treating the latter as UTC.
fn parse_flexible_dt(s: &str) -> Option<DateTime<Utc>> {
    let s = s.trim();
    if let Ok(dt) = DateTime::parse_from_rfc3339(s) {
        return Some(dt.with_timezone(&Utc));
    }
    for fmt in ["%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M"] {
        if let Ok(ndt) = NaiveDateTime::parse_from_str(s, fmt) {
            return Some(DateTime::from_naive_utc_and_offset(ndt, Utc));
        }
    }
    if let Ok(d) = NaiveDate::parse_from_str(s, "%Y-%m-%d") {
        return Some(DateTime::from_naive_utc_and_offset(d.and_hms_opt(0, 0, 0)?, Utc));
    }
    None
}

fn de_flexible_dt<'de, D>(de: D) -> std::result::Result<DateTime<Utc>, D::Error>
where D: serde::Deserializer<'de> {
    let s = String::deserialize(de)?;
    parse_flexible_dt(&s).ok_or_else(|| serde::de::Error::custom(format!("date-heure invalide: « {s} »")))
}

use crate::{
    errors::Result,
    middleware::CalendarUser,
    models::event::{CreateEventDto, EventsQuery, RecurrenceScope},
    services::event_service::EventService,
    state::AppState,
    sync,
};

/// Resolve the user's default calendar (first / `is_default`), creating a
/// personal one if none exists — so `create_event` works without the LLM ever
/// knowing a calendar UUID.
async fn default_calendar(user_id: Uuid, db: &DbPool) -> Result<Uuid> {
    if let Some(id) = db
        .fetch_optional_scalar::<Uuid>(
            "SELECT id FROM calendar.calendars WHERE owner_id = $1 \
             ORDER BY is_default DESC, created_at ASC LIMIT 1",
            params![user_id],
        )
        .await?
    {
        return Ok(id);
    }
    // First calendar: a versioned insert (id/token/ctag supplied — no cross-engine
    // DEFAULT — and its change_seq taken from the journal).
    let id = kubuno_db::new_id();
    let mut tx = db.begin().await?;
    let seq = sync::next_calendar_seq(&mut tx).await?;
    tx.execute(
        "INSERT INTO calendar.calendars
           (id, owner_id, name, color, cal_type, is_default, caldav_token, ctag, change_seq)
         VALUES ($1, $2, 'Mon calendrier', '#4D38DB', 'personal', TRUE, $3, $4, $5)",
        params![id, user_id, sync::new_tag(), sync::new_tag(), seq],
    )
    .await?;
    tx.commit().await?;
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
    #[serde(deserialize_with = "de_flexible_dt")]
    pub starts_at:   DateTime<Utc>,
    #[serde(deserialize_with = "de_flexible_dt")]
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
                id: None,
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
        attendees:   None,
        guests_can_modify:     None,
        guests_can_invite:     None,
        guests_can_see_guests: None,
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
