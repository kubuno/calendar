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
) -> Result<Vec<(String, Option<String>, bool)>> {
    // Resolve account ids before opening the transaction (best-effort network).
    let mut resolved: Vec<(String, Option<String>, Option<Uuid>, bool)> = Vec::with_capacity(guests.len());
    for g in guests {
        // Picked from the people list rather than typed: the address is asked
        // of the directory HERE, over the internal channel, so it never had to
        // reach the browser in the first place.
        // `Toto <toto@toto.com>` is a form people paste; understood here so the
        // address is an address and the name is a name.
        let (typed, typed_name) = crate::models::attendee::parse_address(&g.email);
        let email = match (typed.trim(), g.user_id) {
            (e, _) if !e.is_empty() => e.to_string(),
            ("", Some(uid)) => match crate::config::directory_email(
                &state.http, &state.settings.core.url, &state.settings.core.internal_secret, uid,
            ).await {
                Some(e) => e,
                None    => continue,   // compte inconnu : on n'invente pas d'adresse
            },
            _ => continue,
        };
        let user_id = crate::config::directory_user_id(
            &state.http,
            &state.settings.core.url,
            &state.settings.core.internal_secret,
            &email,
        )
        .await;
        resolved.push((email, g.display_name.clone().or(typed_name), user_id, g.optional));
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

    let mut out: Vec<(String, Option<String>, bool)> = Vec::with_capacity(resolved.len());
    for (email, display_name, user_id, optional) in resolved {
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
                (event_id, user_id, email, display_name, rsvp_token, rsvp_expires_at, optional)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            ON CONFLICT (event_id, email) DO UPDATE
                SET display_name = EXCLUDED.display_name,
                    optional     = EXCLUDED.optional,
                    user_id      = COALESCE(calendar.attendees.user_id, EXCLUDED.user_id)
            "#,
        )
        .bind(event_id)
        .bind(user_id)
        .bind(&email)
        .bind(&display_name)
        .bind(&rsvp_token)
        .bind(expires_at)
        .bind(optional)
        .execute(&mut *tx)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "attendees: insertion d'un invité");
            e
        })?;
        out.push((email, display_name, optional));
    }

    tx.commit().await.map_err(|e| {
        tracing::error!(error = %e, "attendees: validation de la transaction d'insertion");
        e
    })?;

    Ok(out)
}

