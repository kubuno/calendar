//! Delta-sync plumbing shared by the services and the delta handler.
//!
//! The local-first pull (calendars / events / time_blocks) rests on a monotonic
//! `change_seq` per record and a tombstone per deletion. On PostgreSQL that used
//! to be a `SEQUENCE` plus `BEFORE UPDATE` / `AFTER DELETE` triggers; here it is
//! the portable [`kubuno_db::journal`] primitive, driven from Rust at every
//! write site. This module holds the literal table / domain names those calls
//! take — all `&'static str`, never request data — so the write sites read
//! uniformly and a rename happens in one place.
//!
//! Three entities are versioned: **calendars**, **events** and **time_blocks**,
//! each with its own tombstone table. Attendees carry no sequence of their own;
//! they ride inline in the event delta and bump their parent event (the portable
//! replacement for the old `att_bump_event` trigger) — see [`touch_event`].

use uuid::Uuid;

/// One shared counter table per schema; `next_seq` keys it by domain.
pub const CHANGE_COUNTER: &str = "calendar.change_counter";

pub const CALENDARS_TABLE: &str = "calendar.calendars";
pub const EVENTS_TABLE: &str = "calendar.events";
pub const TIME_BLOCKS_TABLE: &str = "calendar.time_blocks";

pub const CALENDAR_TOMBSTONES: &str = "calendar.calendar_tombstones";
pub const EVENT_TOMBSTONES: &str = "calendar.event_tombstones";
pub const TIME_BLOCK_TOMBSTONES: &str = "calendar.time_block_tombstones";

/// Logical counter domains (the row keys in `change_counter`).
pub const CALENDAR_DOMAIN: &str = "calendars";
pub const EVENT_DOMAIN: &str = "events";
pub const TIME_BLOCK_DOMAIN: &str = "time_blocks";

/// A fresh opaque resource tag, replacing the non-portable `md5(random()::text)`
/// the migrations used. 32 lowercase hex chars, fitting the `VARCHAR(64)` etag,
/// ctag and caldav_token columns on every engine.
pub fn new_tag() -> String {
    Uuid::new_v4().simple().to_string()
}

/// The next monotonic sequence for the **calendars** domain, taken inside `tx`.
pub async fn next_calendar_seq(tx: &mut kubuno_db::DbTx) -> Result<i64, sqlx::Error> {
    kubuno_db::journal::next_seq(tx, CHANGE_COUNTER, CALENDAR_DOMAIN).await
}

/// The next monotonic sequence for the **events** domain, taken inside `tx`.
pub async fn next_event_seq(tx: &mut kubuno_db::DbTx) -> Result<i64, sqlx::Error> {
    kubuno_db::journal::next_seq(tx, CHANGE_COUNTER, EVENT_DOMAIN).await
}

/// The next monotonic sequence for the **time_blocks** domain, taken inside `tx`.
pub async fn next_time_block_seq(tx: &mut kubuno_db::DbTx) -> Result<i64, sqlx::Error> {
    kubuno_db::journal::next_seq(tx, CHANGE_COUNTER, TIME_BLOCK_DOMAIN).await
}

/// Bumps an **event** to a fresh sequence — the portable replacement for the old
/// `att_bump_event` trigger's no-op `UPDATE ... SET change_seq = change_seq`.
/// Called after any write to an attendee of that event, so the event resurfaces
/// in the next delta pull carrying its refreshed guest list.
pub async fn touch_event(tx: &mut kubuno_db::DbTx, event_id: Uuid) -> Result<(), sqlx::Error> {
    kubuno_db::journal::touch(tx, EVENTS_TABLE, CHANGE_COUNTER, EVENT_DOMAIN, "id", event_id)
        .await
        .map(|_| ())
}
