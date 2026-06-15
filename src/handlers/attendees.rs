use axum::{
    extract::{Path, State},
    http::StatusCode,
    Extension,
    Json,
};
use chrono::{Duration, Utc};
use uuid::Uuid;

use crate::{
    errors::{CalendarError, Result},
    middleware::CalendarUser,
    models::attendee::{InviteAttendeeDto, RsvpDto},
    state::AppState,
};

pub async fn list(
    State(state): State<AppState>,
    Extension(user): Extension<CalendarUser>,
    Path(event_id): Path<Uuid>,
) -> Result<Json<serde_json::Value>> {
    // Vérifier accès à l'événement
    let _ = sqlx::query_as::<_, (Uuid,)>(
        r#"
        SELECT e.id FROM calendar.events e
        JOIN calendar.calendars c ON c.id = e.calendar_id
        LEFT JOIN calendar.calendar_shares cs ON cs.calendar_id = c.id AND cs.shared_with = $2
        WHERE e.id = $1 AND (c.owner_id = $2 OR cs.shared_with = $2)
        "#,
    )
    .bind(event_id)
    .bind(user.id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| CalendarError::NotFound(format!("Événement {event_id}")))?;

    let attendees = sqlx::query_as::<_, crate::models::attendee::Attendee>(
        "SELECT * FROM calendar.attendees WHERE event_id = $1 ORDER BY is_organizer DESC, email",
    )
    .bind(event_id)
    .fetch_all(&state.db)
    .await?;

    Ok(Json(serde_json::json!({ "attendees": attendees })))
}

pub async fn invite(
    State(state): State<AppState>,
    Extension(user): Extension<CalendarUser>,
    Path(event_id): Path<Uuid>,
    Json(dto): Json<InviteAttendeeDto>,
) -> Result<(StatusCode, Json<serde_json::Value>)> {
    use validator::Validate;
    dto.validate()
        .map_err(|e| CalendarError::Validation(e.to_string()))?;

    // Vérifier que l'utilisateur est propriétaire de l'événement
    let event_owner: Option<(Uuid,)> = sqlx::query_as(
        "SELECT owner_id FROM calendar.events WHERE id = $1 AND owner_id = $2",
    )
    .bind(event_id)
    .bind(user.id)
    .fetch_optional(&state.db)
    .await?;

    if event_owner.is_none() {
        return Err(CalendarError::Forbidden);
    }

    // Générer un token RSVP
    let rsvp_token: String = {
        use rand::Rng;
        let bytes: [u8; 16] = rand::thread_rng().gen();
        hex::encode(bytes)
    };
    let expires_at = Utc::now() + Duration::days(7);

    let attendee = sqlx::query_as::<_, crate::models::attendee::Attendee>(
        r#"
        INSERT INTO calendar.attendees
            (event_id, email, display_name, rsvp_token, rsvp_expires_at)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (event_id, email) DO UPDATE
            SET display_name = EXCLUDED.display_name
        RETURNING *
        "#,
    )
    .bind(event_id)
    .bind(&dto.email)
    .bind(&dto.display_name)
    .bind(&rsvp_token)
    .bind(expires_at)
    .fetch_one(&state.db)
    .await?;

    Ok((StatusCode::CREATED, Json(serde_json::json!({ "attendee": attendee }))))
}

pub async fn update_rsvp(
    State(state): State<AppState>,
    Extension(user): Extension<CalendarUser>,
    Path((_event_id, attendee_id)): Path<(Uuid, Uuid)>,
    Json(dto): Json<RsvpDto>,
) -> Result<Json<serde_json::Value>> {
    let valid_statuses = ["needs-action", "accepted", "declined", "tentative"];
    if !valid_statuses.contains(&dto.status.as_str()) {
        return Err(CalendarError::Validation(format!(
            "Statut invalide: {}",
            dto.status
        )));
    }

    let attendee = sqlx::query_as::<_, crate::models::attendee::Attendee>(
        r#"
        UPDATE calendar.attendees
        SET status = $2, comment = $3, responded_at = NOW()
        WHERE id = $1 AND user_id = $4
        RETURNING *
        "#,
    )
    .bind(attendee_id)
    .bind(&dto.status)
    .bind(&dto.comment)
    .bind(user.id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| CalendarError::NotFound(format!("Participant {attendee_id}")))?;

    Ok(Json(serde_json::json!({ "attendee": attendee })))
}

pub async fn remove(
    State(state): State<AppState>,
    Extension(user): Extension<CalendarUser>,
    Path((event_id, attendee_id)): Path<(Uuid, Uuid)>,
) -> Result<StatusCode> {
    // Seul le propriétaire de l'événement peut retirer un participant
    let is_owner: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM calendar.events WHERE id = $1 AND owner_id = $2)",
    )
    .bind(event_id)
    .bind(user.id)
    .fetch_one(&state.db)
    .await?;

    if !is_owner {
        return Err(CalendarError::Forbidden);
    }

    sqlx::query("DELETE FROM calendar.attendees WHERE id = $1 AND event_id = $2")
        .bind(attendee_id)
        .bind(event_id)
        .execute(&state.db)
        .await?;

    Ok(StatusCode::NO_CONTENT)
}
