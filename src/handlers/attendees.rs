use axum::{
    extract::{Path, State},
    http::StatusCode,
    Extension,
    Json,
};
use chrono::{Duration, Utc};
use kubuno_db::dialect::Assign;
use kubuno_db::{params, DbPool};
use uuid::Uuid;

use crate::{
    errors::{CalendarError, Result},
    middleware::CalendarUser,
    models::attendee::{Attendee, AttendeeInputDto, InviteAttendeeDto, RsvpDto},
    state::AppState,
    sync,
};

/// The upsert `SET` list for a guest row (display_name / optional overwritten,
/// an already-resolved account id kept). Built per engine.
fn guest_upsert_clause(backend: kubuno_db::Backend) -> String {
    backend.upsert(
        "attendees",
        &["event_id", "email"],
        &[
            Assign::Incoming("display_name"),
            Assign::Incoming("optional"),
            Assign::Expr { col: "user_id", expr: "COALESCE({cur}, {new})" },
        ],
    )
}

/// Resolves each guest address to an instance account id when it matches one,
/// then inserts the organizer's own attendee row and every guest row in a single
/// transaction. Bumps the event once (the portable replacement for the old
/// attendee→event trigger).
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
    let backend = tx.backend();

    // The organizer's own attendee row (accepted), idempotent on (event_id, email).
    let org_clause = backend.upsert(
        "attendees",
        &["event_id", "email"],
        &[
            Assign::Expr { col: "is_organizer", expr: "TRUE" },
            Assign::Expr { col: "user_id", expr: "COALESCE({cur}, {new})" },
        ],
    );
    tx.execute(
        &format!(
            "INSERT INTO calendar.attendees (id, event_id, user_id, email, status, is_organizer)
             VALUES ($1, $2, $3, $4, 'accepted', TRUE){org_clause}"
        ),
        params![kubuno_db::new_id(), event_id, organizer_id, organizer_email.trim()],
    )
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "attendees: insertion de la ligne organisateur");
        e
    })?;

    let guest_clause = guest_upsert_clause(backend);
    let mut out: Vec<(String, Option<String>, bool)> = Vec::with_capacity(resolved.len());
    for (email, display_name, user_id, optional) in resolved {
        if email.eq_ignore_ascii_case(organizer_email.trim()) {
            continue;
        }
        let rsvp_token = rsvp_token();
        let expires_at = Utc::now() + Duration::days(7);
        tx.execute(
            &format!(
                "INSERT INTO calendar.attendees
                    (id, event_id, user_id, email, display_name, rsvp_token, rsvp_expires_at, optional)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8){guest_clause}"
            ),
            params![
                kubuno_db::new_id(), event_id, user_id, email.clone(), display_name.clone(),
                rsvp_token, expires_at, optional
            ],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "attendees: insertion d'un invité");
            e
        })?;
        out.push((email, display_name, optional));
    }

    // Attendee writes bump their event so the change reaches the event delta.
    sync::touch_event(&mut tx, event_id).await?;

    tx.commit().await.map_err(|e| {
        tracing::error!(error = %e, "attendees: validation de la transaction d'insertion");
        e
    })?;

    Ok(out)
}

/// A fresh 32-hex RSVP token.
fn rsvp_token() -> String {
    use rand::Rng;
    let bytes: [u8; 16] = rand::thread_rng().gen();
    hex::encode(bytes)
}

/// The non-organizer guests of an event as `(email, display_name, optional)`. A
/// room carries no address, so it is excluded (the `email IS NOT NULL` guard).
pub(crate) async fn fetch_guests(
    db: &DbPool,
    event_id: Uuid,
) -> Result<Vec<(String, Option<String>, bool)>> {
    let rows: Vec<(String, Option<String>, bool)> = db
        .fetch_all_as(
            "SELECT email, display_name, optional FROM calendar.attendees \
             WHERE event_id = $1 AND is_organizer = FALSE AND email IS NOT NULL ORDER BY email",
            params![event_id],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "attendees: lecture de la liste des invités");
            e
        })?;
    Ok(rows)
}

