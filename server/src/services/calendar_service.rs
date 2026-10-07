use kubuno_db::dialect::Assign;
use kubuno_db::{params, DbPool};
use uuid::Uuid;

use crate::{
    config::InstanceConfig,
    errors::{CalendarError, Result},
    models::calendar::{Calendar, CalendarShare, CreateCalendarDto, ShareCalendarDto, UpdateCalendarDto},
    sync,
};

pub struct CalendarService;

impl CalendarService {
    /// List a user's calendars (own + shared with them).
    pub async fn list(user_id: Uuid, db: &DbPool) -> Result<Vec<Calendar>> {
        // `my_permission` tells the caller what they may do with each calendar
        // ('owner' | 'write' | 'read') so the UI can grey out what's read-only.
        // `user_id` is bound once per placeholder: the portable rewriter forbids
        // reusing a number, so the four occurrences carry four binds.
        let rows = db
            .fetch_all_as::<Calendar>(
                r#"
                SELECT c.*,
                       CASE WHEN c.owner_id = $1 THEN 'owner' ELSE cs.permission END AS my_permission
                FROM calendar.calendars c
                LEFT JOIN calendar.calendar_shares cs
                       ON cs.calendar_id = c.id AND cs.shared_with = $2
                WHERE c.owner_id = $3
                   OR cs.shared_with = $4
                ORDER BY c.is_default DESC, c.name ASC
                "#,
                params![user_id, user_id, user_id, user_id],
            )
            .await?;
        Ok(rows)
    }

    /// List the shares of a calendar (owner only).
    pub async fn list_shares(id: Uuid, owner_id: Uuid, db: &DbPool) -> Result<Vec<CalendarShare>> {
        Self::get_owned(id, owner_id, db).await?;
        let rows = db
            .fetch_all_as::<CalendarShare>(
                "SELECT * FROM calendar.calendar_shares WHERE calendar_id = $1 ORDER BY created_at",
                params![id],
            )
            .await?;
        Ok(rows)
    }

    /// Fetch a calendar by its ID, checking access.
    pub async fn get(id: Uuid, user_id: Uuid, db: &DbPool) -> Result<Calendar> {
        // Placeholders ascend in text order (the JOIN predicate comes first), so
        // `user_id` and `id` are bound in that order and repeated per occurrence.
        let row = db
            .fetch_optional_as::<Calendar>(
                r#"
                SELECT c.*
                FROM calendar.calendars c
                LEFT JOIN calendar.calendar_shares cs ON cs.calendar_id = c.id AND cs.shared_with = $1
                WHERE c.id = $2
                  AND (c.owner_id = $3 OR cs.shared_with = $4 OR c.is_public = TRUE)
                LIMIT 1
                "#,
                params![user_id, id, user_id, user_id],
            )
            .await?
            .ok_or_else(|| CalendarError::NotFound(format!("Calendrier {id}")))?;
        Ok(row)
    }

    /// Refuses one more calendar when the account already sits at the ceiling the
    /// administrator set (`0` = no ceiling).
    ///
    /// Called from the paths a person drives (create, subscribe) and NOT from the
    /// automatic creation of the very first calendar: an account that cannot see
    /// a single calendar has no working module, and a ceiling lowered afterwards
    /// must never produce that.
    pub async fn assert_can_create(
        user_id: Uuid,
        instance: &InstanceConfig,
        db: &DbPool,
    ) -> Result<()> {
        if instance.max_calendars_per_user <= 0 {
            return Ok(());
        }
        let count_expr = db.backend().count_bigint("*");
        let owned: i64 = db
            .fetch_scalar(
                &format!("SELECT {count_expr} FROM calendar.calendars WHERE owner_id = $1"),
                params![user_id],
            )
            .await?;
        if owned >= instance.max_calendars_per_user {
            return Err(CalendarError::Validation(format!(
                "Nombre maximal d'agendas atteint ({}) — supprimez-en un ou contactez votre administration",
                instance.max_calendars_per_user
            )));
        }
        Ok(())
    }

