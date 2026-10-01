use axum::{
    extract::{Path, State},
    Json,
};
use chrono::Utc;
use kubuno_db::params;

use crate::{
    errors::{CalendarError, Result},
    models::attendee::{Attendee, RsvpDto},
    models::calendar::Calendar,
    models::event::Event,
    models::scheduling::PollRespondDto,
    services::{
        icalendar_service::ICalendarService,
        scheduling_service::SchedulingService,
    },
    state::AppState,
    sync,
};

/// Information about an RSVP (from the e-mail link)
pub async fn rsvp_info(
    State(state): State<AppState>,
    Path(token): Path<String>,
) -> Result<Json<serde_json::Value>> {
    let attendee = state
        .db
        .fetch_optional_as::<Attendee>(
            "SELECT a.* FROM calendar.attendees a \
             WHERE a.rsvp_token = $1 AND (a.rsvp_expires_at IS NULL OR a.rsvp_expires_at > $2)",
            params![token, Utc::now()],
        )
        .await?
        .ok_or_else(|| CalendarError::NotFound("Lien RSVP invalide ou expiré".to_string()))?;

    let event = state
        .db
        .fetch_optional_as::<Event>("SELECT * FROM calendar.events WHERE id = $1", params![attendee.event_id])
        .await?
        .ok_or_else(|| CalendarError::NotFound("Événement introuvable".to_string()))?;

    Ok(Json(serde_json::json!({
        "attendee": attendee,
        "event":    {
            "id":          event.id,
            "title":       event.title,
            "description": event.description,
            "location":    event.location,
            "starts_at":   event.starts_at,
            "ends_at":     event.ends_at,
        }
    })))
}

/// RSVP response from the e-mail link (no authentication)
pub async fn rsvp_respond(
    State(state): State<AppState>,
    Path(token): Path<String>,
    Json(dto): Json<RsvpDto>,
) -> Result<Json<serde_json::Value>> {
    let valid = ["needs-action", "accepted", "declined", "tentative"];
    if !valid.contains(&dto.status.as_str()) {
        return Err(CalendarError::Validation(format!("Statut invalide: {}", dto.status)));
    }

    // Locate the (unexpired) attendee first — the event id is needed to bump the
    // event, and the guarded update has no portable `RETURNING`.
    let target: Option<(uuid::Uuid, uuid::Uuid)> = state
        .db
        .fetch_optional_as(
            "SELECT id, event_id FROM calendar.attendees \
             WHERE rsvp_token = $1 AND (rsvp_expires_at IS NULL OR rsvp_expires_at > $2)",
            params![token, Utc::now()],
        )
        .await?;
    let (attendee_id, event_id) =
        target.ok_or_else(|| CalendarError::NotFound("Lien RSVP invalide ou expiré".to_string()))?;

    let mut tx = state.db.begin().await?;
    tx.execute(
        "UPDATE calendar.attendees SET status = $1, comment = $2, responded_at = $3 WHERE id = $4",
        params![&dto.status, dto.comment, Utc::now(), attendee_id],
    )
    .await?;
    sync::touch_event(&mut tx, event_id).await?;
    tx.commit().await?;

    let attendee = state
        .db
        .fetch_one_as::<Attendee>("SELECT * FROM calendar.attendees WHERE id = $1", params![attendee_id])
        .await?;

    // A refusal that empties the meeting hands the room back.
    if dto.status == "declined" {
        let instance = state.instance();
        let released = crate::services::room_service::RoomService::release_if_deserted(
            &state.db,
            &state.http,
            &state.settings.core.url,
            &state.settings.core.internal_secret,
            attendee.event_id,
            |email| instance.domain_is_internal(email),
        )
        .await;
        if let Err(e) = &released {
            tracing::warn!(error = %e, event_id = %attendee.event_id, "Libération de salle : échec");
        }

        if let Ok(Ok(freed)) = &released {
            if !freed.is_empty() {
                let title: Option<String> = state
                    .db
                    .fetch_optional_scalar("SELECT title FROM calendar.events WHERE id = $1", params![attendee.event_id])
                    .await?;
                if let Some(title) = title {
                    crate::events::publisher::publish_event_modified(
                        &state, attendee.event_id, attendee.user_id.unwrap_or_default(), &title, "updated",
                    )
                    .await;
                }
            }
        }
    }

    Ok(Json(serde_json::json!({ "attendee": attendee, "message": "Réponse enregistrée" })))
}

