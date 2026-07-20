use chrono::{DateTime, Datelike, Duration, LocalResult, NaiveDate, NaiveDateTime, NaiveTime, TimeZone, Utc};
use chrono_tz::Tz;
use sqlx::PgPool;
use uuid::Uuid;

use crate::{
    errors::{CalendarError, Result},
    models::{
        appointment::{
            AppointmentAvailability, AppointmentBooking, AppointmentSchedule, BookDto,
            PublicSchedule, SaveScheduleDto, ScheduleWithRules, Slot,
        },
        event::CreateEventDto,
    },
    services::{event_service::EventService, recurrence_service::RecurrenceService},
};

pub struct AppointmentService;

impl AppointmentService {
    // ── CRUD (owner) ────────────────────────────────────────────────────────

    pub async fn list(owner_id: Uuid, db: &PgPool) -> Result<Vec<AppointmentSchedule>> {
        let rows = sqlx::query_as::<_, AppointmentSchedule>(
            "SELECT * FROM calendar.appointment_schedules WHERE owner_id = $1 ORDER BY created_at DESC",
        )
        .bind(owner_id)
        .fetch_all(db)
        .await?;
        Ok(rows)
    }

    pub async fn get_with_rules(id: Uuid, owner_id: Uuid, db: &PgPool) -> Result<ScheduleWithRules> {
        let schedule = Self::get_owned(id, owner_id, db).await?;
        let availability = Self::load_rules(id, db).await?;
        Ok(ScheduleWithRules { schedule, availability })
    }

    async fn get_owned(id: Uuid, owner_id: Uuid, db: &PgPool) -> Result<AppointmentSchedule> {
        sqlx::query_as::<_, AppointmentSchedule>(
            "SELECT * FROM calendar.appointment_schedules WHERE id = $1 AND owner_id = $2",
        )
        .bind(id)
        .bind(owner_id)
        .fetch_optional(db)
        .await?
        .ok_or_else(|| CalendarError::NotFound(format!("Planning de rendez-vous {id}")))
    }

    pub async fn load_rules(schedule_id: Uuid, db: &PgPool) -> Result<Vec<AppointmentAvailability>> {
        let rows = sqlx::query_as::<_, AppointmentAvailability>(
            "SELECT * FROM calendar.appointment_availability WHERE schedule_id = $1
             ORDER BY weekday NULLS LAST, specific_date NULLS LAST, start_minute",
        )
        .bind(schedule_id)
        .fetch_all(db)
        .await?;
        Ok(rows)
    }

