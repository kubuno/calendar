use chrono::{DateTime, Duration, Utc};
use sqlx::PgPool;
use uuid::Uuid;

use crate::{
    errors::{CalendarError, Result},
    models::event::{CreateEventDto, Event, EventInstance, EventsQuery, RecurrenceScope, UpdateEventDto},
    services::recurrence_service::RecurrenceService,
};

/// Couleur d'un calendrier, issue d'une JOIN.
struct CalColor {
    id:    Uuid,
    color: String,
}

pub struct EventService;

impl EventService {
    /// List the occurrences (instances) within the [from, until] window.
    pub async fn list(
        user_id: Uuid,
        query: EventsQuery,
        db: &PgPool,
    ) -> Result<Vec<EventInstance>> {
        let from  = query.from.unwrap_or_else(Utc::now);
        let until = query.until.unwrap_or_else(|| from + Duration::days(30));

        // Fetch the accessible calendars and their color
        let cal_colors: Vec<CalColor> = sqlx::query_as::<_, (Uuid, String)>(
            r#"
            SELECT DISTINCT c.id, c.color
            FROM calendar.calendars c
            LEFT JOIN calendar.calendar_shares cs ON cs.calendar_id = c.id AND cs.shared_with = $1
            WHERE c.owner_id = $1 OR cs.shared_with = $1
            "#,
        )
        .bind(user_id)
        .fetch_all(db)
        .await?
        .into_iter()
        .map(|(id, color)| CalColor { id, color })
        .collect();

        let cal_ids: Vec<Uuid> = if let Some(cid) = query.calendar_id {
            if cal_colors.iter().any(|c| c.id == cid) {
                vec![cid]
            } else {
                return Err(CalendarError::Forbidden);
            }
        } else {
            cal_colors.iter().map(|c| c.id).collect()
        };

        if cal_ids.is_empty() {
            return Ok(vec![]);
        }

        // Load the base events within the window
        // Includes recurring ones starting before until (for expansion)
        let base_events: Vec<Event> = sqlx::query_as::<_, Event>(
            r#"
            SELECT * FROM calendar.events
            WHERE calendar_id = ANY($1)
              AND parent_event_id IS NULL
              AND (
                  -- Plain events within the window
                  (rrule IS NULL AND starts_at < $3 AND ends_at > $2)
                  OR
                  -- Recurring: load them all and filter through expansion
                  (rrule IS NOT NULL AND starts_at < $3)
              )
            ORDER BY starts_at
            "#,
        )
        .bind(&cal_ids)
        .bind(from)
        .bind(until)
        .fetch_all(db)
        .await?;

        // Load the occurrence exceptions within the window
        let exception_events: Vec<Event> = sqlx::query_as::<_, Event>(
            r#"
            SELECT * FROM calendar.events
            WHERE calendar_id = ANY($1)
              AND parent_event_id IS NOT NULL
              AND starts_at < $3 AND ends_at > $2
            "#,
        )
        .bind(&cal_ids)
        .bind(from)
        .bind(until)
        .fetch_all(db)
        .await?;

        let color_map: std::collections::HashMap<Uuid, String> =
            cal_colors.into_iter().map(|c| (c.id, c.color)).collect();

        let mut instances: Vec<EventInstance> = Vec::new();

        for event in &base_events {
            // Event color (otherwise inherited from the calendar).
            let color = event.color.clone().or_else(|| color_map.get(&event.calendar_id).cloned());
            if event.rrule.is_some() {
                let expanded = RecurrenceService::expand(event, color, from, until);
                instances.extend(expanded);
            } else {
                instances.push(RecurrenceService::single_to_instance(event, color));
            }
        }

        // Remove the occurrences replaced by exceptions
        // and add the exceptions themselves
        for exc in &exception_events {
            let parent_id     = exc.parent_event_id.unwrap();
            let recurrence_ts = exc.recurrence_id.map(|d| d.timestamp()).unwrap_or(0);
            // Supprimer l'occurrence originale
            instances.retain(|i| {
                !(i.event_id == parent_id
                    && i.starts_at.timestamp() == recurrence_ts)
            });
            let color = color_map.get(&exc.calendar_id).cloned();
            if exc.status != "cancelled" {
                instances.push(RecurrenceService::single_to_instance(exc, color));
            }
        }

        // Participation status of the requesting user on the events they were
        // invited to — one lookup for the whole window, so the client can honour
        // the "show declined events" preference without a request per event.
        let event_ids: Vec<Uuid> = {
            let mut ids: Vec<Uuid> = instances.iter().map(|i| i.event_id).collect();
            ids.sort_unstable();
            ids.dedup();
            ids
        };
        if !event_ids.is_empty() {
            let rows: Vec<(Uuid, String)> = sqlx::query_as(
                r#"
                SELECT event_id, status
                FROM calendar.attendees
                WHERE user_id = $1 AND event_id = ANY($2)
                "#,
            )
            .bind(user_id)
            .bind(&event_ids)
            .fetch_all(db)
            .await
            .map_err(|e| {
                tracing::error!(error = %e, "chargement des statuts de participation");
                e
            })?;
            let status_map: std::collections::HashMap<Uuid, String> = rows.into_iter().collect();
            for inst in instances.iter_mut() {
                inst.my_status = status_map.get(&inst.event_id).cloned();
            }
        }

        instances.sort_by_key(|i| i.starts_at);
        Ok(instances)
    }

