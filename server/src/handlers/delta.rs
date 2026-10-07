//! Sync deltas for the local-first pull (calendars / events / time_blocks):
//! owner-scoped changes past `cursor` (monotonic change_seq), live rows +
//! tombstones, ordered, paginated. `kind ∈ modified | deleted`. Event changes
//! carry their attendees inline (read-only).
//!
//! The change feed comes from `kubuno_db::journal::changes_since` (the portable
//! `live UNION ALL tombstones` the module used to build by hand); the live rows
//! are then fetched by id with `DbQueryBuilder::push_in`, which renders the
//! `IN (...)` list — and `IN (NULL)` for an empty page — on every engine. The
//! per-row JSON that PostgreSQL built with `to_jsonb(...)` is now the serialised
//! model struct, identical across the three engines.

use axum::{
    extract::{Query, State},
    Extension, Json,
};
use kubuno_db::{journal::Change, DbQueryBuilder};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::{
    errors::Result,
    middleware::CalendarUser,
    models::{attendee::Attendee, calendar::Calendar, event::Event, time_block::TimeBlock},
    state::AppState,
    sync,
};

#[derive(serde::Deserialize)]
pub struct DeltaQuery {
    #[serde(default)]
    cursor: i64,
    limit: Option<i64>,
}

/// `SELECT * FROM <table> WHERE <key> IN (<ids>) [ORDER BY <order>]`, built so
/// the `IN` list (or `IN (NULL)` when empty) is spelled for the pool's engine.
async fn select_in<T: kubuno_db::FromAnyRow>(
    state: &AppState,
    select: &str,
    key: &str,
    ids: &[Uuid],
    order: &'static str,
) -> Result<Vec<T>> {
    let mut qb = DbQueryBuilder::new(state.db.backend(), select);
    qb.push(" WHERE ").push(key).push_in(ids.iter().copied());
    if !order.is_empty() {
        qb.push(order);
    }
    Ok(qb.fetch_all_as::<T>(&state.db).await?)
}

fn cursor_and_more(changes: &[Change], prev: i64, limit: i64) -> (i64, bool) {
    let has_more = changes.len() as i64 == limit;
    let new_cursor = changes.last().map(|c| c.change_seq).unwrap_or(prev);
    (new_cursor, has_more)
}

/// GET /calendars/delta
pub async fn calendars_delta(
    State(state): State<AppState>,
    Extension(user): Extension<CalendarUser>,
    Query(q): Query<DeltaQuery>,
) -> Result<Json<Value>> {
    let limit = q.limit.unwrap_or(200).clamp(1, 500);
    let changes = kubuno_db::journal::changes_since(
        &state.db, sync::CALENDARS_TABLE, sync::CALENDAR_TOMBSTONES, user.id, q.cursor, limit,
    )
    .await?;
    let (new_cursor, has_more) = cursor_and_more(&changes, q.cursor, limit);
    let live_ids: Vec<Uuid> = changes.iter().filter(|c| !c.deleted).map(|c| c.id).collect();

    let calendars: Vec<Calendar> =
        select_in(&state, "SELECT * FROM calendar.calendars", "id", &live_ids, "").await?;
    let cal_map: std::collections::HashMap<Uuid, &Calendar> =
        calendars.iter().map(|c| (c.id, c)).collect();

    let mut out = Vec::with_capacity(changes.len());
    for c in &changes {
        if c.deleted {
            out.push(json!({ "uuid": c.id, "kind": "deleted", "change_seq": c.change_seq }));
        } else if let Some(cal) = cal_map.get(&c.id) {
            out.push(json!({ "uuid": c.id, "kind": "modified", "change_seq": c.change_seq, "calendar": cal }));
        }
    }
    Ok(Json(json!({ "changes": out, "cursor": new_cursor, "has_more": has_more })))
}

/// GET /events/delta
pub async fn events_delta(
    State(state): State<AppState>,
    Extension(user): Extension<CalendarUser>,
    Query(q): Query<DeltaQuery>,
) -> Result<Json<Value>> {
    let limit = q.limit.unwrap_or(200).clamp(1, 500);
    let changes = kubuno_db::journal::changes_since(
        &state.db, sync::EVENTS_TABLE, sync::EVENT_TOMBSTONES, user.id, q.cursor, limit,
    )
    .await?;
    let (new_cursor, has_more) = cursor_and_more(&changes, q.cursor, limit);
    let live_ids: Vec<Uuid> = changes.iter().filter(|c| !c.deleted).map(|c| c.id).collect();

    let events: Vec<Event> =
        select_in(&state, "SELECT * FROM calendar.events", "id", &live_ids, "").await?;
    let attendees: Vec<Attendee> = select_in(
        &state, "SELECT * FROM calendar.attendees", "event_id", &live_ids, " ORDER BY invited_at",
    )
    .await?;

    let mut att_map: std::collections::HashMap<Uuid, Vec<&Attendee>> = Default::default();
    for a in &attendees {
        att_map.entry(a.event_id).or_default().push(a);
    }
    let event_map: std::collections::HashMap<Uuid, &Event> = events.iter().map(|e| (e.id, e)).collect();

    let empty_a: Vec<&Attendee> = Vec::new();
    let mut out = Vec::with_capacity(changes.len());
    for c in &changes {
        if c.deleted {
            out.push(json!({ "uuid": c.id, "kind": "deleted", "change_seq": c.change_seq }));
        } else if let Some(e) = event_map.get(&c.id) {
            out.push(json!({
                "uuid": c.id,
                "kind": "modified",
                "change_seq": c.change_seq,
                "event": e,
                "attendees": att_map.get(&c.id).unwrap_or(&empty_a),
            }));
        }
    }
    Ok(Json(json!({ "changes": out, "cursor": new_cursor, "has_more": has_more })))
}

/// GET /time-blocks/delta
pub async fn time_blocks_delta(
    State(state): State<AppState>,
    Extension(user): Extension<CalendarUser>,
    Query(q): Query<DeltaQuery>,
) -> Result<Json<Value>> {
    let limit = q.limit.unwrap_or(200).clamp(1, 500);
    let changes = kubuno_db::journal::changes_since(
        &state.db, sync::TIME_BLOCKS_TABLE, sync::TIME_BLOCK_TOMBSTONES, user.id, q.cursor, limit,
    )
    .await?;
    let (new_cursor, has_more) = cursor_and_more(&changes, q.cursor, limit);
    let live_ids: Vec<Uuid> = changes.iter().filter(|c| !c.deleted).map(|c| c.id).collect();

    let blocks: Vec<TimeBlock> =
        select_in(&state, "SELECT * FROM calendar.time_blocks", "id", &live_ids, "").await?;
    let tb_map: std::collections::HashMap<Uuid, &TimeBlock> =
        blocks.iter().map(|t| (t.id, t)).collect();

    let mut out = Vec::with_capacity(changes.len());
    for c in &changes {
        if c.deleted {
            out.push(json!({ "uuid": c.id, "kind": "deleted", "change_seq": c.change_seq }));
        } else if let Some(tb) = tb_map.get(&c.id) {
            out.push(json!({ "uuid": c.id, "kind": "modified", "change_seq": c.change_seq, "time_block": tb }));
        }
    }
    Ok(Json(json!({ "changes": out, "cursor": new_cursor, "has_more": has_more })))
}