    /// Create (id = None) or update a schedule, replacing its availability rules.
    pub async fn save(
        owner_id: Uuid,
        id: Option<Uuid>,
        dto: SaveScheduleDto,
        db: &PgPool,
    ) -> Result<ScheduleWithRules> {
        // The target calendar must belong to the owner.
        let owns: Option<(Uuid,)> = sqlx::query_as(
            "SELECT id FROM calendar.calendars WHERE id = $1 AND owner_id = $2",
        )
        .bind(dto.calendar_id)
        .bind(owner_id)
        .fetch_optional(db)
        .await?;
        if owns.is_none() {
            return Err(CalendarError::Validation("Agenda cible introuvable".into()));
        }

        let title            = dto.title.unwrap_or_default();
        let timezone         = dto.timezone.unwrap_or_else(|| "UTC".to_string());
        let window_type      = dto.window_type.unwrap_or_else(|| "rolling".to_string());
        let location_type    = dto.location_type.unwrap_or_else(|| "none".to_string());
        let guests_can_invite = dto.guests_can_invite.unwrap_or(true);
        let form_fields      = dto.form_fields.unwrap_or_else(|| serde_json::json!([]));
        let calendar_invite  = dto.calendar_invite.unwrap_or(true);
        let email_reminders  = dto.email_reminders.unwrap_or_else(|| serde_json::json!([1440]));

        let mut tx = db.begin().await?;

        let schedule = if let Some(id) = id {
            // Ensure ownership before updating.
            let _ = Self::get_owned(id, owner_id, db).await?;
            sqlx::query_as::<_, AppointmentSchedule>(
                r#"
                UPDATE calendar.appointment_schedules SET
                    calendar_id = $2, title = $3, description = $4, color = $5,
                    duration_minutes = $6, buffer_minutes = $7, max_per_day = $8, timezone = $9,
                    window_type = $10, window_max_days = $11, window_min_hours = $12,
                    window_start_date = $13, window_end_date = $14,
                    location_type = $15, location_details = $16, guests_can_invite = $17,
                    host_name = $18, host_avatar_url = $19, form_fields = $20,
                    calendar_invite = $21, email_reminders = $22
                WHERE id = $1 AND owner_id = $23
                RETURNING *
                "#,
            )
            .bind(id)
            .bind(dto.calendar_id).bind(&title).bind(&dto.description).bind(&dto.color)
            .bind(dto.duration_minutes).bind(dto.buffer_minutes).bind(dto.max_per_day).bind(&timezone)
            .bind(&window_type).bind(dto.window_max_days).bind(dto.window_min_hours)
            .bind(dto.window_start_date).bind(dto.window_end_date)
            .bind(&location_type).bind(&dto.location_details).bind(guests_can_invite)
            .bind(&dto.host_name).bind(&dto.host_avatar_url).bind(&form_fields)
            .bind(calendar_invite).bind(&email_reminders)
            .bind(owner_id)
            .fetch_one(&mut *tx)
            .await?
        } else {
            sqlx::query_as::<_, AppointmentSchedule>(
                r#"
                INSERT INTO calendar.appointment_schedules
                    (owner_id, calendar_id, title, description, color, duration_minutes,
                     buffer_minutes, max_per_day, timezone, window_type, window_max_days,
                     window_min_hours, window_start_date, window_end_date, location_type,
                     location_details, guests_can_invite, host_name, host_avatar_url,
                     form_fields, calendar_invite, email_reminders)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
                RETURNING *
                "#,
            )
            .bind(owner_id)
            .bind(dto.calendar_id).bind(&title).bind(&dto.description).bind(&dto.color)
            .bind(dto.duration_minutes).bind(dto.buffer_minutes).bind(dto.max_per_day).bind(&timezone)
            .bind(&window_type).bind(dto.window_max_days).bind(dto.window_min_hours)
            .bind(dto.window_start_date).bind(dto.window_end_date)
            .bind(&location_type).bind(&dto.location_details).bind(guests_can_invite)
            .bind(&dto.host_name).bind(&dto.host_avatar_url).bind(&form_fields)
            .bind(calendar_invite).bind(&email_reminders)
            .fetch_one(&mut *tx)
            .await?
        };

        // Replace availability rules wholesale.
        sqlx::query("DELETE FROM calendar.appointment_availability WHERE schedule_id = $1")
            .bind(schedule.id)
            .execute(&mut *tx)
            .await?;
        for rule in &dto.availability {
            sqlx::query(
                "INSERT INTO calendar.appointment_availability
                    (schedule_id, weekday, specific_date, start_minute, end_minute)
                 VALUES ($1, $2, $3, $4, $5)",
            )
            .bind(schedule.id)
            .bind(rule.weekday)
            .bind(rule.specific_date)
            .bind(rule.start_minute)
            .bind(rule.end_minute)
            .execute(&mut *tx)
            .await?;
        }

        tx.commit().await?;
        let availability = Self::load_rules(schedule.id, db).await?;
        Ok(ScheduleWithRules { schedule, availability })
    }

    pub async fn delete(id: Uuid, owner_id: Uuid, db: &PgPool) -> Result<()> {
        let res = sqlx::query(
            "DELETE FROM calendar.appointment_schedules WHERE id = $1 AND owner_id = $2",
        )
        .bind(id)
        .bind(owner_id)
        .execute(db)
        .await?;
        if res.rows_affected() == 0 {
            return Err(CalendarError::NotFound(format!("Planning de rendez-vous {id}")));
        }
        Ok(())
    }

