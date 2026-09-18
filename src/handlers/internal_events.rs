//! Core → module event delivery (the `/ipc/events` receiver).
//!
//! The core POSTs every subscribed event here as the bare `AppEvent`
//! (`{ "type": …, "payload": { … } }`), guarded by `X-Internal-Secret`. This
//! module only acts on `mail.invite_reply`, the RSVP reply the Mail module
//! relays when a guest answers an invitation e-mail; every other event is
//! acknowledged without side effects.
//!
//! A malformed payload is dropped with a `200 ok`, never rejected: the core
//! retries a failure up to five times, and no retry can fix a producer's
//! mistake.

use axum::{extract::State, Json};
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::{errors::Result, state::AppState};

/// The envelope every delivered event arrives in.
#[derive(Deserialize)]
pub struct KubunoEvent {
    #[serde(rename = "type")]
    pub event_type: String,
    pub payload:    Value,
}

/// The inner payload of a `mail.invite_reply` event.
#[derive(Deserialize)]
struct InviteReply {
    event_uid:         String,
    attendee_email:    String,
    partstat:          String,
    sequence:          i32,
    organizer_user_id: Uuid,
    #[serde(default)]
    comment:           Option<String>,
}

const INVITE_REPLY: &str = "mail.invite_reply";
const MEETING_RENAMED: &str = "chat.meeting_renamed";

/// A meeting attached to one of our events was renamed where it lives.
#[derive(Deserialize)]
struct MeetingRenamed {
    /// `<module>:<id>` — ours to recognise, opaque to everyone else.
    owner: String,
    title: String,
}

/// Rename the event a meeting belongs to.
///
/// Only when the title actually differs: an update that changes nothing writes
/// no row and announces nothing back, which is what keeps the two modules from
/// renaming each other in turn for ever.
async fn apply_rename(state: &AppState, body: Value) -> Result<()> {
    let r: MeetingRenamed = match serde_json::from_value(body) {
        Ok(v) => v,
        Err(e) => {
            tracing::warn!(error = %e, "meeting_renamed: charge utile illisible, ignorée");
            return Ok(());
        }
    };
    let title = r.title.trim();
    let Some(event_id) = crate::events::publisher::owned_event(&r.owner) else { return Ok(()) };
    if title.is_empty() {
        return Ok(());
    }

    let changed = sqlx::query(
        "UPDATE calendar.events
            SET title = $2, updated_at = NOW()
          WHERE id = $1 AND title IS DISTINCT FROM $2",
    )
    .bind(event_id)
    .bind(title)
    .execute(&state.db)
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "meeting_renamed: renommage de l'événement");
        e
    })?
    .rows_affected();

    if changed > 0 {
        tracing::info!(%event_id, "Événement renommé d'après sa réunion");
    }
    Ok(())
}

/// Handles one delivered event.
pub async fn handle_event(
    State(state): State<AppState>,
    Json(event): Json<KubunoEvent>,
) -> Result<Json<Value>> {
    // Only `Custom` carries a module's own event; its real name is inside.
    if event.event_type != "Custom" {
        return Ok(Json(json!({ "ok": true })));
    }
    let inner_type = event.payload.get("event_type").and_then(Value::as_str).unwrap_or("");
    if inner_type == MEETING_RENAMED {
        if let Some(body) = event.payload.get("payload") {
            apply_rename(&state, body.clone()).await?;
        }
        return Ok(Json(json!({ "ok": true })));
    }
    if inner_type != INVITE_REPLY {
        return Ok(Json(json!({ "ok": true })));
    }

    let body = match event.payload.get("payload") {
        Some(p) => p.clone(),
        None    => return Ok(Json(json!({ "ok": true }))),
    };
    let reply: InviteReply = match serde_json::from_value(body) {
        Ok(v) => v,
        Err(e) => {
            tracing::warn!(error = %e, "invite_reply: charge utile illisible, ignorée");
            return Ok(Json(json!({ "ok": true, "updated": 0 })));
        }
    };

    // Validate inputs before touching the database.
    let event_uid = reply.event_uid.trim();
    let attendee_email = reply.attendee_email.trim();
    if event_uid.is_empty() || attendee_email.is_empty() {
        tracing::warn!("invite_reply: event_uid ou attendee_email vide, ignoré");
        return Ok(Json(json!({ "ok": true, "updated": 0 })));
    }

    // PARTSTAT → the internal status vocabulary (matches the attendees CHECK).
    let status = match reply.partstat.to_ascii_uppercase().as_str() {
        "ACCEPTED"  => "accepted",
        "DECLINED"  => "declined",
        "TENTATIVE" => "tentative",
        _           => "needs-action",
    };

    // Apply the reply, scoped to the organizer's own event, and drop it when it
    // answers an invitation older than the last one we notified this attendee at
    // (a stale reply to a superseded invitation).
    let affected = sqlx::query(
        r#"
        UPDATE calendar.attendees a
           SET status = $1, responded_at = NOW(), comment = COALESCE($2, a.comment)
          FROM calendar.events e
         WHERE a.event_id = e.id
           AND e.ical_uid = $3
           AND e.owner_id = $4
           AND lower(a.email) = lower($5)
           AND $6 >= COALESCE(a.last_notified_sequence, 0)
        "#,
    )
    .bind(status)
    .bind(&reply.comment)
    .bind(event_uid)
    .bind(reply.organizer_user_id)
    .bind(attendee_email)
    .bind(reply.sequence)
    .execute(&state.db)
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "invite_reply: mise à jour du statut de participation");
        e
    })?
    .rows_affected();

    if affected == 0 {
        // Not an error: the event may have been deleted, the address may not be
        // on the guest list, or the reply is stale. Nothing to retry.
        tracing::debug!(
            event_uid = %event_uid,
            "invite_reply: aucun participant correspondant (supprimé, inconnu ou périmé)"
        );
    }

    Ok(Json(json!({ "ok": true, "updated": affected })))
}
