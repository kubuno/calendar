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
use chrono::Utc;
use kubuno_db::params;
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::{errors::Result, state::AppState, sync};

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

    // `title` is NOT NULL, so `IS DISTINCT FROM` (unportable — MariaDB spells it
    // `<=>`) is just `<>`. The rename is a versioned write: bump the event only
    // when the title actually changes (so a no-op does not churn the delta). The
    // seq is taken inside the tx, so a rolled-back no-op does not consume it. The
    // `updated_at` trigger keeps that column fresh on every engine.
    let mut tx = state.db.begin().await?;
    let seq = sync::next_event_seq(&mut tx).await?;
    let changed = tx
        .execute(
            "UPDATE calendar.events SET title = $1, change_seq = $2 WHERE id = $3 AND title <> $4",
            params![title, seq, event_id, title],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "meeting_renamed: renommage de l'événement");
            e
        })?;
    if changed > 0 {
        tx.commit().await?;
        tracing::info!(%event_id, "Événement renommé d'après sa réunion");
    } else {
        tx.rollback().await?;
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
    // (a stale reply to a superseded invitation). `UPDATE ... FROM` has no
    // portable form (MySQL/SQLite spell the join differently), so the matching
    // row is located first, then updated by its primary key.
    let target: Option<(Uuid, Uuid)> = state
        .db
        .fetch_optional_as(
            r#"
            SELECT a.id, a.event_id
              FROM calendar.attendees a
              JOIN calendar.events e ON a.event_id = e.id
             WHERE e.ical_uid = $1
               AND e.owner_id = $2
               AND lower(a.email) = lower($3)
               AND $4 >= COALESCE(a.last_notified_sequence, 0)
            "#,
            params![event_uid, reply.organizer_user_id, attendee_email, reply.sequence],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "invite_reply: recherche du participant");
            e
        })?;

    let affected = if let Some((attendee_id, ev_id)) = target {
        let mut tx = state.db.begin().await?;
        tx.execute(
            "UPDATE calendar.attendees SET status = $1, responded_at = $2, comment = COALESCE($3, comment) WHERE id = $4",
            params![status, Utc::now(), reply.comment.clone(), attendee_id],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "invite_reply: mise à jour du statut de participation");
            e
        })?;
        // Attendee write bumps its event so the change reaches the event delta.
        sync::touch_event(&mut tx, ev_id).await?;
        tx.commit().await?;
        1u64
    } else {
        0
    };

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
