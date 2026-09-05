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
    models::attendee::{AttendeeInputDto, InviteAttendeeDto, RsvpDto},
    state::AppState,
};

/// Resolves each guest address to an instance account id when it matches one,
/// then inserts the organizer's own attendee row and every guest row in a single
/// transaction. Linking a guest to their account is what lets an invited user
/// see the event in their own calendar.
///
/// The directory lookups are done first, outside the transaction, so no network
/// round-trip is held across an open transaction. Returns the guest list as
/// `(email, display_name)` for the invitation e-mail — the organizer is never in
/// it.
pub(crate) async fn insert_guests(
    state: &AppState,
    event_id: Uuid,
    organizer_id: Uuid,
    organizer_email: &str,
    guests: &[AttendeeInputDto],
) -> Result<Vec<(String, Option<String>)>> {
    // Resolve account ids before opening the transaction (best-effort network).
    let mut resolved: Vec<(String, Option<String>, Option<Uuid>)> = Vec::with_capacity(guests.len());
    for g in guests {
        let email = g.email.trim().to_string();
        if email.is_empty() {
            continue;
        }
        let user_id = crate::config::directory_user_id(
            &state.http,
            &state.settings.core.url,
            &state.settings.core.internal_secret,
            &email,
        )
        .await;
        resolved.push((email, g.display_name.clone(), user_id));
    }

    let mut tx = state.db.begin().await.map_err(|e| {
        tracing::error!(error = %e, "attendees: ouverture de la transaction d'insertion");
        e
    })?;

    // The organizer's own attendee row (accepted), so the event shows in their
    // calendar as a meeting they run. Idempotent on (event_id, email).
    sqlx::query(
        r#"
        INSERT INTO calendar.attendees (event_id, user_id, email, status, is_organizer)
        VALUES ($1, $2, $3, 'accepted', TRUE)
        ON CONFLICT (event_id, email) DO UPDATE
            SET is_organizer = TRUE, user_id = COALESCE(calendar.attendees.user_id, EXCLUDED.user_id)
        "#,
    )
    .bind(event_id)
    .bind(organizer_id)
    .bind(organizer_email.trim())
    .execute(&mut *tx)
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "attendees: insertion de la ligne organisateur");
        e
    })?;

    let mut out: Vec<(String, Option<String>)> = Vec::with_capacity(resolved.len());
    for (email, display_name, user_id) in resolved {
        // Never let a guest row shadow the organizer row.
        if email.eq_ignore_ascii_case(organizer_email.trim()) {
            continue;
        }
        let rsvp_token: String = {
            use rand::Rng;
            let bytes: [u8; 16] = rand::thread_rng().gen();
            hex::encode(bytes)
        };
        let expires_at = Utc::now() + Duration::days(7);
        sqlx::query(
            r#"
            INSERT INTO calendar.attendees
                (event_id, user_id, email, display_name, rsvp_token, rsvp_expires_at)
            VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT (event_id, email) DO UPDATE
                SET display_name = EXCLUDED.display_name,
                    user_id      = COALESCE(calendar.attendees.user_id, EXCLUDED.user_id)
            "#,
        )
        .bind(event_id)
        .bind(user_id)
        .bind(&email)
        .bind(&display_name)
        .bind(&rsvp_token)
        .bind(expires_at)
        .execute(&mut *tx)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "attendees: insertion d'un invité");
            e
        })?;
        out.push((email, display_name));
    }

    tx.commit().await.map_err(|e| {
        tracing::error!(error = %e, "attendees: validation de la transaction d'insertion");
        e
    })?;

    Ok(out)
}

/// The non-organizer guests of an event as `(email, display_name)`, for
/// (re)sending or cancelling the invitation. The organizer is excluded — they do
/// not invite themselves.
pub(crate) async fn fetch_guests(
    db: &sqlx::PgPool,
    event_id: Uuid,
) -> Result<Vec<(String, Option<String>)>> {
    let rows: Vec<(String, Option<String>)> = sqlx::query_as(
        "SELECT email, display_name FROM calendar.attendees \
         WHERE event_id = $1 AND is_organizer = FALSE ORDER BY email",
    )
    .bind(event_id)
    .fetch_all(db)
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "attendees: lecture de la liste des invités");
        e
    })?;
    Ok(rows)
}