    // ── Public read ───────────────────────────────────────────────────────────

    pub async fn get_by_token(token: &str, db: &PgPool) -> Result<AppointmentSchedule> {
        sqlx::query_as::<_, AppointmentSchedule>(
            "SELECT * FROM calendar.appointment_schedules WHERE public_token = $1",
        )
        .bind(token)
        .fetch_optional(db)
        .await?
        .ok_or_else(|| CalendarError::NotFound("Planning de rendez-vous".into()))
    }

    pub fn to_public(s: &AppointmentSchedule) -> PublicSchedule {
        PublicSchedule {
            token:            s.public_token.clone(),
            title:            s.title.clone(),
            description:      s.description.clone(),
            color:            s.color.clone(),
            duration_minutes: s.duration_minutes,
            timezone:         s.timezone.clone(),
            location_type:    s.location_type.clone(),
            location_details: s.location_details.clone(),
            host_name:        s.host_name.clone(),
            host_avatar_url:  s.host_avatar_url.clone(),
            form_fields:      s.form_fields.clone(),
        }
    }

    // ── Slot computation ──────────────────────────────────────────────────────

    /// Bookable slots for a schedule within [from, until], honouring the
    /// scheduling window (max days / min notice / fixed range), weekly & date
    /// availability rules, buffers, per-day caps, existing busy events and
    /// prior bookings.
    pub async fn compute_slots(
        schedule: &AppointmentSchedule,
        rules: &[AppointmentAvailability],
        from: DateTime<Utc>,
        until: DateTime<Utc>,
        db: &PgPool,
    ) -> Result<Vec<Slot>> {
        let tz: Tz = schedule.timezone.parse().unwrap_or(chrono_tz::UTC);
        let now = Utc::now();

        // Effective window bounds.
        let min_start = now + Duration::hours(schedule.window_min_hours.unwrap_or(0) as i64);
        let (win_start, win_end) = match schedule.window_type.as_str() {
            "fixed" => {
                let s = schedule
                    .window_start_date
                    .and_then(|d| day_start_utc(&tz, d))
                    .unwrap_or(now);
                let e = schedule
                    .window_end_date
                    .and_then(|d| day_start_utc(&tz, d.succ_opt().unwrap_or(d)))
                    .unwrap_or_else(|| now + Duration::days(60));
                (s.max(min_start), e)
            }
            _ => {
                let days = schedule.window_max_days.unwrap_or(60) as i64;
                (min_start, now + Duration::days(days))
            }
        };

        let eff_from = from.max(win_start);
        let eff_until = until.min(win_end);
        if eff_from >= eff_until {
            return Ok(vec![]);
        }

        let duration = Duration::minutes(schedule.duration_minutes as i64);
        let step = Duration::minutes((schedule.duration_minutes + schedule.buffer_minutes.unwrap_or(0)) as i64);

        // Busy intervals (owner's events + this schedule's confirmed bookings).
        let busy = Self::load_busy(schedule.owner_id, schedule.id, eff_from, eff_until, db).await?;
        // Confirmed bookings bucketed by local day (for the per-day cap).
        let bookings = Self::load_bookings(schedule.id, eff_from, eff_until, db).await?;

        let mut slots: Vec<Slot> = Vec::new();

        // Iterate local dates spanning the effective window (±1 day for tz edges).
        let first_date = eff_from.with_timezone(&tz).date_naive();
        let last_date = eff_until.with_timezone(&tz).date_naive();
        let mut date = first_date;
        while date <= last_date {
            // Per-day cap: count confirmed bookings starting on this local day.
            if let Some(cap) = schedule.max_per_day {
                let count = bookings
                    .iter()
                    .filter(|b| b.with_timezone(&tz).date_naive() == date)
                    .count() as i32;
                if count >= cap {
                    date = date.succ_opt().unwrap_or(date);
                    if date == first_date { break; }
                    continue;
                }
            }

            // Date-specific overrides replace weekly rules for that date.
            let weekday = date.weekday().num_days_from_monday() as i16;
            let day_windows: Vec<&AppointmentAvailability> = {
                let specific: Vec<&AppointmentAvailability> =
                    rules.iter().filter(|r| r.specific_date == Some(date)).collect();
                if !specific.is_empty() {
                    specific
                } else {
                    rules.iter().filter(|r| r.weekday == Some(weekday)).collect()
                }
            };

            for w in day_windows {
                let mut m = w.start_minute;
                while m + schedule.duration_minutes <= w.end_minute {
                    if let Some(start) = local_to_utc(&tz, date, m) {
                        let end = start + duration;
                        let free = start >= min_start
                            && start >= eff_from
                            && end <= eff_until
                            && !busy.iter().any(|(bs, be)| *bs < end && *be > start);
                        if free {
                            slots.push(Slot { starts_at: start, ends_at: end });
                        }
                    }
                    m += step.num_minutes() as i32;
                }
            }

            let next = date.succ_opt().unwrap_or(date);
            if next == date { break; }
            date = next;
        }

        slots.sort_by_key(|s| s.starts_at);
        slots.dedup_by_key(|s| s.starts_at);
        Ok(slots)
    }