    /// Create a new calendar.
    ///
    /// The calendar is stamped with the zone of the person creating it, the
    /// instance setting acting only as the fallback when that zone is unknown —
    /// see [`crate::services::timezone`] for where the creator's zone comes from
    /// and why nothing here trusts it as given.
    pub async fn create(
        user_id: Uuid,
        dto: CreateCalendarDto,
        instance: &InstanceConfig,
        db: &DbPool,
    ) -> Result<Calendar> {
        if dto.is_public == Some(true) && !instance.allow_public_calendars {
            return Err(CalendarError::Validation(
                "La publication d'un agenda est désactivée sur cette instance".to_string(),
            ));
        }

        let color    = dto.color.unwrap_or_else(|| "#4D38DB".to_string());
        let cal_type = dto.cal_type.unwrap_or_else(|| "personal".to_string());
        let timezone = crate::services::timezone::resolve_new_calendar_timezone(
            dto.timezone.as_deref(),
            &instance.default_timezone,
        );
        let is_public = dto.is_public.unwrap_or(false);

        // Check whether this is the first calendar (→ default)
        let count_expr = db.backend().count_bigint("*");
        let count: i64 = db
            .fetch_scalar(
                &format!("SELECT {count_expr} FROM calendar.calendars WHERE owner_id = $1"),
                params![user_id],
            )
            .await?;
        let is_default = count == 0;

        let cal_id = dto.id.unwrap_or_else(kubuno_db::new_id);
        let mut tx = db.begin().await?;
        let seq = sync::next_calendar_seq(&mut tx).await?;
        tx.execute(
            "INSERT INTO calendar.calendars
               (id, owner_id, name, description, color, cal_type, is_default, timezone,
                is_public, caldav_token, ctag, change_seq)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)",
            params![
                cal_id, user_id, dto.name, dto.description, color, cal_type, is_default, timezone,
                is_public, sync::new_tag(), sync::new_tag(), seq
            ],
        )
        .await?;
        tx.commit().await?;