    /// Fetch an event by its ID.
    pub async fn get(id: Uuid, user_id: Uuid, db: &PgPool) -> Result<Event> {
        let event = sqlx::query_as::<_, Event>(
            r#"
            SELECT e.*
            FROM calendar.events e
            JOIN calendar.calendars c ON c.id = e.calendar_id
            LEFT JOIN calendar.calendar_shares cs ON cs.calendar_id = c.id AND cs.shared_with = $2
            WHERE e.id = $1
              AND (c.owner_id = $2 OR cs.shared_with = $2 OR c.is_public = TRUE)
            LIMIT 1
            "#,
        )
        .bind(id)
        .bind(user_id)
        .fetch_optional(db)
        .await?
        .ok_or_else(|| CalendarError::NotFound(format!("Événement {id}")))?;
        Ok(event)
    }

    /// Create a new event.
    pub async fn create(user_id: Uuid, dto: CreateEventDto, db: &PgPool) -> Result<Event> {
        // Validate the RRULE when present
        if let Some(ref rrule) = dto.rrule {
            RecurrenceService::validate_rrule(rrule)?;
        }

        // Check access to the calendar
        Self::check_calendar_write_access(dto.calendar_id, user_id, db).await?;

        let all_day   = dto.all_day.unwrap_or(false);
        let timezone  = dto.timezone.unwrap_or_else(|| "UTC".to_string());
        let reminders = dto.reminders.unwrap_or(serde_json::json!([]));
        let status    = dto.status.unwrap_or_else(|| "confirmed".to_string());
        let visibility = dto.visibility.unwrap_or_else(|| "public".to_string());
        let busy      = dto.busy.unwrap_or(true);
        let ical_uid  = format!("{}@kubuno.local", Uuid::new_v4());

        let event = sqlx::query_as::<_, Event>(
            r#"
            INSERT INTO calendar.events
                (id, calendar_id, owner_id, title, description, location, url,
                 starts_at, ends_at, all_day, timezone, rrule, reminders,
                 ical_uid, status, visibility, busy, color)
            VALUES (COALESCE($18, uuid_generate_v4()), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
                    $13, $14, $15, $16, $17)
            RETURNING *
            "#,
        )
        .bind(dto.calendar_id)
        .bind(user_id)
        .bind(&dto.title)
        .bind(&dto.description)
        .bind(&dto.location)
        .bind(&dto.url)
        .bind(dto.starts_at)
        .bind(dto.ends_at)
        .bind(all_day)
        .bind(&timezone)
        .bind(&dto.rrule)
        .bind(&reminders)
        .bind(&ical_uid)
        .bind(&status)
        .bind(&visibility)
        .bind(busy)
        .bind(&dto.color)
        .bind(dto.id)
        .fetch_one(db)
        .await?;

        // Update the calendar's ctag
        sqlx::query("UPDATE calendar.calendars SET ctag = md5(random()::text) WHERE id = $1")
            .bind(dto.calendar_id)
            .execute(db)
            .await?;

        Ok(event)
    }