    /// Busy intervals for the owner in the window: `busy` events (recurrences
    /// expanded) plus this schedule's confirmed bookings.
    async fn load_busy(
        owner_id: Uuid,
        schedule_id: Uuid,
        from: DateTime<Utc>,
        until: DateTime<Utc>,
        db: &PgPool,
    ) -> Result<Vec<(DateTime<Utc>, DateTime<Utc>)>> {
        let events: Vec<crate::models::event::Event> = sqlx::query_as(
            r#"
            SELECT e.* FROM calendar.events e
            WHERE e.owner_id = $1 AND e.busy = TRUE AND e.status != 'cancelled'
              AND (
                    (e.rrule IS NULL AND e.starts_at < $3 AND e.ends_at > $2)
                 OR (e.rrule IS NOT NULL AND e.starts_at < $3)
              )
            "#,
        )
        .bind(owner_id)
        .bind(from)
        .bind(until)
        .fetch_all(db)
        .await?;

        let mut busy: Vec<(DateTime<Utc>, DateTime<Utc>)> = Vec::new();
        for e in &events {
            if e.rrule.is_some() {
                for occ in RecurrenceService::expand(e, None, from, until) {
                    busy.push((occ.starts_at, occ.ends_at));
                }
            } else {
                busy.push((e.starts_at, e.ends_at));
            }
        }

        let booked: Vec<(DateTime<Utc>, DateTime<Utc>)> = sqlx::query_as(
            "SELECT starts_at, ends_at FROM calendar.appointment_bookings
             WHERE schedule_id = $1 AND status = 'confirmed' AND starts_at < $3 AND ends_at > $2",
        )
        .bind(schedule_id)
        .bind(from)
        .bind(until)
        .fetch_all(db)
        .await?;
        busy.extend(booked);

        Ok(busy)
    }

    async fn load_bookings(
        schedule_id: Uuid,
        from: DateTime<Utc>,
        until: DateTime<Utc>,
        db: &PgPool,
    ) -> Result<Vec<DateTime<Utc>>> {
        let rows: Vec<(DateTime<Utc>,)> = sqlx::query_as(
            "SELECT starts_at FROM calendar.appointment_bookings
             WHERE schedule_id = $1 AND status = 'confirmed' AND starts_at >= $2 AND starts_at < $3",
        )
        .bind(schedule_id)
        .bind(from)
        .bind(until)
        .fetch_all(db)
        .await?;
        Ok(rows.into_iter().map(|r| r.0).collect())
    }

    // ── Booking ───────────────────────────────────────────────────────────────

