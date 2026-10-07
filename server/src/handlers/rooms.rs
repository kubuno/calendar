//! Inviting a room to an event.
//!
//! Kept apart from `attendees.rs` on purpose. That path is built around an
//! address: it validates the e-mail, counts the guest list against the
//! instance ceiling, and asks the directory whether the person is external. A
//! room has no mailbox, does not count as a guest, and is never external — it
//! answers to a different set of rules, and folding the two together would have
//! meant a handler full of "unless it is a room".

use axum::{
    extract::{Path, State},
    http::StatusCode,
    Extension, Json,
};
use serde::Deserialize;
use uuid::Uuid;

use crate::errors::{CalendarError, Result};
use crate::middleware::CalendarUser;
use crate::services::room_service::RoomService;
use crate::state::AppState;

#[derive(Debug, Deserialize)]
pub struct InviteRoomDto {
    pub resource_id: Uuid,
}

/// `GET /rooms` — the rooms an organiser may pick from.
///
/// The core's catalogue is an INTERNAL endpoint: it is proved with the instance
/// secret, which a browser must never hold. This is the door that lets a signed-in
/// person see the same list — the module reads the catalogue on their behalf and
/// passes on only what a booking needs. It stays read-only for the same reason
/// the internal one is: what rooms exist is the administrator's decision.
pub async fn list(
    State(state): State<AppState>,
    Extension(_user): Extension<CalendarUser>,
) -> Result<Json<serde_json::Value>> {
    let rooms = RoomService::catalogue(
        &state.http,
        &state.settings.core.url,
        &state.settings.core.internal_secret,
    )
    .await
    .ok_or_else(|| {
        CalendarError::Validation(
            "Le catalogue des salles est momentanément indisponible — réessayez".into(),
        )
    })?;

    Ok(Json(serde_json::json!({ "rooms": rooms })))
}

/// `GET /rooms/availability?from&to[&rrule][&timezone][&event_id]` — which rooms
/// are free for a slot, and what holds the others.
///
/// Asked BEFORE the meeting exists. Someone composing an invitation picks the
/// hour first and the room second; a list that cannot say which rooms are free
/// asks them to choose blind and be refused. `event_id` is the meeting being
/// edited, so that it is not counted as holding the room against itself.
#[derive(Debug, Deserialize)]
pub struct AvailabilityQuery {
    pub from: chrono::DateTime<chrono::Utc>,
    pub to:   chrono::DateTime<chrono::Utc>,
    #[serde(default)]
    pub rrule:    Option<String>,
    #[serde(default)]
    pub timezone: Option<String>,
    #[serde(default)]
    pub event_id: Option<Uuid>,
}

pub async fn availability(
    State(state): State<AppState>,
    Extension(_user): Extension<CalendarUser>,
    axum::extract::Query(q): axum::extract::Query<AvailabilityQuery>,
) -> Result<Json<serde_json::Value>> {
    if q.to <= q.from {
        return Err(CalendarError::Validation(
            "La fin de la réunion doit suivre son début".into(),
        ));
    }
    let rooms = RoomService::catalogue(
        &state.http,
        &state.settings.core.url,
        &state.settings.core.internal_secret,
    )
    .await
    .ok_or_else(|| {
        CalendarError::Validation(
            "Le catalogue des salles est momentanément indisponible — réessayez".into(),
        )
    })?;

    let ids: Vec<Uuid> = rooms.iter().map(|r| r.id).collect();
    let slot = RoomService::draft(q.event_id, q.from, q.to, q.rrule, q.timezone);
    let busy = RoomService::availability(&state.db, &ids, &slot).await?;

    let out: Vec<serde_json::Value> = rooms
        .iter()
        .map(|r| {
            let clashes = busy.get(&r.id);
            serde_json::json!({
                "id":             r.id,
                "generated_name": r.generated_name,
                "name":           r.name,
                "capacity":       r.capacity,
                "floor_name":     r.floor_name,
                "floor_section":  r.floor_section,
                "features":       r.features,
                "building":       r.building,
                // The answer the list is drawn from. `held_by` names the meeting
                // in the way: "unavailable" alone leaves the reader with nothing
                // to act on, "held by the weekly review" lets them ask.
                "free":           clashes.is_none(),
                "held_by":        clashes.and_then(|c| c.first()).map(|c| serde_json::json!({
                    "title":     c.title,
                    "starts_at": c.starts_at,
                    "ends_at":   c.ends_at,
                })),
            })
        })
        .collect();

    Ok(Json(serde_json::json!({ "rooms": out })))
}

