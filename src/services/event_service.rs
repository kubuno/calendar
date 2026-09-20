use chrono::{DateTime, Duration, Utc};
use kubuno_db::{params, DbPool, DbQueryBuilder};
use uuid::Uuid;

use crate::{
    errors::{CalendarError, Result},
    models::event::{CreateEventDto, Event, EventInstance, EventsQuery, RecurrenceScope, UpdateEventDto},
    services::recurrence_service::RecurrenceService,
    sync,
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
        db: &DbPool,
    ) -> Result<Vec<EventInstance>> {
        let from  = query.from.unwrap_or_else(Utc::now);
        let until = query.until.unwrap_or_else(|| from + Duration::days(30));

        // Fetch the accessible calendars and their color
        let cal_colors: Vec<CalColor> = db
            .fetch_all_as::<(Uuid, String)>(
                r#"
                SELECT DISTINCT c.id, c.color
                FROM calendar.calendars c
                LEFT JOIN calendar.calendar_shares cs ON cs.calendar_id = c.id AND cs.shared_with = $1
                WHERE c.owner_id = $2 OR cs.shared_with = $3
                "#,
                params![user_id, user_id, user_id],
            )
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

        // Events the user was invited to are shown even when their calendar was
        // never shared: an invitation is its own grant of visibility. This only
        // applies to an unfiltered listing — filtering by a specific calendar
        // must not pull in meetings that live in someone else's.
        let include_invited = query.calendar_id.is_none();

        if cal_ids.is_empty() && !include_invited {
            return Ok(vec![]);
        }

        // Load the base events within the window (recurring ones starting before
        // `until` are loaded whole, for expansion). The `calendar_id IN (...)`
        // list and the "invited" fallback are rendered per-engine by the builder.
        let mut qb = DbQueryBuilder::new(db.backend(), "SELECT * FROM calendar.events WHERE (calendar_id");
        qb.push_in(cal_ids.iter().copied())
            .push(" OR (")
            .push_bind(include_invited)
            .push(" AND id IN (SELECT event_id FROM calendar.attendees WHERE user_id = ")
            .push_bind(user_id)
            .push("))) AND parent_event_id IS NULL AND ((rrule IS NULL AND starts_at < ")
            .push_bind(until)
            .push(" AND ends_at > ")
            .push_bind(from)
            .push(") OR (rrule IS NOT NULL AND starts_at < ")
            .push_bind(until)
            .push("))");
        qb.push_order_by("starts_at");
        let base_events: Vec<Event> = qb.fetch_all_as::<Event>(db).await?;

        // Load the occurrence exceptions within the window
        let mut qb = DbQueryBuilder::new(db.backend(), "SELECT * FROM calendar.events WHERE (calendar_id");
        qb.push_in(cal_ids.iter().copied())
            .push(" OR (")
            .push_bind(include_invited)
            .push(" AND id IN (SELECT event_id FROM calendar.attendees WHERE user_id = ")
            .push_bind(user_id)
            .push("))) AND parent_event_id IS NOT NULL AND starts_at < ")
            .push_bind(until)
            .push(" AND ends_at > ")
            .push_bind(from);
        let exception_events: Vec<Event> = qb.fetch_all_as::<Event>(db).await?;

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

        // Remove the occurrences replaced by exceptions and add the exceptions.
        for exc in &exception_events {
            let parent_id     = exc.parent_event_id.unwrap();
            let recurrence_ts = exc.recurrence_id.map(|d| d.timestamp()).unwrap_or(0);
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
        // invited to — one lookup for the whole window.
        let event_ids: Vec<Uuid> = {
            let mut ids: Vec<Uuid> = instances.iter().map(|i| i.event_id).collect();
            ids.sort_unstable();
            ids.dedup();
            ids
        };
        if !event_ids.is_empty() {
            let mut qb = DbQueryBuilder::new(
                db.backend(),
                "SELECT event_id, status FROM calendar.attendees WHERE user_id = ",
            );
            qb.push_bind(user_id).push(" AND event_id").push_in(event_ids.iter().copied());
            let rows: Vec<(Uuid, String)> = qb.fetch_all_as::<(Uuid, String)>(db).await.map_err(|e| {
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

    /// Fetch an event by its ID. `user_id` is bound once per occurrence because
    /// the portable placeholder rewriter forbids reusing a `$n`.
    pub async fn get(id: Uuid, user_id: Uuid, db: &DbPool) -> Result<Event> {
        db.fetch_optional_as::<Event>(
            r#"
            SELECT e.*
            FROM calendar.events e
            JOIN calendar.calendars c ON c.id = e.calendar_id
            LEFT JOIN calendar.calendar_shares cs ON cs.calendar_id = c.id AND cs.shared_with = $1
            LEFT JOIN calendar.attendees a ON a.event_id = e.id AND a.user_id = $2
            WHERE e.id = $3
              AND (c.owner_id = $4 OR cs.shared_with = $5 OR c.is_public = TRUE OR a.id IS NOT NULL)
            LIMIT 1
            "#,
            params![user_id, user_id, id, user_id, user_id],
        )
        .await?
        .ok_or_else(|| CalendarError::NotFound(format!("Événement {id}")))
    }

    fn blank_to_none(v: Option<String>) -> Option<String> {
        v.filter(|s| !s.trim().is_empty())
    }

    fn check_range(starts_at: DateTime<Utc>, ends_at: DateTime<Utc>) -> Result<()> {
        if ends_at < starts_at {
            return Err(CalendarError::Validation(
                "La date de fin ne peut pas précéder la date de début".into(),
            ));
        }
        Ok(())
    }

    /// Refresh a calendar's CalDAV ctag. This does NOT bump the calendar's
    /// `change_seq`: the ctag is a CalDAV concern, and events are pulled through
    /// their own delta feed, so churning the calendar feed on every event write
    /// would be noise. (Mirrors the tasks port, where the ctag trigger no longer
    /// moves the board's change_seq.)
    async fn bump_ctag(db: &DbPool, calendar_id: Uuid) -> Result<()> {
        db.execute(
            "UPDATE calendar.calendars SET ctag = $1 WHERE id = $2",
            params![sync::new_tag(), calendar_id],
        )
        .await?;
        Ok(())
    }

    pub async fn create(user_id: Uuid, dto: CreateEventDto, db: &DbPool) -> Result<Event> {
        let dto = CreateEventDto {
            description: Self::blank_to_none(dto.description),
            location:    Self::blank_to_none(dto.location),
            url:         Self::blank_to_none(dto.url),
            ..dto
        };
        Self::check_range(dto.starts_at, dto.ends_at)?;

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
        let ical_uid   = format!("{}@kubuno.local", Uuid::new_v4());
        let can_modify = dto.guests_can_modify.unwrap_or(false);
        let can_invite = dto.guests_can_invite.unwrap_or(true);
        let can_see    = dto.guests_can_see_guests.unwrap_or(true);

        let event_id = dto.id.unwrap_or_else(kubuno_db::new_id);
        let etag = sync::new_tag();
        let calendar_id = dto.calendar_id;
        let empty_files: Vec<Uuid> = Vec::new();
        let empty_tasks: Vec<Uuid> = Vec::new();
        // JSON array columns have no cross-engine DEFAULT, so they are supplied
        // explicitly (exdates is timestamps, hence a JSON value rather than a Vec).
        let empty_exdates = serde_json::json!([]);

        let mut tx = db.begin().await?;
        let seq = sync::next_event_seq(&mut tx).await?;
        tx.execute(
            r#"
            INSERT INTO calendar.events
                (id, calendar_id, owner_id, title, description, location, url,
                 starts_at, ends_at, all_day, timezone, rrule, exdates, reminders,
                 ical_uid, etag, status, visibility, busy, color,
                 linked_file_ids, linked_task_ids,
                 guests_can_modify, guests_can_invite, guests_can_see_guests, change_seq)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)
            "#,
            params![
                event_id, calendar_id, user_id, dto.title, dto.description, dto.location, dto.url,
                dto.starts_at, dto.ends_at, all_day, timezone, dto.rrule, empty_exdates, reminders,
                ical_uid, etag, status, visibility, busy, dto.color,
                empty_files, empty_tasks, can_modify, can_invite, can_see, seq
            ],
        )
        .await?;
        tx.commit().await?;

        Self::bump_ctag(db, calendar_id).await?;

        db.fetch_one_as::<Event>("SELECT * FROM calendar.events WHERE id = $1", params![event_id])
            .await
            .map_err(Into::into)
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
        db: &DbPool,
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

        // Insert-or-update, decided in Rust rather than through PostgreSQL's
        // `xmax` (which no other engine exposes). The `ical_uid` is unique, so at
        // most one row matches; a row owned by someone else is left untouched.
        let existing: Option<(Uuid, Uuid)> = db
            .fetch_optional_as(
                "SELECT id, owner_id FROM calendar.events WHERE ical_uid = $1",
                params![ical_uid],
            )
            .await?;

        let inserted: Option<bool> = match existing {
            Some((_, owner)) if owner != user_id => None,
            Some((existing_id, _)) => {
                let mut tx = db.begin().await?;
                let seq = sync::next_event_seq(&mut tx).await?;
                tx.execute(
                    r#"
                    UPDATE calendar.events
                    SET calendar_id = $1, title = $2, description = $3, location = $4, url = $5,
                        starts_at = $6, ends_at = $7, all_day = $8, timezone = $9, rrule = $10,
                        sequence = sequence + 1, etag = $11, change_seq = $12
                    WHERE id = $13
                    "#,
                    params![
                        dto.calendar_id, dto.title, dto.description, dto.location, dto.url,
                        dto.starts_at, dto.ends_at, all_day, timezone, dto.rrule,
                        sync::new_tag(), seq, existing_id
                    ],
                )
                .await?;
                tx.commit().await?;
                Some(false)
            }
            None => {
                let event_id = kubuno_db::new_id();
                let empty_files: Vec<Uuid> = Vec::new();
                let empty_tasks: Vec<Uuid> = Vec::new();
                let empty_exdates = serde_json::json!([]);
                let mut tx = db.begin().await?;
                let seq = sync::next_event_seq(&mut tx).await?;
                tx.execute(
                    r#"
                    INSERT INTO calendar.events
                        (id, calendar_id, owner_id, title, description, location, url,
                         starts_at, ends_at, all_day, timezone, rrule, exdates, reminders,
                         ical_uid, etag, status, visibility, busy, color,
                         linked_file_ids, linked_task_ids, change_seq)
                    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
                    "#,
                    params![
                        event_id, dto.calendar_id, user_id, dto.title, dto.description, dto.location,
                        dto.url, dto.starts_at, dto.ends_at, all_day, timezone, dto.rrule, empty_exdates,
                        reminders, ical_uid, sync::new_tag(), status, visibility, busy, dto.color,
                        empty_files, empty_tasks, seq
                    ],
                )
                .await?;
                tx.commit().await?;
                Some(true)
            }
        };

        if inserted.is_some() {
            Self::bump_ctag(db, dto.calendar_id).await?;
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
        db: &DbPool,
    ) -> Result<Event> {
        let event = Self::get_owned(id, user_id, db).await?;
        let dto = if event.owner_id == user_id { dto } else { UpdateEventDto { calendar_id: None, ..dto } };

        let dto = UpdateEventDto {
            description: dto.description.map(|s| s.trim().to_string()),
            location:    dto.location.map(|s| s.trim().to_string()),
            url:         dto.url.map(|s| s.trim().to_string()),
            ..dto
        };
        let clear = |v: Option<String>, old: Option<String>| -> Option<String> {
            match v { Some(s) if s.is_empty() => None, Some(s) => Some(s), None => old }
        };

        if let Some(ref rrule) = dto.rrule {
            RecurrenceService::validate_rrule(rrule)?;
        }

        // "This event only" on a series: detach the occurrence — exdate on the
        // master + a standalone copy (without rrule) carrying the changes.
        if matches!(scope, RecurrenceScope::This) && event.rrule.is_some() {
            if let Some(occ) = occurrence_dt {
                // Append the exdate on the master and bump it (`array_append` has
                // no portable form: read the JSON array, push in Rust, rewrite it).
                let mut new_exdates = event.exdates.clone();
                new_exdates.push(occ);
                let exdates_json = serde_json::json!(new_exdates);
                let mut tx = db.begin().await?;
                let seq = sync::next_event_seq(&mut tx).await?;
                tx.execute(
                    "UPDATE calendar.events
                        SET exdates = $1, sequence = sequence + 1, etag = $2, change_seq = $3
                      WHERE id = $4",
                    params![exdates_json, sync::new_tag(), seq, id],
                )
                .await?;
                tx.commit().await?;

                let occ_duration = event.ends_at - event.starts_at;
                let new_dto = CreateEventDto {
                    id: None,
                    calendar_id: dto.calendar_id.unwrap_or(event.calendar_id),
                    title:       dto.title.unwrap_or(event.title),
                    description: clear(dto.description, event.description),
                    location:    clear(dto.location, event.location),
                    url:         clear(dto.url, event.url),
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
                    attendees:   None,
                    guests_can_modify:     dto.guests_can_modify.or(Some(event.guests_can_modify)),
                    guests_can_invite:     dto.guests_can_invite.or(Some(event.guests_can_invite)),
                    guests_can_see_guests: dto.guests_can_see_guests.or(Some(event.guests_can_see_guests)),
                };
                let created = Self::create(user_id, new_dto, db).await?;

                // Link the copy back to the master (its own delta bump).
                let mut tx = db.begin().await?;
                let seq = sync::next_event_seq(&mut tx).await?;
                tx.execute(
                    "UPDATE calendar.events SET parent_event_id = $1, change_seq = $2 WHERE id = $3",
                    params![id, seq, created.id],
                )
                .await?;
                tx.commit().await?;
                return Ok(created);
            }
        }

        match scope {
            RecurrenceScope::All | RecurrenceScope::This => {
                let title      = dto.title.unwrap_or(event.title);
                let description = clear(dto.description, event.description);
                let location   = clear(dto.location, event.location);
                let url        = clear(dto.url, event.url);
                let starts_at  = dto.starts_at.unwrap_or(event.starts_at);
                let ends_at    = dto.ends_at.unwrap_or(event.ends_at);
                Self::check_range(starts_at, ends_at)?;
                let all_day    = dto.all_day.unwrap_or(event.all_day);
                let timezone   = dto.timezone.unwrap_or(event.timezone);
                let rrule      = if dto.clear_rrule { None } else if dto.rrule.is_some() { dto.rrule } else { event.rrule };
                let reminders  = dto.reminders.unwrap_or(event.reminders);
                let status     = dto.status.unwrap_or(event.status);
                let visibility = dto.visibility.unwrap_or(event.visibility);
                let busy       = dto.busy.unwrap_or(event.busy);
                let color      = if dto.clear_color { None } else { dto.color.or(event.color) };
                let can_modify = dto.guests_can_modify.unwrap_or(event.guests_can_modify);
                let can_invite = dto.guests_can_invite.unwrap_or(event.guests_can_invite);
                let can_see    = dto.guests_can_see_guests.unwrap_or(event.guests_can_see_guests);

                let mut tx = db.begin().await?;
                let seq = sync::next_event_seq(&mut tx).await?;
                tx.execute(
                    r#"
                    UPDATE calendar.events
                    SET title = $1, description = $2, location = $3, url = $4,
                        starts_at = $5, ends_at = $6, all_day = $7, timezone = $8,
                        rrule = $9, reminders = $10, status = $11, visibility = $12,
                        busy = $13, color = $14, sequence = sequence + 1, etag = $15,
                        guests_can_modify = $16, guests_can_invite = $17,
                        guests_can_see_guests = $18, change_seq = $19
                    WHERE id = $20
                    "#,
                    params![
                        title, description, location, url, starts_at, ends_at, all_day, timezone,
                        rrule, reminders, status, visibility, busy, color, sync::new_tag(),
                        can_modify, can_invite, can_see, seq, id
                    ],
                )
                .await?;
                tx.commit().await?;

                Self::bump_ctag(db, event.calendar_id).await?;

                db.fetch_one_as::<Event>("SELECT * FROM calendar.events WHERE id = $1", params![id])
                    .await
                    .map_err(Into::into)
            }
            RecurrenceScope::Following => {
                let starts_at_new = occurrence_dt.or(dto.starts_at).unwrap_or(event.starts_at);

                let old_until = starts_at_new - Duration::seconds(1);
                let until_str = old_until.format("%Y%m%dT%H%M%SZ").to_string();
                let new_rrule = event
                    .rrule
                    .as_deref()
                    .map(|r| Self::truncated_rrule(r, &until_str))
                    .unwrap_or_default();

                let mut tx = db.begin().await?;
                let seq = sync::next_event_seq(&mut tx).await?;
                tx.execute(
                    "UPDATE calendar.events SET rrule = $1, change_seq = $2 WHERE id = $3",
                    params![new_rrule, seq, id],
                )
                .await?;
                tx.commit().await?;

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
                    attendees:    None,
                    guests_can_modify:     Some(event.guests_can_modify),
                    guests_can_invite:     Some(event.guests_can_invite),
                    guests_can_see_guests: Some(event.guests_can_see_guests),
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
        db: &DbPool,
    ) -> Result<()> {
        let event = Self::get_owned(id, user_id, db).await?;

        match scope {
            RecurrenceScope::All => {
                Self::hard_delete_tree(db, id).await?;
            }
            RecurrenceScope::This => {
                if let Some(occ_dt) = occurrence_dt {
                    // Hide this occurrence with an exdate; bump the event.
                    let mut new_exdates = event.exdates.clone();
                    new_exdates.push(occ_dt);
                    let exdates_json = serde_json::json!(new_exdates);
                    let mut tx = db.begin().await?;
                    let seq = sync::next_event_seq(&mut tx).await?;
                    tx.execute(
                        "UPDATE calendar.events SET exdates = $1, change_seq = $2 WHERE id = $3",
                        params![exdates_json, seq, id],
                    )
                    .await?;
                    tx.commit().await?;
                } else {
                    Self::hard_delete_tree(db, id).await?;
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

                    // The future exceptions that will be hard-deleted (read on the
                    // pool: their tombstones are written explicitly, since the FK
                    // cascade fires no application code).
                    let doomed: Vec<(Uuid, Uuid)> = db
                        .fetch_all_as(
                            "SELECT id, owner_id FROM calendar.events WHERE parent_event_id = $1 AND starts_at >= $2",
                            params![id, occ_dt],
                        )
                        .await?;

                    let mut tx = db.begin().await?;
                    let seq = sync::next_event_seq(&mut tx).await?;
                    tx.execute(
                        "UPDATE calendar.events SET rrule = $1, change_seq = $2 WHERE id = $3",
                        params![new_rrule, seq, id],
                    )
                    .await?;
                    for (eid, owner) in &doomed {
                        let s = sync::next_event_seq(&mut tx).await?;
                        kubuno_db::journal::record_tombstone(&mut tx, sync::EVENT_TOMBSTONES, *eid, *owner, s).await?;
                    }
                    tx.execute(
                        "DELETE FROM calendar.events WHERE parent_event_id = $1 AND starts_at >= $2",
                        params![id, occ_dt],
                    )
                    .await?;
                    tx.commit().await?;
                }
            }
        }

        Self::bump_ctag(db, event.calendar_id).await?;
        Ok(())
    }

    /// Hard-deletes an event and every occurrence-exception that cascades from
    /// it, writing a tombstone for each first — the FK `ON DELETE CASCADE` runs
    /// no application code, so the delta feed would otherwise never learn the
    /// children are gone.
    async fn hard_delete_tree(db: &DbPool, id: Uuid) -> Result<()> {
        let doomed: Vec<(Uuid, Uuid)> = db
            .fetch_all_as(
                "SELECT id, owner_id FROM calendar.events WHERE id = $1 OR parent_event_id = $2",
                params![id, id],
            )
            .await?;

        let mut tx = db.begin().await?;
        for (eid, owner) in &doomed {
            let seq = sync::next_event_seq(&mut tx).await?;
            kubuno_db::journal::record_tombstone(&mut tx, sync::EVENT_TOMBSTONES, *eid, *owner, seq).await?;
        }
        tx.execute("DELETE FROM calendar.events WHERE id = $1", params![id]).await?;
        tx.commit().await?;
        Ok(())
    }

    // ── Helpers ──────────────────────────────────────────────────────────────────

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

    /// The event, for someone entitled to change it: its owner, or a guest when
    /// the organiser ticked "Guests can modify the event". `user_id` is bound
    /// three times (the rewriter forbids reusing a `$n`).
    async fn get_owned(id: Uuid, user_id: Uuid, db: &DbPool) -> Result<Event> {
        db.fetch_optional_as::<Event>(
            "SELECT e.* FROM calendar.events e
               LEFT JOIN calendar.attendees a ON a.event_id = e.id AND a.user_id = $1
              WHERE e.id = $2
                AND (e.owner_id = $3 OR (e.guests_can_modify AND a.id IS NOT NULL))",
            params![user_id, id, user_id],
        )
        .await?
        .ok_or_else(|| CalendarError::NotFound(format!("Événement {id}")))
    }

    async fn check_calendar_write_access(calendar_id: Uuid, user_id: Uuid, db: &DbPool) -> Result<()> {
        // A real column is selected (not a `1` literal, whose SQL type differs
        // per engine) so `.is_some()` is the portable "row exists" test.
        let ok = db
            .fetch_optional_scalar::<Uuid>(
                r#"
                SELECT c.id FROM calendar.calendars c
                LEFT JOIN calendar.calendar_shares cs
                    ON cs.calendar_id = c.id AND cs.shared_with = $1
                WHERE c.id = $2
                  AND (c.owner_id = $3
                       OR (cs.shared_with = $4 AND cs.permission IN ('write', 'admin')))
                LIMIT 1
                "#,
                params![user_id, calendar_id, user_id, user_id],
            )
            .await?
            .is_some();

        if ok {
            Ok(())
        } else {
            Err(CalendarError::Forbidden)
        }
    }
}