/// Standalone RSVP page (minimal HTML, no shell nor authentication).
#[derive(serde::Deserialize)]
pub struct RsvpPageQuery {
    pub answer: Option<String>,
}

pub async fn rsvp_page(
    State(state): State<AppState>,
    Path(token): Path<String>,
    axum::extract::Query(q): axum::extract::Query<RsvpPageQuery>,
) -> Result<axum::response::Html<String>> {
    let mut attendee = state
        .db
        .fetch_optional_as::<Attendee>(
            "SELECT a.* FROM calendar.attendees a \
             WHERE a.rsvp_token = $1 AND (a.rsvp_expires_at IS NULL OR a.rsvp_expires_at > $2)",
            params![&token, Utc::now()],
        )
        .await?
        .ok_or_else(|| CalendarError::NotFound("Lien RSVP invalide ou expiré".to_string()))?;

    // «?answer=…» comes from a button in the invitation e-mail: record it (and
    // bump the event) before rendering. An unknown value is ignored.
    if let Some(answer) = q.answer.as_deref() {
        if ["accepted", "declined", "tentative"].contains(&answer) {
            let mut tx = state.db.begin().await?;
            let updated = tx
                .execute(
                    "UPDATE calendar.attendees SET status = $1, responded_at = $2 WHERE id = $3",
                    params![answer, Utc::now(), attendee.id],
                )
                .await;
            match updated {
                Ok(_) => {
                    sync::touch_event(&mut tx, attendee.event_id).await?;
                    tx.commit().await?;
                    attendee.status = answer.to_string();
                }
                Err(e) => {
                    tracing::error!(error = %e, "rsvp : enregistrement de la réponse par lien");
                    let _ = tx.rollback().await;
                }
            }
        }
    }

    let event = state
        .db
        .fetch_optional_as::<Event>("SELECT * FROM calendar.events WHERE id = $1", params![attendee.event_id])
        .await?
        .ok_or_else(|| CalendarError::NotFound("Événement introuvable".to_string()))?;

    let esc = |s: &str| {
        s.replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
            .replace('"', "&quot;")
    };
    let title    = esc(&event.title);
    let location = event.location.as_deref().map(esc).unwrap_or_default();
    let date_str = event.starts_at.format("%d/%m/%Y %H:%M").to_string();
    let end_str  = event.ends_at.format("%H:%M").to_string();
    let guest    = esc(attendee.display_name.as_deref()
        .or(attendee.email.as_deref())
        .unwrap_or("—"));
    let current  = attendee.status.clone();
    let token_js = esc(&token);

    let html = format!(
        r#"<!DOCTYPE html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Invitation — {title}</title>
<style>
  body {{ font-family: system-ui, -apple-system, sans-serif; background: #f3f4f6; margin: 0;
         display: flex; align-items: center; justify-content: center; min-height: 100vh; }}
  .card {{ background: #fff; border-radius: 16px; box-shadow: 0 8px 30px rgba(0,0,0,.08);
          padding: 32px; max-width: 420px; width: calc(100% - 32px); }}
  h1 {{ font-size: 20px; margin: 0 0 4px; color: #111827; }}
  .meta {{ color: #6b7280; font-size: 14px; margin: 2px 0; }}
  .guest {{ margin: 18px 0 10px; font-size: 14px; color: #374151; }}
  .btns {{ display: flex; gap: 8px; margin-top: 14px; }}
  button {{ flex: 1; padding: 10px 0; border-radius: 10px; border: 1px solid #d1d5db;
           background: #fff; font-size: 14px; cursor: pointer; }}
  button:hover {{ background: #f9fafb; }}
  button.active {{ border-color: #4d38db; background: #4d38db; color: #fff; }}
  #msg {{ margin-top: 14px; font-size: 13px; color: #059669; min-height: 18px; }}
</style></head><body>
<div class="card">
  <h1>{title}</h1>
  <p class="meta">📅 {date_str} – {end_str}</p>
  {location_line}
  <p class="guest">Bonjour <strong>{guest}</strong>, participerez-vous ?</p>
  <div class="btns">
    <button id="accepted">Oui</button>
    <button id="tentative">Peut-être</button>
    <button id="declined">Non</button>
  </div>
  <p id="msg"></p>
</div>
<script>
  const current = "{current}";
  const mark = s => document.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.id === s));
  if (current !== 'needs-action') mark(current);
  for (const id of ['accepted', 'tentative', 'declined']) {{
    document.getElementById(id).onclick = async () => {{
      const r = await fetch('/api/v1/calendar/public/rsvp/{token_js}', {{
        method: 'POST', headers: {{ 'Content-Type': 'application/json' }},
        body: JSON.stringify({{ status: id }})
      }});
      if (r.ok) {{ mark(id); document.getElementById('msg').textContent = 'Réponse enregistrée, merci !'; }}
      else document.getElementById('msg').textContent = 'Erreur — réessayez.';
    }};
  }}
</script>
</body></html>"#,
        title = title,
        date_str = date_str,
        end_str = end_str,
        guest = guest,
        current = current,
        token_js = token_js,
        location_line = if location.is_empty() {
            String::new()
        } else {
            format!(r#"<p class="meta">📍 {location}</p>"#)
        },
    );

    Ok(axum::response::Html(html))
}

/// Informations sur un sondage public
pub async fn poll_info(
    State(state): State<AppState>,
    Path(token): Path<String>,
) -> Result<Json<serde_json::Value>> {
    let poll  = SchedulingService::get_poll_by_token(&token, &state.db).await?;
    let slots = SchedulingService::get_poll_slots(poll.id, &state.db).await?;
    let responses = SchedulingService::get_poll_responses(poll.id, &state.db).await?;

    if let Some(expires_at) = poll.expires_at {
        if expires_at < Utc::now() {
            return Err(CalendarError::Validation("Ce sondage a expiré".to_string()));
        }
    }

    Ok(Json(serde_json::json!({
        "poll":      poll,
        "slots":     slots,
        "responses": responses,
    })))
}

/// Respond to a public poll (without full authentication)
pub async fn poll_respond(
    State(state): State<AppState>,
    Path(token): Path<String>,
    Json(dto): Json<PollRespondDto>,
) -> Result<Json<serde_json::Value>> {
    let poll = SchedulingService::get_poll_by_token(&token, &state.db).await?;

    if poll.status != "open" {
        return Err(CalendarError::Validation("Ce sondage est fermé".to_string()));
    }

    let email = dto.email.clone()
        .ok_or_else(|| CalendarError::Validation("Email requis pour répondre sans compte".to_string()))?;

    let responses = SchedulingService::respond_to_poll(poll.id, None, &email, dto, &state.db).await?;

    Ok(Json(serde_json::json!({ "responses": responses })))
}

/// Flux iCalendar public d'un calendrier (abonnement)
pub async fn calendar_feed(
    State(state): State<AppState>,
    Path(token): Path<String>,
) -> Result<([(axum::http::HeaderName, String); 1], String)> {
    let instance = state.instance();
    if !instance.allow_public_calendars {
        return Err(CalendarError::NotFound("Calendrier introuvable".to_string()));
    }

    let calendar = state
        .db
        .fetch_optional_as::<Calendar>(
            "SELECT * FROM calendar.calendars WHERE caldav_token = $1 AND is_public = TRUE",
            params![token],
        )
        .await?
        .ok_or_else(|| CalendarError::NotFound("Calendrier introuvable".to_string()))?;

    let events = state
        .db
        .fetch_all_as::<Event>(
            "SELECT * FROM calendar.events WHERE calendar_id = $1 AND status != 'cancelled' ORDER BY starts_at",
            params![calendar.id],
        )
        .await?;

    let ics = match instance.public_calendar_detail {
        crate::config::PublicDetail::Full     => ICalendarService::calendar_to_ics(&events, &calendar.name),
        crate::config::PublicDetail::BusyOnly => ICalendarService::calendar_to_busy_ics(&events, &calendar.name),
    };

    Ok(([
        (axum::http::header::CONTENT_TYPE, "text/calendar; charset=utf-8".to_string()),
    ], ics))
}