/// The non-organizer guests of an event as `(email, display_name, optional)`, for
/// (re)sending or cancelling the invitation. The organizer is excluded — they do
/// not invite themselves.
pub(crate) async fn fetch_guests(
    db: &sqlx::PgPool,
    event_id: Uuid,
) -> Result<Vec<(String, Option<String>, bool)>> {
    let rows: Vec<(String, Option<String>, bool)> = sqlx::query_as(
        "SELECT email, display_name, optional FROM calendar.attendees \
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

/// What this caller may do with this event's guest list.
///
/// Three questions, one lookup, because the three answers come from the same
/// row and asking separately is how they drift apart. An organiser answers yes
/// to everything; someone the calendar was shared with acts on the owner's
/// behalf; a GUEST gets exactly what the organiser ticked, and someone who is
/// neither gets a "not found" — an event they cannot see must not be probeable
/// by the shape of the refusal.
struct GuestRights {
    /// The caller organises it, or holds write access to its calendar.
    is_host:   bool,
    can_see:   bool,
    can_invite: bool,
}

async fn guest_rights(state: &AppState, event_id: Uuid, user_id: Uuid) -> Result<GuestRights> {
    let row: Option<(bool, bool, bool, bool, bool)> = sqlx::query_as(
        r#"
        SELECT (c.owner_id = $2 OR cs.shared_with IS NOT NULL) AS is_host,
               a.id IS NOT NULL                                AS is_guest,
               e.guests_can_invite,
               e.guests_can_see_guests,
               e.guests_can_modify
          FROM calendar.events e
          JOIN calendar.calendars c ON c.id = e.calendar_id
          LEFT JOIN calendar.calendar_shares cs
                 ON cs.calendar_id = c.id AND cs.shared_with = $2 AND cs.permission <> 'read'
          LEFT JOIN calendar.attendees a ON a.event_id = e.id AND a.user_id = $2
         WHERE e.id = $1
        "#,
    )
    .bind(event_id)
    .bind(user_id)
    .fetch_optional(&state.db)
    .await?;

    let (is_host, is_guest, can_invite, can_see, _can_modify) =
        row.ok_or_else(|| CalendarError::NotFound(format!("Événement {event_id}")))?;
    if !is_host && !is_guest {
        return Err(CalendarError::NotFound(format!("Événement {event_id}")));
    }
    Ok(GuestRights {
        is_host,
        can_see:    is_host || can_see,
        can_invite: is_host || can_invite,
    })
}

pub async fn list(
    State(state): State<AppState>,
    Extension(user): Extension<CalendarUser>,
    Path(event_id): Path<Uuid>,
) -> Result<Json<serde_json::Value>> {
    let rights = guest_rights(&state, event_id, user.id).await?;

    // A guest the organiser kept from seeing the others still sees the two
    // names they already know: the organiser, and themselves. Returning an
    // empty list instead would read as "nobody is coming", which is a different
    // statement and a false one.
    let attendees = if rights.can_see {
        sqlx::query_as::<_, crate::models::attendee::Attendee>(
            "SELECT * FROM calendar.attendees WHERE event_id = $1
              ORDER BY is_organizer DESC, optional, email",
        )
        .bind(event_id)
        .fetch_all(&state.db)
        .await?
    } else {
        sqlx::query_as::<_, crate::models::attendee::Attendee>(
            "SELECT * FROM calendar.attendees
              WHERE event_id = $1 AND (is_organizer OR user_id = $2)
              ORDER BY is_organizer DESC",
        )
        .bind(event_id)
        .bind(user.id)
        .fetch_all(&state.db)
        .await?
    };

    Ok(Json(serde_json::json!({
        "attendees": attendees,
        // Said out loud, so the list can explain itself rather than look short.
        "hidden":    !rights.can_see,
    })))
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

    // An account chosen from the people list becomes an address here, never in
    // the browser: the directory may be configured to keep addresses private,
    // and a picker that cannot invite a colleague because of it would be a
    // picker that does not work on most instances.
    // Same understanding on the single-guest route: an address pasted with its
    // name is the same address.
    let (parsed, parsed_name) = crate::models::attendee::parse_address(&dto.email);
    let dto = InviteAttendeeDto {
        email: parsed,
        display_name: dto.display_name.clone().or(parsed_name),
        ..dto
    };
    let dto = if dto.email.trim().is_empty() {
        let uid = dto.user_id.ok_or_else(|| CalendarError::Validation("Adresse ou compte requis".into()))?;
        let resolved = crate::config::directory_email(
            &state.http, &state.settings.core.url, &state.settings.core.internal_secret, uid,
        )
        .await
        .ok_or_else(|| CalendarError::Validation("Ce compte n'a pas d'adresse connue".into()))?;
        InviteAttendeeDto { email: resolved, ..dto }
    } else {
        dto
    };
    if !dto.email.contains('@') {
        return Err(CalendarError::Validation("Adresse invalide".into()));
    }

    // The organiser always may; a guest may when the organiser said so. This is
    // the whole point of "Invite others": a permission that only the organiser
    // could exercise would be a label on an empty box.
    let rights = guest_rights(&state, event_id, user.id).await?;
    if !rights.can_invite {
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
            (event_id, user_id, email, display_name, rsvp_token, rsvp_expires_at, optional)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (event_id, email) DO UPDATE
            SET display_name = EXCLUDED.display_name,
                optional     = EXCLUDED.optional,
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
    .bind(dto.optional)
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
            let guest = vec![(email.clone(), dto.display_name.clone(), dto.optional)];
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
    Path((event_id, attendee_id)): Path<(Uuid, Uuid)>,
    Json(dto): Json<RsvpDto>,
) -> Result<Json<serde_json::Value>> {
    // "Welcome, not required" is the HOST's statement about a guest, not an
    // answer from that guest — so it takes this route but not its rule, and a
    // guest cannot quietly make their own attendance optional.
    if let Some(optional) = dto.optional {
        if !guest_rights(&state, event_id, user.id).await?.is_host {
            return Err(CalendarError::Forbidden);
        }
        let attendee = sqlx::query_as::<_, crate::models::attendee::Attendee>(
            "UPDATE calendar.attendees SET optional = $2 WHERE id = $1 AND event_id = $3 RETURNING *",
        )
        .bind(attendee_id)
        .bind(optional)
        .bind(event_id)
        .fetch_optional(&state.db)
        .await?
        .ok_or_else(|| CalendarError::NotFound(format!("Participant {attendee_id}")))?;
        return Ok(Json(serde_json::json!({ "attendee": attendee })));
    }

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

    // A refusal may have emptied the meeting; the room it holds is then given
    // back. Best-effort on purpose: the answer above is already recorded, and a
    // failure to free a room must not turn it into an error the person retries.
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
                        &state, attendee.event_id, user.id, &title, "updated",
                    )
                    .await;
                }
            }
        }
    }

    Ok(Json(serde_json::json!({ "attendee": attendee })))
}

pub async fn remove(
    State(state): State<AppState>,
    Extension(user): Extension<CalendarUser>,
    Path((event_id, attendee_id)): Path<(Uuid, Uuid)>,
) -> Result<StatusCode> {
    // Taking a name OFF the list stays with the host. "Invite others" adds
    // people; it was never a licence to uninvite them, and a guest able to
    // remove other guests would be a way to empty a meeting quietly.
    if !guest_rights(&state, event_id, user.id).await?.is_host {
        return Err(CalendarError::Forbidden);
    }

    sqlx::query("DELETE FROM calendar.attendees WHERE id = $1 AND event_id = $2")
        .bind(attendee_id)
        .bind(event_id)
        .execute(&state.db)
        .await?;

    Ok(StatusCode::NO_CONTENT)
}