    pub async fn book(token: &str, dto: BookDto, db: &PgPool) -> Result<AppointmentBooking> {
        let schedule = Self::get_by_token(token, db).await?;
        let rules = Self::load_rules(schedule.id, db).await?;
        let duration = Duration::minutes(schedule.duration_minutes as i64);
        let ends_at = dto.starts_at + duration;

        // Re-validate the requested slot against live availability (prevents
        // double-booking and out-of-window requests).
        let window_from = dto.starts_at - Duration::minutes(1);
        let window_until = ends_at + Duration::minutes(1);
        let slots = Self::compute_slots(&schedule, &rules, window_from, window_until, db).await?;
        if !slots.iter().any(|s| s.starts_at == dto.starts_at) {
            return Err(CalendarError::Conflict("Ce créneau n'est plus disponible".into()));
        }

        // Create the event on the owner's calendar.
        let booker = match &dto.last_name {
            Some(l) if !l.is_empty() => format!("{} {}", dto.first_name, l),
            _ => dto.first_name.clone(),
        };
        let base_title = if schedule.title.is_empty() { "Rendez-vous".to_string() } else { schedule.title.clone() };
        let event_title = format!("{base_title} — {booker}");
        let location = match schedule.location_type.as_str() {
            "in_person" => schedule.location_details.clone(),
            "phone"     => Some(format!("Téléphone{}", schedule.location_details.as_deref().map(|d| format!(" : {d}")).unwrap_or_default())),
            "video"     => schedule.location_details.clone(),
            _           => None,
        };
        let event = EventService::create(
            schedule.owner_id,
            CreateEventDto {
                id: None,
                calendar_id: schedule.calendar_id,
                title: event_title,
                description: Some(format!("Réservé par {booker} <{}>", dto.email)),
                location,
                url: None,
                starts_at: dto.starts_at,
                ends_at,
                all_day: Some(false),
                timezone: Some(schedule.timezone.clone()),
                color: schedule.color.clone(),
                rrule: None,
                reminders: Some(schedule.email_reminders.clone()),
                status: Some("confirmed".to_string()),
                visibility: Some("public".to_string()),
                busy: Some(true),
            },
            db,
        )
        .await?;

        let booking = sqlx::query_as::<_, AppointmentBooking>(
            r#"
            INSERT INTO calendar.appointment_bookings
                (schedule_id, starts_at, ends_at, first_name, last_name, email, answers, note, event_id)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
            RETURNING *
            "#,
        )
        .bind(schedule.id)
        .bind(dto.starts_at)
        .bind(ends_at)
        .bind(&dto.first_name)
        .bind(&dto.last_name)
        .bind(&dto.email)
        .bind(&dto.answers)
        .bind(&dto.note)
        .bind(event.id)
        .fetch_one(db)
        .await?;

        Ok(booking)
    }

    pub async fn list_bookings(schedule_id: Uuid, owner_id: Uuid, db: &PgPool) -> Result<Vec<AppointmentBooking>> {
        let _ = Self::get_owned(schedule_id, owner_id, db).await?;
        let rows = sqlx::query_as::<_, AppointmentBooking>(
            "SELECT * FROM calendar.appointment_bookings WHERE schedule_id = $1 ORDER BY starts_at",
        )
        .bind(schedule_id)
        .fetch_all(db)
        .await?;
        Ok(rows)
    }
}

// ── Timezone helpers ────────────────────────────────────────────────────────

fn local_to_utc(tz: &Tz, date: NaiveDate, minute: i32) -> Option<DateTime<Utc>> {
    let (h, m) = ((minute / 60) as u32, (minute % 60) as u32);
    let time = NaiveTime::from_hms_opt(h, m, 0)?;
    match tz.from_local_datetime(&NaiveDateTime::new(date, time)) {
        LocalResult::Single(dt) => Some(dt.with_timezone(&Utc)),
        LocalResult::Ambiguous(a, _) => Some(a.with_timezone(&Utc)),
        LocalResult::None => None,
    }
}

fn day_start_utc(tz: &Tz, date: NaiveDate) -> Option<DateTime<Utc>> {
    local_to_utc(tz, date, 0)
}