/// Records the event `SEQUENCE` at which the guests were just notified, and bumps
/// the event (an attendee write).
pub(crate) async fn mark_notified(
    db: &DbPool,
    event_id: Uuid,
    sequence: i32,
) -> Result<()> {
    let mut tx = db.begin().await?;
    tx.execute(
        "UPDATE calendar.attendees SET last_notified_sequence = $1 \
         WHERE event_id = $2 AND is_organizer = FALSE",
        params![sequence, event_id],
    )
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "attendees: enregistrement du numéro de séquence notifié");
        e
    })?;
    sync::touch_event(&mut tx, event_id).await?;
    tx.commit().await?;
    Ok(())
}

/// What this caller may do with this event's guest list.
struct GuestRights {
    is_host:   bool,
    can_see:   bool,
    can_invite: bool,
}

/// Raw columns behind [`GuestRights`]. Host/guest are decided in Rust from these
/// rather than as SQL booleans: a boolean *expression* decodes as an integer on
/// MySQL/SQLite and would not read back into a Rust `bool`.
#[derive(sqlx::FromRow)]
struct GuestRightsRow {
    owner_id:              Uuid,
    shared_with:           Option<Uuid>,
    attendee_id:           Option<Uuid>,
    guests_can_invite:     bool,
    guests_can_see_guests: bool,
    #[allow(dead_code)]
    guests_can_modify:     bool,
}