/// `POST /events/:id/rooms` — put a room on the guest list.
///
/// The answer says what the room replied. A taken room is added and **declines**
/// rather than the request failing: the meeting is not the room's to cancel, and
/// the organiser reads the refusal where they read everyone else's answer. The
/// clashes come back with it so the console can say *why* — "held by the weekly
/// review, Tuesdays 10:00" is actionable, "unavailable" is not.
pub async fn invite(
    State(state): State<AppState>,
    Extension(user): Extension<CalendarUser>,
    Path(event_id): Path<Uuid>,
    Json(dto): Json<InviteRoomDto>,
) -> Result<(StatusCode, Json<serde_json::Value>)> {
    let event = RoomService::require_owner(&state.db, event_id, user.id).await?;

    let room = RoomService::fetch(
        &state.http,
        &state.settings.core.url,
        &state.settings.core.internal_secret,
        dto.resource_id,
    )
    .await
    .ok_or_else(|| {
        CalendarError::Validation(
            "Cette salle est introuvable dans l'annuaire — elle a peut-être été retirée".into(),
        )
    })?;

    let clashes = RoomService::invite(&state.db, &event, &room).await?;
    let accepted = clashes.is_empty();

    Ok((
        StatusCode::CREATED,
        Json(serde_json::json!({
            "resource_id": room.id,
            "name":        room.generated_name,
            "capacity":    room.capacity,
            "status":      if accepted { "accepted" } else { "declined" },
            "clashes":     clashes,
        })),
    ))
}

/// `DELETE /events/:id/rooms/:resource_id` — free the room.
pub async fn remove(
    State(state): State<AppState>,
    Extension(user): Extension<CalendarUser>,
    Path((event_id, resource_id)): Path<(Uuid, Uuid)>,
) -> Result<StatusCode> {
    RoomService::require_owner(&state.db, event_id, user.id).await?;
    RoomService::remove(&state.db, event_id, resource_id).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// `GET /ipc/room-stats?from=…&to=…` — what the rooms were used for.
///
/// Internal: the console asks through the core's relay, proving itself with the
/// instance secret. The bookings are rows of this module's own schema, which the
/// core does not read — so the module counts and answers with figures.
///
/// The window is required and bounded by the caller. There is no default: a
/// dashboard that silently picks "this month" reports a different thing from the
/// one the operator thinks they asked for.
///
/// `tz` is the zone the DAY and HOUR buckets are cut in. It matters more than it
/// looks: bucketed in UTC, a nine o'clock meeting in Paris lands in the eight
/// o'clock column and an early booking in Tokyo lands on the previous day. The
/// instants are unchanged — only where the knife falls. Unknown or absent, the
/// zone is UTC, which is at least stated rather than guessed.
#[derive(Debug, Deserialize)]
pub struct StatsQuery {
    pub from: chrono::DateTime<chrono::Utc>,
    pub to:   chrono::DateTime<chrono::Utc>,
    #[serde(default)]
    pub tz:   Option<String>,
}

pub async fn stats(
    State(state): State<AppState>,
    axum::extract::Query(q): axum::extract::Query<StatsQuery>,
) -> Result<Json<serde_json::Value>> {
    if q.to <= q.from {
        return Err(CalendarError::Validation(
            "La fin de la période doit suivre son début".into(),
        ));
    }
    let tz: chrono_tz::Tz = q
        .tz
        .as_deref()
        .and_then(|z| z.parse().ok())
        .unwrap_or(chrono_tz::UTC);
    let stats = crate::services::room_stats_service::RoomStatsService::compute(
        &state.db,
        &state.http,
        &state.settings.core.url,
        &state.settings.core.internal_secret,
        q.from,
        q.to,
        tz,
    )
    .await?;
    Ok(Json(serde_json::to_value(stats).unwrap_or_default()))
}
