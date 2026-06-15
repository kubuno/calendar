use sqlx::PgPool;
use uuid::Uuid;

use crate::{
    errors::{CalendarError, Result},
    models::calendar::{Calendar, CalendarShare, CreateCalendarDto, ShareCalendarDto, UpdateCalendarDto},
};

pub struct CalendarService;

impl CalendarService {
    /// Liste les calendriers d'un utilisateur (propres + partagés avec lui).
    pub async fn list(user_id: Uuid, db: &PgPool) -> Result<Vec<Calendar>> {
        let rows = sqlx::query_as::<_, Calendar>(
            r#"
            SELECT DISTINCT c.*
            FROM calendar.calendars c
            LEFT JOIN calendar.calendar_shares cs ON cs.calendar_id = c.id
            WHERE c.owner_id = $1
               OR cs.shared_with = $1
            ORDER BY c.is_default DESC, c.name ASC
            "#,
        )
        .bind(user_id)
        .fetch_all(db)
        .await?;
        Ok(rows)
    }

    /// Récupère un calendrier par son ID, vérifie l'accès.
    pub async fn get(id: Uuid, user_id: Uuid, db: &PgPool) -> Result<Calendar> {
        let row = sqlx::query_as::<_, Calendar>(
            r#"
            SELECT c.*
            FROM calendar.calendars c
            LEFT JOIN calendar.calendar_shares cs ON cs.calendar_id = c.id AND cs.shared_with = $2
            WHERE c.id = $1
              AND (c.owner_id = $2 OR cs.shared_with = $2 OR c.is_public = TRUE)
            LIMIT 1
            "#,
        )
        .bind(id)
        .bind(user_id)
        .fetch_optional(db)
        .await?
        .ok_or_else(|| CalendarError::NotFound(format!("Calendrier {id}")))?;
        Ok(row)
    }

    /// Crée un nouveau calendrier.
    pub async fn create(user_id: Uuid, dto: CreateCalendarDto, db: &PgPool) -> Result<Calendar> {
        let color    = dto.color.unwrap_or_else(|| "#4D38DB".to_string());
        let cal_type = dto.cal_type.unwrap_or_else(|| "personal".to_string());
        let timezone = dto.timezone.unwrap_or_else(|| "UTC".to_string());
        let is_public = dto.is_public.unwrap_or(false);

        // Vérifier si c'est le premier calendrier (→ par défaut)
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM calendar.calendars WHERE owner_id = $1")
            .bind(user_id)
            .fetch_one(db)
            .await?;
        let is_default = count == 0;

        let row = sqlx::query_as::<_, Calendar>(
            r#"
            INSERT INTO calendar.calendars
                (owner_id, name, description, color, cal_type, is_default, timezone, is_public)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            RETURNING *
            "#,
        )
        .bind(user_id)
        .bind(&dto.name)
        .bind(&dto.description)
        .bind(&color)
        .bind(&cal_type)
        .bind(is_default)
        .bind(&timezone)
        .bind(is_public)
        .fetch_one(db)
        .await?;

        Ok(row)
    }

    /// Met à jour un calendrier.
    pub async fn update(id: Uuid, user_id: Uuid, dto: UpdateCalendarDto, db: &PgPool) -> Result<Calendar> {
        // Vérifier ownership
        let cal = Self::get_owned(id, user_id, db).await?;

        let name       = dto.name.unwrap_or(cal.name);
        let description = dto.description.or(cal.description);
        let color      = dto.color.unwrap_or(cal.color);
        let timezone   = dto.timezone.unwrap_or(cal.timezone);
        let is_visible = dto.is_visible.unwrap_or(cal.is_visible);
        let is_public  = dto.is_public.unwrap_or(cal.is_public);

        let row = sqlx::query_as::<_, Calendar>(
            r#"
            UPDATE calendar.calendars
            SET name = $2, description = $3, color = $4, timezone = $5,
                is_visible = $6, is_public = $7,
                ctag = md5(random()::text)
            WHERE id = $1
            RETURNING *
            "#,
        )
        .bind(id)
        .bind(&name)
        .bind(&description)
        .bind(&color)
        .bind(&timezone)
        .bind(is_visible)
        .bind(is_public)
        .fetch_one(db)
        .await?;

        Ok(row)
    }

    /// Supprime un calendrier et tous ses événements (CASCADE).
    pub async fn delete(id: Uuid, user_id: Uuid, db: &PgPool) -> Result<()> {
        let cal = Self::get_owned(id, user_id, db).await?;
        if cal.is_default {
            return Err(CalendarError::Validation(
                "Impossible de supprimer le calendrier par défaut".to_string(),
            ));
        }
        sqlx::query("DELETE FROM calendar.calendars WHERE id = $1")
            .bind(id)
            .execute(db)
            .await?;
        Ok(())
    }

    /// Partage un calendrier avec un autre utilisateur.
    pub async fn share(id: Uuid, owner_id: Uuid, dto: ShareCalendarDto, db: &PgPool) -> Result<CalendarShare> {
        Self::get_owned(id, owner_id, db).await?;
        let permission = dto.permission.unwrap_or_else(|| "read".to_string());

        let row = sqlx::query_as::<_, CalendarShare>(
            r#"
            INSERT INTO calendar.calendar_shares (calendar_id, shared_with, permission)
            VALUES ($1, $2, $3)
            ON CONFLICT (calendar_id, shared_with)
            DO UPDATE SET permission = EXCLUDED.permission
            RETURNING *
            "#,
        )
        .bind(id)
        .bind(dto.user_id)
        .bind(&permission)
        .fetch_one(db)
        .await?;

        Ok(row)
    }

    /// Supprime un partage.
    pub async fn unshare(id: Uuid, owner_id: Uuid, shared_with: Uuid, db: &PgPool) -> Result<()> {
        Self::get_owned(id, owner_id, db).await?;
        sqlx::query(
            "DELETE FROM calendar.calendar_shares WHERE calendar_id = $1 AND shared_with = $2",
        )
        .bind(id)
        .bind(shared_with)
        .execute(db)
        .await?;
        Ok(())
    }

    /// Récupère un calendrier dont l'utilisateur est propriétaire.
    async fn get_owned(id: Uuid, user_id: Uuid, db: &PgPool) -> Result<Calendar> {
        sqlx::query_as::<_, Calendar>(
            "SELECT * FROM calendar.calendars WHERE id = $1 AND owner_id = $2",
        )
        .bind(id)
        .bind(user_id)
        .fetch_optional(db)
        .await?
        .ok_or_else(|| CalendarError::NotFound(format!("Calendrier {id}")))
    }
}