/// Records the event `SEQUENCE` at which the guests were just notified, so a
/// later RSVP reply answering an older invitation is rejected as stale. Applied
/// to every non-organizer attendee of the event.
pub(crate) async fn mark_notified(
    db: &sqlx::PgPool,
    event_id: Uuid,
    sequence: i32,
) -> Result<()> {
    sqlx::query(
        "UPDATE calendar.attendees SET last_notified_sequence = $2 \
         WHERE event_id = $1 AND is_organizer = FALSE",
    )
    .bind(event_id)
    .bind(sequence)
    .execute(db)
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "attendees: enregistrement du numéro de séquence notifié");
        e
    })?;
    Ok(())
}

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

    let instance = state.instance();
    let email = dto.email.trim().to_string();

    // Ceiling on the guest list. The address already on the list does not count:
    // the insert below is an upsert, so re-inviting someone adds nobody.
    if instance.max_event_guests > 0 {
        let others: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM calendar.attendees WHERE event_id = $1 AND email <> $2",
        )
        .bind(event_id)
        .bind(&email)
        .fetch_one(&state.db)
        .await?;
        if others >= instance.max_event_guests {
            return Err(CalendarError::Validation(format!(
                "Nombre maximal de participants atteint ({}) pour cet événement",
                instance.max_event_guests
            )));
        }
    }

    // Guests from outside the instance. The declared domains answer for free;
    // only an address that matches none of them costs a directory lookup, and an
    // unanswered lookup refuses rather than guesses — a policy that opens itself
    // whenever the network hiccups is not a policy.
    if !instance.allow_external_guests && !instance.domain_is_internal(&email) {
        let known = crate::config::directory_knows_email(
            &state.http,
            &state.settings.core.url,
            &state.settings.core.internal_secret,
            &email,
        )
        .await;
        match known {
            Some(true) => {}
            Some(false) => {
                return Err(CalendarError::Validation(
                    "Les invités extérieurs à l'instance sont désactivés sur cette instance"
                        .to_string(),
                ))
            }
            None => {
                return Err(CalendarError::Validation(
                    "Impossible de vérifier si cette adresse appartient à l'instance — réessayez"
                        .to_string(),
                ))
            }
        }
    }

    // Resolve the address to an instance account so the invited user sees the
    // event in their own calendar (best-effort; external guests stay NULL).
    let user_id = crate::config::directory_user_id(
        &state.http,
        &state.settings.core.url,
        &state.settings.core.internal_secret,
        &email,
    )
    .await;

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
            (event_id, user_id, email, display_name, rsvp_token, rsvp_expires_at)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (event_id, email) DO UPDATE
            SET display_name = EXCLUDED.display_name,
                user_id      = COALESCE(calendar.attendees.user_id, EXCLUDED.user_id)
        RETURNING *
        "#,
    )
    .bind(event_id)
    .bind(user_id)
    .bind(&email)
    .bind(&dto.display_name)
    .bind(&rsvp_token)
    .bind(expires_at)
    .fetch_one(&state.db)
    .await?;

    // Ensure the organizer has their own (accepted) attendee row.
    sqlx::query(
        r#"
        INSERT INTO calendar.attendees (event_id, user_id, email, status, is_organizer)
        VALUES ($1, $2, $3, 'accepted', TRUE)
        ON CONFLICT (event_id, email) DO UPDATE SET is_organizer = TRUE
        "#,
    )
    .bind(event_id)
    .bind(user.id)
    .bind(user.email.trim())
    .execute(&state.db)
    .await?;

    // Send the invitation e-mail for this newly added guest, if the instance
    // enables it. Best-effort: never fail the request over the mail path.
    if state.instance().send_email_invitations {
        if let Ok(event) = crate::services::event_service::EventService::get(event_id, user.id, &state.db).await {
            mark_notified(&state.db, event_id, event.sequence).await?;
            let state2 = state.clone();
            let organizer_email = user.email.clone();
            let guest = vec![(email.clone(), dto.display_name.clone())];
            tokio::spawn(async move {
                crate::events::publisher::publish_invite(
                    &state2,
                    crate::services::icalendar_service::ItipMethod::Request,
                    &event,
                    &organizer_email,
                    None,
                    &guest,
                )
                .await;
            });
        }
    }

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
