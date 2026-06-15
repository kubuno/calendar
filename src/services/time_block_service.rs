use sqlx::PgPool;
use uuid::Uuid;

use crate::{
    errors::{CalendarError, Result},
    models::time_block::{CreateTimeBlockDto, TimeBlock, UpdateTimeBlockDto},
};

pub struct TimeBlockService;

impl TimeBlockService {
    pub async fn list(user_id: Uuid, db: &PgPool) -> Result<Vec<TimeBlock>> {
        let rows = sqlx::query_as::<_, TimeBlock>(
            "SELECT * FROM calendar.time_blocks WHERE owner_id = $1 ORDER BY priority DESC, label",
        )
        .bind(user_id)
        .fetch_all(db)
        .await?;
        Ok(rows)
    }

    pub async fn create(user_id: Uuid, dto: CreateTimeBlockDto, db: &PgPool) -> Result<TimeBlock> {
        let color    = dto.color.unwrap_or_else(|| "#34a853".to_string());
        let priority = dto.priority.unwrap_or_else(|| "medium".to_string());

        let row = sqlx::query_as::<_, TimeBlock>(
            r#"
            INSERT INTO calendar.time_blocks
                (owner_id, label, color, days, start_time, end_time, priority)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            RETURNING *
            "#,
        )
        .bind(user_id)
        .bind(&dto.label)
        .bind(&color)
        .bind(&dto.days)
        .bind(dto.start_time)
        .bind(dto.end_time)
        .bind(&priority)
        .fetch_one(db)
        .await?;

        Ok(row)
    }

    pub async fn update(id: Uuid, user_id: Uuid, dto: UpdateTimeBlockDto, db: &PgPool) -> Result<TimeBlock> {
        let tb = sqlx::query_as::<_, TimeBlock>(
            "SELECT * FROM calendar.time_blocks WHERE id = $1 AND owner_id = $2",
        )
        .bind(id)
        .bind(user_id)
        .fetch_optional(db)
        .await?
        .ok_or_else(|| CalendarError::NotFound(format!("Bloc de temps {id}")))?;

        let label      = dto.label.unwrap_or(tb.label);
        let color      = dto.color.unwrap_or(tb.color);
        let days       = dto.days.unwrap_or(tb.days);
        let start_time = dto.start_time.unwrap_or(tb.start_time);
        let end_time   = dto.end_time.unwrap_or(tb.end_time);
        let priority   = dto.priority.unwrap_or(tb.priority);
        let is_active  = dto.is_active.unwrap_or(tb.is_active);

        let row = sqlx::query_as::<_, TimeBlock>(
            r#"
            UPDATE calendar.time_blocks
            SET label = $2, color = $3, days = $4, start_time = $5,
                end_time = $6, priority = $7, is_active = $8
            WHERE id = $1
            RETURNING *
            "#,
        )
        .bind(id)
        .bind(&label)
        .bind(&color)
        .bind(&days)
        .bind(start_time)
        .bind(end_time)
        .bind(&priority)
        .bind(is_active)
        .fetch_one(db)
        .await?;

        Ok(row)
    }

    pub async fn delete(id: Uuid, user_id: Uuid, db: &PgPool) -> Result<()> {
        let deleted = sqlx::query(
            "DELETE FROM calendar.time_blocks WHERE id = $1 AND owner_id = $2",
        )
        .bind(id)
        .bind(user_id)
        .execute(db)
        .await?;

        if deleted.rows_affected() == 0 {
            return Err(CalendarError::NotFound(format!("Bloc de temps {id}")));
        }
        Ok(())
    }
}