async fn guest_rights(state: &AppState, event_id: Uuid, user_id: Uuid) -> Result<GuestRights> {
    let row: Option<GuestRightsRow> = state
        .db
        .fetch_optional_as(
            r#"
            SELECT c.owner_id AS owner_id, cs.shared_with AS shared_with, a.id AS attendee_id,
                   e.guests_can_invite, e.guests_can_see_guests, e.guests_can_modify
              FROM calendar.events e
              JOIN calendar.calendars c ON c.id = e.calendar_id
              LEFT JOIN calendar.calendar_shares cs
                     ON cs.calendar_id = c.id AND cs.shared_with = $1 AND cs.permission <> 'read'
              LEFT JOIN calendar.attendees a ON a.event_id = e.id AND a.user_id = $2
             WHERE e.id = $3
            "#,
            params![user_id, user_id, event_id],
        )
        .await?;

    let row = row.ok_or_else(|| CalendarError::NotFound(format!("Événement {event_id}")))?;
    let is_host  = row.owner_id == user_id || row.shared_with.is_some();
    let is_guest = row.attendee_id.is_some();
    let can_invite = row.guests_can_invite;
    let can_see = row.guests_can_see_guests;
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

    let attendees = if rights.can_see {
        state
            .db
            .fetch_all_as::<Attendee>(
                "SELECT * FROM calendar.attendees WHERE event_id = $1
                  ORDER BY is_organizer DESC, optional, email",
                params![event_id],
            )
            .await?
    } else {
        state
            .db
            .fetch_all_as::<Attendee>(
                "SELECT * FROM calendar.attendees
                  WHERE event_id = $1 AND (is_organizer OR user_id = $2)
                  ORDER BY is_organizer DESC",
                params![event_id, user.id],
            )
            .await?
    };

    Ok(Json(serde_json::json!({
        "attendees": attendees,
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

    let rights = guest_rights(&state, event_id, user.id).await?;
    if !rights.can_invite {
        return Err(CalendarError::Forbidden);
    }

    let instance = state.instance();
    let email = dto.email.trim().to_string();

    if instance.max_event_guests > 0 {
        let count_expr = state.db.backend().count_bigint("*");
        let others: i64 = state
            .db
            .fetch_scalar(
                &format!("SELECT {count_expr} FROM calendar.attendees WHERE event_id = $1 AND email <> $2"),
                params![event_id, &email],
            )
            .await?;
        if others >= instance.max_event_guests {
            return Err(CalendarError::Validation(format!(
                "Nombre maximal de participants atteint ({}) pour cet événement",
                instance.max_event_guests
            )));
        }
    }

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

    let resolved_user = crate::config::directory_user_id(
        &state.http,
        &state.settings.core.url,
        &state.settings.core.internal_secret,
        &email,
    )
    .await;

    let rsvp_token = rsvp_token();
    let expires_at = Utc::now() + Duration::days(7);

    let mut tx = state.db.begin().await?;
    let backend = tx.backend();
    let guest_clause = guest_upsert_clause(backend);
    tx.execute(
        &format!(
            "INSERT INTO calendar.attendees
                (id, event_id, user_id, email, display_name, rsvp_token, rsvp_expires_at, optional)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8){guest_clause}"
        ),
        params![
            kubuno_db::new_id(), event_id, resolved_user, &email, dto.display_name.clone(),
            rsvp_token, expires_at, dto.optional
        ],
    )
    .await?;
    // Ensure the organizer has their own (accepted) attendee row.
    let org_clause = backend.upsert(
        "attendees",
        &["event_id", "email"],
        &[Assign::Expr { col: "is_organizer", expr: "TRUE" }],
    );
    tx.execute(
        &format!(
            "INSERT INTO calendar.attendees (id, event_id, user_id, email, status, is_organizer)
             VALUES ($1, $2, $3, $4, 'accepted', TRUE){org_clause}"
        ),
        params![kubuno_db::new_id(), event_id, user.id, user.email.trim()],
    )
    .await?;
    sync::touch_event(&mut tx, event_id).await?;
    tx.commit().await?;

    let attendee = state
        .db
        .fetch_one_as::<Attendee>(
            "SELECT * FROM calendar.attendees WHERE event_id = $1 AND email = $2",
            params![event_id, &email],
        )
        .await?;

    // Send the invitation e-mail for this newly added guest, if enabled.
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
    // "Welcome, not required" is the HOST's statement, not the guest's answer.
    if let Some(optional) = dto.optional {
        if !guest_rights(&state, event_id, user.id).await?.is_host {
            return Err(CalendarError::Forbidden);
        }
        let mut tx = state.db.begin().await?;
        let n = tx
            .execute(
                "UPDATE calendar.attendees SET optional = $1 WHERE id = $2 AND event_id = $3",
                params![optional, attendee_id, event_id],
            )
            .await?;
        if n == 0 {
            tx.rollback().await?;
            return Err(CalendarError::NotFound(format!("Participant {attendee_id}")));
        }
        sync::touch_event(&mut tx, event_id).await?;
        tx.commit().await?;
        let attendee = state
            .db
            .fetch_one_as::<Attendee>("SELECT * FROM calendar.attendees WHERE id = $1", params![attendee_id])
            .await?;
        return Ok(Json(serde_json::json!({ "attendee": attendee })));
    }

    let valid_statuses = ["needs-action", "accepted", "declined", "tentative"];
    if !valid_statuses.contains(&dto.status.as_str()) {
        return Err(CalendarError::Validation(format!("Statut invalide: {}", dto.status)));
    }

    let mut tx = state.db.begin().await?;
    let n = tx
        .execute(
            "UPDATE calendar.attendees SET status = $1, comment = $2, responded_at = $3
             WHERE id = $4 AND user_id = $5",
            params![&dto.status, dto.comment, Utc::now(), attendee_id, user.id],
        )
        .await?;
    if n == 0 {
        tx.rollback().await?;
        return Err(CalendarError::NotFound(format!("Participant {attendee_id}")));
    }
    sync::touch_event(&mut tx, event_id).await?;
    tx.commit().await?;

    let attendee = state
        .db
        .fetch_one_as::<Attendee>("SELECT * FROM calendar.attendees WHERE id = $1", params![attendee_id])
        .await?;

    // A refusal may have emptied the meeting; the room it holds is then given back.
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
    if !guest_rights(&state, event_id, user.id).await?.is_host {
        return Err(CalendarError::Forbidden);
    }

    let mut tx = state.db.begin().await?;
    tx.execute(
        "DELETE FROM calendar.attendees WHERE id = $1 AND event_id = $2",
        params![attendee_id, event_id],
    )
    .await?;
    sync::touch_event(&mut tx, event_id).await?;
    tx.commit().await?;

    Ok(StatusCode::NO_CONTENT)
}
