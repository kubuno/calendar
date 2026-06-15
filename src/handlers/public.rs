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

/// Informations sur un RSVP (depuis le lien email)
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

/// Réponse à un RSVP depuis le lien email (sans authentification)
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

    Ok(Json(serde_json::json!({ "attendee": attendee, "message": "Réponse enregistrée" })))
}

/// Informations sur un sondage public
pub async fn poll_info(
    State(state): State<AppState>,
    Path(token): Path<String>,
) -> Result<Json<serde_json::Value>> {
    let poll  = SchedulingService::get_poll_by_token(&token, &state.db).await?;
    let slots = SchedulingService::get_poll_slots(poll.id, &state.db).await?;
    let responses = SchedulingService::get_poll_responses(poll.id, &state.db).await?;

    // Vérifier expiration
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

/// Répondre à un sondage public (sans authentification complète)
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

    let ics = ICalendarService::calendar_to_ics(&events, &calendar.name);

    Ok(([
        (axum::http::header::CONTENT_TYPE, "text/calendar; charset=utf-8".to_string()),
    ], ics))
}
