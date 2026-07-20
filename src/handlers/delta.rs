//! Sync deltas for the local-first pull (calendars / events / time_blocks).
//! Owner-scoped changes past `cursor` (monotonic change_seq) with tombstones.
//! Events (base rows + per-occurrence exception rows) ship their attendees
//! inline (read-only). Scope: the requester's own calendars/blocks; shared
//! calendars are a follow-up.

use axum::{
    extract::{Query, State},
    Extension, Json,
};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::errors::Result;
use crate::middleware::CalendarUser;
use crate::state::AppState;

#[derive(serde::Deserialize)]
pub struct DeltaQuery {
    #[serde(default)]
    cursor: i64,
    limit: Option<i64>,
}

pub async fn calendars_delta(
    State(state): State<AppState>,
    Extension(user): Extension<CalendarUser>,
    Query(q): Query<DeltaQuery>,
) -> Result<Json<Value>> {
    let limit = q.limit.unwrap_or(200).clamp(1, 500);
    let rows: Vec<(Uuid, i64, String)> = sqlx::query_as(
        r#"SELECT id, change_seq, 'live' AS src FROM calendar.calendars WHERE owner_id=$1 AND change_seq>$2
           UNION ALL
           SELECT id, change_seq, 'tomb' AS src FROM calendar.calendar_tombstones WHERE owner_id=$1 AND change_seq>$2
           ORDER BY change_seq LIMIT $3"#,
    )
    .bind(user.id)
    .bind(q.cursor)
    .bind(limit)
    .fetch_all(&state.db)
    .await?;
    let has_more = rows.len() as i64 == limit;
    let new_cursor = rows.last().map(|r| r.1).unwrap_or(q.cursor);
    let mut changes = Vec::with_capacity(rows.len());
    for (id, seq, src) in &rows {
        if src == "tomb" {
            changes.push(json!({ "uuid": id, "kind": "deleted", "change_seq": seq }));
            continue;
        }
        let cal: Option<Value> = sqlx::query_scalar(
            "SELECT to_jsonb(c) FROM (SELECT id, owner_id, name, description, color, cal_type, is_default, \
             is_visible, is_public, timezone, caldav_token, ctag, created_at, updated_at \
             FROM calendar.calendars WHERE id=$1) c",
        )
        .bind(id)
        .fetch_optional(&state.db)
        .await?;
        if let Some(cal) = cal {
            changes.push(json!({ "uuid": id, "kind": "modified", "change_seq": seq, "calendar": cal }));
        }
    }
    Ok(Json(json!({ "changes": changes, "cursor": new_cursor, "has_more": has_more })))
}

pub async fn events_delta(
    State(state): State<AppState>,
    Extension(user): Extension<CalendarUser>,
    Query(q): Query<DeltaQuery>,
) -> Result<Json<Value>> {
    let limit = q.limit.unwrap_or(200).clamp(1, 500);
    // Events of the requester's calendars, plus tombstones (owner-scoped).
    let rows: Vec<(Uuid, i64, String)> = sqlx::query_as(
        r#"SELECT e.id, e.change_seq, 'live' AS src
           FROM calendar.events e JOIN calendar.calendars c ON c.id = e.calendar_id
           WHERE c.owner_id = $1 AND e.change_seq > $2
           UNION ALL
           SELECT id, change_seq, 'tomb' AS src FROM calendar.event_tombstones WHERE owner_id=$1 AND change_seq>$2
           ORDER BY change_seq LIMIT $3"#,
    )
    .bind(user.id)
    .bind(q.cursor)
    .bind(limit)
    .fetch_all(&state.db)
    .await?;
    let has_more = rows.len() as i64 == limit;
    let new_cursor = rows.last().map(|r| r.1).unwrap_or(q.cursor);
    let mut changes = Vec::with_capacity(rows.len());
    for (id, seq, src) in &rows {
        if src == "tomb" {
            changes.push(json!({ "uuid": id, "kind": "deleted", "change_seq": seq }));
            continue;
        }
        let event: Option<Value> = sqlx::query_scalar(
            "SELECT to_jsonb(e) FROM (SELECT id, calendar_id, owner_id, title, description, location, url, \
             starts_at, ends_at, all_day, timezone, color, rrule, exdates, parent_event_id, recurrence_id, \
             reminders, ical_uid, etag, sequence, status, visibility, busy, linked_file_ids, linked_note_id, \
             linked_task_ids, meeting_duration_minutes, created_at, updated_at FROM calendar.events WHERE id=$1) e",
        )
        .bind(id)
        .fetch_optional(&state.db)
        .await?;
        let Some(event) = event else { continue };
        let attendees: Vec<Value> = sqlx::query_scalar(
            "SELECT to_jsonb(a) FROM (SELECT id, event_id, user_id, email, display_name, status, is_organizer, \
             invited_at, responded_at, comment FROM calendar.attendees WHERE event_id=$1) a",
        )
        .bind(id)
        .fetch_all(&state.db)
        .await?;
        changes.push(json!({ "uuid": id, "kind": "modified", "change_seq": seq, "event": event, "attendees": attendees }));
    }
    Ok(Json(json!({ "changes": changes, "cursor": new_cursor, "has_more": has_more })))
}

pub async fn time_blocks_delta(
    State(state): State<AppState>,
    Extension(user): Extension<CalendarUser>,
    Query(q): Query<DeltaQuery>,
) -> Result<Json<Value>> {
    let limit = q.limit.unwrap_or(200).clamp(1, 500);
    let rows: Vec<(Uuid, i64, String)> = sqlx::query_as(
        r#"SELECT id, change_seq, 'live' AS src FROM calendar.time_blocks WHERE owner_id=$1 AND change_seq>$2
           UNION ALL
           SELECT id, change_seq, 'tomb' AS src FROM calendar.time_block_tombstones WHERE owner_id=$1 AND change_seq>$2
           ORDER BY change_seq LIMIT $3"#,
    )
    .bind(user.id)
    .bind(q.cursor)
    .bind(limit)
    .fetch_all(&state.db)
    .await?;
    let has_more = rows.len() as i64 == limit;
    let new_cursor = rows.last().map(|r| r.1).unwrap_or(q.cursor);
    let mut changes = Vec::with_capacity(rows.len());
    for (id, seq, src) in &rows {
        if src == "tomb" {
            changes.push(json!({ "uuid": id, "kind": "deleted", "change_seq": seq }));
            continue;
        }
        let tb: Option<Value> = sqlx::query_scalar(
            "SELECT to_jsonb(t) FROM (SELECT id, owner_id, label, color, days, start_time, end_time, priority, \
             is_active, created_at, updated_at FROM calendar.time_blocks WHERE id=$1) t",
        )
        .bind(id)
        .fetch_optional(&state.db)
        .await?;
        if let Some(tb) = tb {
            changes.push(json!({ "uuid": id, "kind": "modified", "change_seq": seq, "time_block": tb }));
        }
    }
    Ok(Json(json!({ "changes": changes, "cursor": new_cursor, "has_more": has_more })))
}