    /// Imports an event coming from an `.ics` file, preserving its iCalendar
    /// `UID` so re-importing the same file is idempotent (upsert on `ical_uid`).
    ///
    /// Returns `Some(true)` when a new event was inserted, `Some(false)` when an
    /// existing one was updated, and `None` when the matching `ical_uid` belongs
    /// to another owner (skipped, never overwritten).
    pub async fn import_event(
        user_id: Uuid,
        dto: CreateEventDto,
        ical_uid: &str,
        db: &PgPool,
    ) -> Result<Option<bool>> {
        if let Some(ref rrule) = dto.rrule {
            RecurrenceService::validate_rrule(rrule)?;
        }

        Self::check_calendar_write_access(dto.calendar_id, user_id, db).await?;

        let all_day    = dto.all_day.unwrap_or(false);
        let timezone   = dto.timezone.unwrap_or_else(|| "UTC".to_string());
        let reminders  = dto.reminders.unwrap_or(serde_json::json!([]));
        let status     = dto.status.unwrap_or_else(|| "confirmed".to_string());
        let visibility = dto.visibility.unwrap_or_else(|| "public".to_string());
        let busy       = dto.busy.unwrap_or(true);

        // `xmax = 0` is true only for freshly inserted rows, letting us tell an
        // insert apart from an update. The `WHERE owner_id = ...` guard keeps an
        // import from overwriting another user's event that shares the same UID.
        let inserted: Option<bool> = sqlx::query_scalar(
            r#"
            INSERT INTO calendar.events
                (calendar_id, owner_id, title, description, location, url,
                 starts_at, ends_at, all_day, timezone, rrule, reminders,
                 ical_uid, status, visibility, busy, color)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
                    $13, $14, $15, $16, $17)
            ON CONFLICT (ical_uid) DO UPDATE SET
                calendar_id = EXCLUDED.calendar_id,
                title       = EXCLUDED.title,
                description = EXCLUDED.description,
                location    = EXCLUDED.location,
                url         = EXCLUDED.url,
                starts_at   = EXCLUDED.starts_at,
                ends_at     = EXCLUDED.ends_at,
                all_day     = EXCLUDED.all_day,
                timezone    = EXCLUDED.timezone,
                rrule       = EXCLUDED.rrule,
                sequence    = calendar.events.sequence + 1,
                etag        = md5(random()::text),
                updated_at  = now()
            WHERE calendar.events.owner_id = EXCLUDED.owner_id
            RETURNING (xmax = 0)
            "#,
        )
        .bind(dto.calendar_id)
        .bind(user_id)
        .bind(&dto.title)
        .bind(&dto.description)
        .bind(&dto.location)
        .bind(&dto.url)
        .bind(dto.starts_at)
        .bind(dto.ends_at)
        .bind(all_day)
        .bind(&timezone)
        .bind(&dto.rrule)
        .bind(&reminders)
        .bind(ical_uid)
        .bind(&status)
        .bind(&visibility)
        .bind(busy)
        .bind(&dto.color)
        .fetch_optional(db)
        .await?;

        if inserted.is_some() {
            sqlx::query("UPDATE calendar.calendars SET ctag = md5(random()::text) WHERE id = $1")
                .bind(dto.calendar_id)
                .execute(db)
                .await?;
        }

