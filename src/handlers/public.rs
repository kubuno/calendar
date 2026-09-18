use axum::{
    extract::{Path, State},
    Json,
};
use chrono::Utc;

use crate::{
    errors::{CalendarError, Result},
    models::attendee::RsvpDto,
    models::scheduling::PollRespondDto,
    services::{
        icalendar_service::ICalendarService,
        scheduling_service::SchedulingService,
    },
    state::AppState,
};

/// Information about an RSVP (from the e-mail link)
pub async fn rsvp_info(
    State(state): State<AppState>,
    Path(token): Path<String>,
) -> Result<Json<serde_json::Value>> {
    let attendee = sqlx::query_as::<_, crate::models::attendee::Attendee>(
        r#"
        SELECT a.* FROM calendar.attendees a
        WHERE a.rsvp_token = $1
          AND (a.rsvp_expires_at IS NULL OR a.rsvp_expires_at > NOW())
        "#,
    )
    .bind(&token)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| CalendarError::NotFound("Lien RSVP invalide ou expiré".to_string()))?;

    let event: crate::models::event::Event = sqlx::query_as::<_, crate::models::event::Event>(
        "SELECT * FROM calendar.events WHERE id = $1",
    )
    .bind(attendee.event_id)
    .fetch_optional(&state.db)
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

    let attendee = sqlx::query_as::<_, crate::models::attendee::Attendee>(
        r#"
        UPDATE calendar.attendees
        SET status = $2, comment = $3, responded_at = NOW()
        WHERE rsvp_token = $1
          AND (rsvp_expires_at IS NULL OR rsvp_expires_at > NOW())
        RETURNING *
        "#,
    )
    .bind(&token)
    .bind(&dto.status)
    .bind(&dto.comment)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| CalendarError::NotFound("Lien RSVP invalide ou expiré".to_string()))?;

    // Same rule as the signed-in path: a refusal that empties the meeting hands
    // the room back. Most refusals arrive through this link — an invitation
    // e-mail — so leaving it out here would make the feature work only for the
    // few who answer from inside the application.
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

        // Tell the organiser and the guests: their meeting no longer has a room.
        // The in-app channel the module already uses for "this event changed" —
        // which is precisely what happened. Not an iTIP message: that vocabulary
        // would announce a CANCELLED event, and the meeting is very much alive.
        if let Ok(Ok(freed)) = &released {
            if !freed.is_empty() {
                if let Ok((title,)) = sqlx::query_as::<_, (String,)>(
                    "SELECT title FROM calendar.events WHERE id = $1",
                )
                .bind(attendee.event_id)
                .fetch_one(&state.db)
                .await
                {
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

/// Standalone RSVP page (minimal HTML, no shell nor authentication): the guest
/// opens the received link, sees the event and answers Yes / Maybe / No.
/// An answer carried by the link itself, so the three buttons of an invitation
/// e-mail land on a page that has already recorded the choice.
#[derive(serde::Deserialize)]
pub struct RsvpPageQuery {
    pub answer: Option<String>,
}

pub async fn rsvp_page(
    State(state): State<AppState>,
    Path(token): Path<String>,
    axum::extract::Query(q): axum::extract::Query<RsvpPageQuery>,
) -> Result<axum::response::Html<String>> {
    // «?answer=…» comes from a button in the invitation e-mail: record it before
    // rendering, so the guest sees the answer already taken into account. An
    // unknown value is ignored rather than refused — the page still opens.
    if let Some(answer) = q.answer.as_deref() {
        if ["accepted", "declined", "tentative"].contains(&answer) {
            if let Err(e) = sqlx::query(
                "UPDATE calendar.attendees SET status = $2, responded_at = NOW() \
                 WHERE rsvp_token = $1 AND (rsvp_expires_at IS NULL OR rsvp_expires_at > NOW())",
            )
            .bind(&token)
            .bind(answer)
            .execute(&state.db)
            .await
            {
                tracing::error!(error = %e, "rsvp : enregistrement de la réponse par lien");
            }
        }
    }

    // Reuse the same validation as rsvp_info.
    let attendee = sqlx::query_as::<_, crate::models::attendee::Attendee>(
        r#"
        SELECT a.* FROM calendar.attendees a
        WHERE a.rsvp_token = $1
          AND (a.rsvp_expires_at IS NULL OR a.rsvp_expires_at > NOW())
        "#,
    )
    .bind(&token)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| CalendarError::NotFound("Lien RSVP invalide ou expiré".to_string()))?;

    let event: crate::models::event::Event = sqlx::query_as::<_, crate::models::event::Event>(
        "SELECT * FROM calendar.events WHERE id = $1",
    )
    .bind(attendee.event_id)
    .fetch_optional(&state.db)
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
    // This page answers an RSVP link, which only a person ever receives — a room
    // has neither a mailbox nor a display name. The fallback is defensive.
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

    // Check expiration
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

    let responses = SchedulingService::respond_to_poll(
        poll.id,
        None,
        &email,
        dto,
        &state.db,
    )
    .await?;

    Ok(Json(serde_json::json!({ "responses": responses })))
}

/// Flux iCalendar public d'un calendrier (abonnement)
pub async fn calendar_feed(
    State(state): State<AppState>,
    Path(token): Path<String>,
) -> Result<([(axum::http::HeaderName, String); 1], String)> {
    let instance = state.instance();
    // Closing publication has to close the feeds already out there, not just
    // forbid new ones — a link handed out yesterday is exactly what the
    // administration is taking back. Answering "introuvable" rather than
    // "interdit" keeps the route from confirming that the token exists.
    if !instance.allow_public_calendars {
        return Err(CalendarError::NotFound("Calendrier introuvable".to_string()));
    }

    let calendar = sqlx::query_as::<_, crate::models::calendar::Calendar>(
        "SELECT * FROM calendar.calendars WHERE caldav_token = $1 AND is_public = TRUE",
    )
    .bind(&token)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| CalendarError::NotFound("Calendrier introuvable".to_string()))?;

    let events: Vec<crate::models::event::Event> = sqlx::query_as::<_, crate::models::event::Event>(
        "SELECT * FROM calendar.events WHERE calendar_id = $1 AND status != 'cancelled' ORDER BY starts_at",
    )
    .bind(calendar.id)
    .fetch_all(&state.db)
    .await?;

    let ics = match instance.public_calendar_detail {
        crate::config::PublicDetail::Full     => ICalendarService::calendar_to_ics(&events, &calendar.name),
        crate::config::PublicDetail::BusyOnly => ICalendarService::calendar_to_busy_ics(&events, &calendar.name),
    };

    Ok(([
        (axum::http::header::CONTENT_TYPE, "text/calendar; charset=utf-8".to_string()),
    ], ics))
}