        db.fetch_one_as::<Calendar>("SELECT * FROM calendar.calendars WHERE id = $1", params![cal_id])
            .await
            .map_err(Into::into)
    }

    /// Update a calendar.
    pub async fn update(
        id: Uuid,
        user_id: Uuid,
        dto: UpdateCalendarDto,
        instance: &InstanceConfig,
        db: &DbPool,
    ) -> Result<Calendar> {
        if dto.is_public == Some(true) && !instance.allow_public_calendars {
            return Err(CalendarError::Validation(
                "La publication d'un agenda est désactivée sur cette instance".to_string(),
            ));
        }

        let named_zone_is_unknown = dto
            .timezone
            .as_deref()
            .is_some_and(|tz| !crate::services::timezone::is_iana_timezone(tz.trim()));
        if named_zone_is_unknown {
            return Err(CalendarError::Validation(
                "Fuseau horaire inconnu : indiquez un identifiant IANA (Europe/Paris, America/New_York…)"
                    .to_string(),
            ));
        }

        // Check ownership
        let cal = Self::get_owned(id, user_id, db).await?;

        let name        = dto.name.unwrap_or(cal.name);
        let description = dto.description.or(cal.description);
        let color       = dto.color.unwrap_or(cal.color);
        let timezone    = dto.timezone.map(|tz| tz.trim().to_string()).unwrap_or(cal.timezone);
        let is_visible  = dto.is_visible.unwrap_or(cal.is_visible);
        let is_public   = dto.is_public.unwrap_or(cal.is_public);

        let mut tx = db.begin().await?;
        let seq = sync::next_calendar_seq(&mut tx).await?;
        tx.execute(
            "UPDATE calendar.calendars
             SET name = $1, description = $2, color = $3, timezone = $4,
                 is_visible = $5, is_public = $6, ctag = $7, change_seq = $8
             WHERE id = $9",
            params![name, description, color, timezone, is_visible, is_public, sync::new_tag(), seq, id],
        )
        .await?;
        tx.commit().await?;

        db.fetch_one_as::<Calendar>("SELECT * FROM calendar.calendars WHERE id = $1", params![id])
            .await
            .map_err(Into::into)
    }

    /// Delete a calendar and all its events (CASCADE).
    pub async fn delete(id: Uuid, user_id: Uuid, db: &DbPool) -> Result<()> {
        let cal = Self::get_owned(id, user_id, db).await?;
        if cal.is_default {
            return Err(CalendarError::Validation(
                "Impossible de supprimer le calendrier par défaut".to_string(),
            ));
        }

        // The FK cascade removes the calendar's events, but a cascade fires no
        // application code — so the event delta would never learn those events
        // are gone. Record an event tombstone for each (owner-scoped, as the
        // event delta reads them) before the calendar goes.
        let doomed: Vec<(Uuid, Uuid)> = db
            .fetch_all_as(
                "SELECT id, owner_id FROM calendar.events WHERE calendar_id = $1",
                params![id],
            )
            .await?;

        let mut tx = db.begin().await?;
        for (event_id, event_owner) in doomed {
            let seq = sync::next_event_seq(&mut tx).await?;
            kubuno_db::journal::record_tombstone(&mut tx, sync::EVENT_TOMBSTONES, event_id, event_owner, seq)
                .await?;
        }
        let seq = sync::next_calendar_seq(&mut tx).await?;
        tx.execute("DELETE FROM calendar.calendars WHERE id = $1", params![id]).await?;
        kubuno_db::journal::record_tombstone(&mut tx, sync::CALENDAR_TOMBSTONES, id, user_id, seq).await?;
        tx.commit().await?;
        Ok(())
    }

    /// Share a calendar with another user.
    pub async fn share(id: Uuid, owner_id: Uuid, dto: ShareCalendarDto, db: &DbPool) -> Result<CalendarShare> {
        Self::get_owned(id, owner_id, db).await?;
        let permission = dto.permission.unwrap_or_else(|| "read".to_string());

        // Upsert on (calendar_id, shared_with); shares are carried by no delta
        // feed, so no change_seq is bumped.
        let clause = db.backend().upsert(
            "calendar_shares",
            &["calendar_id", "shared_with"],
            &[Assign::Incoming("permission")],
        );
        db.execute(
            &format!(
                "INSERT INTO calendar.calendar_shares (id, calendar_id, shared_with, permission)
                 VALUES ($1, $2, $3, $4){clause}"
            ),
            params![kubuno_db::new_id(), id, dto.user_id, permission],
        )
        .await?;

        db.fetch_one_as::<CalendarShare>(
            "SELECT * FROM calendar.calendar_shares WHERE calendar_id = $1 AND shared_with = $2",
            params![id, dto.user_id],
        )
        .await
        .map_err(Into::into)
    }

    /// Supprime un partage.
    pub async fn unshare(id: Uuid, owner_id: Uuid, shared_with: Uuid, db: &DbPool) -> Result<()> {
        Self::get_owned(id, owner_id, db).await?;
        db.execute(
            "DELETE FROM calendar.calendar_shares WHERE calendar_id = $1 AND shared_with = $2",
            params![id, shared_with],
        )
        .await?;
        Ok(())
    }

    /// Fetch a calendar owned by the user.
    async fn get_owned(id: Uuid, user_id: Uuid, db: &DbPool) -> Result<Calendar> {
        db.fetch_optional_as::<Calendar>(
            "SELECT * FROM calendar.calendars WHERE id = $1 AND owner_id = $2",
            params![id, user_id],
        )
        .await?
        .ok_or_else(|| CalendarError::NotFound(format!("Calendrier {id}")))
    }
}