        Ok(inserted)
    }

    /// Update an event, handling the recurrence scope.
    pub async fn update(
        id: Uuid,
        user_id: Uuid,
        dto: UpdateEventDto,
        scope: RecurrenceScope,
        occurrence_dt: Option<DateTime<Utc>>,
        db: &PgPool,
    ) -> Result<Event> {
        let event = Self::get_owned(id, user_id, db).await?;

        if let Some(ref rrule) = dto.rrule {
            RecurrenceService::validate_rrule(rrule)?;
        }

        // "This event only" on a series: detach the occurrence — exdate on
        // the master + a standalone copy (without rrule) carrying the changes,
        // linked via parent_event_id so that "this and following" can purge
        // future exceptions.
        if matches!(scope, RecurrenceScope::This) && event.rrule.is_some() {
            if let Some(occ) = occurrence_dt {
                sqlx::query(
                    "UPDATE calendar.events
                        SET exdates = array_append(exdates, $2),
                            sequence = sequence + 1, etag = md5(random()::text)
                      WHERE id = $1",
                )
                .bind(id)
                .bind(occ)
                .execute(db)
                .await?;

                let occ_duration = event.ends_at - event.starts_at;
                let new_dto = CreateEventDto {
                    id: None,
                    calendar_id: dto.calendar_id.unwrap_or(event.calendar_id),
                    title:       dto.title.unwrap_or(event.title),
                    description: dto.description.or(event.description),
                    location:    dto.location.or(event.location),
                    url:         dto.url.or(event.url),
                    starts_at:   dto.starts_at.unwrap_or(occ),
                    ends_at:     dto.ends_at.unwrap_or(occ + occ_duration),
                    all_day:     dto.all_day.or(Some(event.all_day)),
                    timezone:    dto.timezone.or(Some(event.timezone)),
                    color:       if dto.clear_color { None } else { dto.color.or(event.color) },
                    rrule:       None,
                    reminders:   dto.reminders.or(Some(event.reminders)),
                    status:      dto.status.or(Some(event.status)),
                    visibility:  dto.visibility.or(Some(event.visibility)),
                    busy:        dto.busy.or(Some(event.busy)),
                };
                let created = Self::create(user_id, new_dto, db).await?;
                sqlx::query("UPDATE calendar.events SET parent_event_id = $2 WHERE id = $1")
                    .bind(created.id)
                    .bind(id)
                    .execute(db)
                    .await?;
                return Ok(created);
            }
        }

        match scope {
            RecurrenceScope::All | RecurrenceScope::This => {
                // Direct update of the event
                let title      = dto.title.unwrap_or(event.title);
                let description = dto.description.or(event.description);
                let location   = dto.location.or(event.location);
                let url        = dto.url.or(event.url);
                let starts_at  = dto.starts_at.unwrap_or(event.starts_at);
                let ends_at    = dto.ends_at.unwrap_or(event.ends_at);
                let all_day    = dto.all_day.unwrap_or(event.all_day);
                let timezone   = dto.timezone.unwrap_or(event.timezone);
                let rrule      = if dto.clear_rrule { None } else if dto.rrule.is_some() { dto.rrule } else { event.rrule };
                let reminders  = dto.reminders.unwrap_or(event.reminders);
                let status     = dto.status.unwrap_or(event.status);
                let visibility = dto.visibility.unwrap_or(event.visibility);
                let busy       = dto.busy.unwrap_or(event.busy);
                let color      = if dto.clear_color { None } else { dto.color.or(event.color) };

                let updated = sqlx::query_as::<_, Event>(
                    r#"
                    UPDATE calendar.events
                    SET title = $2, description = $3, location = $4, url = $5,
                        starts_at = $6, ends_at = $7, all_day = $8, timezone = $9,
                        rrule = $10, reminders = $11, status = $12, visibility = $13,
                        busy = $14, color = $15, sequence = sequence + 1,
                        etag = md5(random()::text)
                    WHERE id = $1
                    RETURNING *
                    "#,
                )
                .bind(id)
                .bind(&title)
                .bind(&description)
                .bind(&location)
                .bind(&url)
                .bind(starts_at)
                .bind(ends_at)
                .bind(all_day)
                .bind(&timezone)
                .bind(&rrule)
                .bind(&reminders)
                .bind(&status)
                .bind(&visibility)
                .bind(busy)
                .bind(&color)
                .fetch_one(db)
                .await?;

                // Update ctag
                sqlx::query("UPDATE calendar.calendars SET ctag = md5(random()::text) WHERE id = $1")
                    .bind(event.calendar_id)
                    .execute(db)
                    .await?;

                Ok(updated)
            }
            RecurrenceScope::Following => {
                // Truncate the parent recurrence and create a new master
                // for the following occurrences
                let starts_at_new = occurrence_dt.or(dto.starts_at).unwrap_or(event.starts_at);

                // End the parent recurrence just before this occurrence
                let old_until = starts_at_new - Duration::seconds(1);
                let until_str = old_until.format("%Y%m%dT%H%M%SZ").to_string();
                let new_rrule = event
                    .rrule
                    .as_deref()
                    .map(|r| Self::truncated_rrule(r, &until_str))
                    .unwrap_or_default();

                sqlx::query("UPDATE calendar.events SET rrule = $2 WHERE id = $1")
                    .bind(id)
                    .bind(&new_rrule)
                    .execute(db)
                    .await?;

                // Create a new master with the new values
                let new_dto = CreateEventDto {
                id: None,
                    calendar_id:  dto.calendar_id.unwrap_or(event.calendar_id),
                    title:        dto.title.unwrap_or(event.title),
                    description:  dto.description.or(event.description),
                    location:     dto.location.or(event.location),
                    url:          dto.url.or(event.url),
                    starts_at:    starts_at_new,
                    ends_at:      dto.ends_at.unwrap_or(event.ends_at),
                    all_day:      dto.all_day.or(Some(event.all_day)),
                    timezone:     dto.timezone.or(Some(event.timezone)),
                    color:        if dto.clear_color { None } else { dto.color.or(event.color) },
                    rrule:        dto.rrule.or(event.rrule),
                    reminders:    dto.reminders.or(Some(event.reminders)),
                    status:       dto.status.or(Some(event.status)),
                    visibility:   dto.visibility.or(Some(event.visibility)),
                    busy:         dto.busy.or(Some(event.busy)),
                };
                Self::create(user_id, new_dto, db).await
            }
        }
    }

    /// Delete an event (or a scope of occurrences).
    pub async fn delete(
        id: Uuid,
        user_id: Uuid,
        scope: RecurrenceScope,
        occurrence_dt: Option<DateTime<Utc>>,
        db: &PgPool,
    ) -> Result<()> {
        let event = Self::get_owned(id, user_id, db).await?;

        match scope {
            RecurrenceScope::All => {
                sqlx::query("DELETE FROM calendar.events WHERE id = $1")
                    .bind(id)
                    .execute(db)
                    .await?;
            }
            RecurrenceScope::This => {
                // Add an exdate to hide this occurrence
                if let Some(occ_dt) = occurrence_dt {
                    sqlx::query(
                        "UPDATE calendar.events SET exdates = array_append(exdates, $2) WHERE id = $1",
                    )
                    .bind(id)
                    .bind(occ_dt)
                    .execute(db)
                    .await?;
                } else {
                    sqlx::query("DELETE FROM calendar.events WHERE id = $1")
                        .bind(id)
                        .execute(db)
                        .await?;
                }
            }
            RecurrenceScope::Following => {
                if let Some(occ_dt) = occurrence_dt {
                    let until = occ_dt - Duration::seconds(1);
                    let until_str = until.format("%Y%m%dT%H%M%SZ").to_string();
                    let new_rrule = event
                        .rrule
                        .as_deref()
                        .map(|r| Self::truncated_rrule(r, &until_str))
                        .unwrap_or_default();
                    sqlx::query("UPDATE calendar.events SET rrule = $2 WHERE id = $1")
                        .bind(id)
                        .bind(&new_rrule)
                        .execute(db)
                        .await?;
                    // Remove future exceptions
                    sqlx::query(
                        "DELETE FROM calendar.events WHERE parent_event_id = $1 AND starts_at >= $2",
                    )
                    .bind(id)
                    .bind(occ_dt)
                    .execute(db)
                    .await?;
                }
            }
        }

        sqlx::query("UPDATE calendar.calendars SET ctag = md5(random()::text) WHERE id = $1")
            .bind(event.calendar_id)
            .execute(db)
            .await?;

        Ok(())
    }

    // ── Helpers ──────────────────────────────────────────────────────────────────

    /// Rewrites an RRULE so the series ends at `until_str`, dropping any prior
    /// UNTIL/COUNT (appending a second UNTIL would produce an invalid rule).
    fn truncated_rrule(rrule: &str, until_str: &str) -> String {
        let base = rrule
            .split(';')
            .filter(|p| {
                let u = p.to_ascii_uppercase();
                !u.starts_with("UNTIL=") && !u.starts_with("COUNT=") && !p.is_empty()
            })
            .collect::<Vec<_>>()
            .join(";");
        format!("{base};UNTIL={until_str}")
    }

    async fn get_owned(id: Uuid, user_id: Uuid, db: &PgPool) -> Result<Event> {
        sqlx::query_as::<_, Event>(
            "SELECT * FROM calendar.events WHERE id = $1 AND owner_id = $2",
        )
        .bind(id)
        .bind(user_id)
        .fetch_optional(db)
        .await?
        .ok_or_else(|| CalendarError::NotFound(format!("Événement {id}")))
    }

    async fn check_calendar_write_access(calendar_id: Uuid, user_id: Uuid, db: &PgPool) -> Result<()> {
        let ok: bool = sqlx::query_scalar(
            r#"
            SELECT EXISTS (
                SELECT 1 FROM calendar.calendars c
                LEFT JOIN calendar.calendar_shares cs
                    ON cs.calendar_id = c.id AND cs.shared_with = $2
                WHERE c.id = $1
                  AND (c.owner_id = $2
                       OR (cs.shared_with = $2 AND cs.permission IN ('write', 'admin')))
            )
            "#,
        )
        .bind(calendar_id)
        .bind(user_id)
        .fetch_one(db)
        .await?;

        if ok {
            Ok(())
        } else {
            Err(CalendarError::Forbidden)
        }
    }
}
