use kubuno_db::dialect::Backend;
use kubuno_db::{params, DbPool};
use uuid::Uuid;

use crate::{
    errors::{CalendarError, Result},
    models::time_block::{CreateTimeBlockDto, TimeBlock, UpdateTimeBlockDto},
    sync,
};

pub struct TimeBlockService;

/// `NaiveTime` has no `DbValue` variant, so a TIME column is written as an
/// `HH:MM:SS` string — the spelling every engine accepts (PostgreSQL / MySQL
/// `TIME`, SQLite `TEXT`) and that sqlx decodes back into `NaiveTime`.
fn time_str(t: chrono::NaiveTime) -> String {
    t.format("%H:%M:%S").to_string()
}

/// Placeholder for a TIME value bound as text. PostgreSQL and MySQL will not
/// assign a text parameter to a native `TIME` column without an explicit cast;
/// SQLite stores time as that very text, so no cast (its `CAST(.. AS TIME)`
/// would wrongly take NUMERIC affinity).
fn time_ph(backend: Backend, n: usize) -> String {
    match backend {
        Backend::Sqlite => format!("${n}"),
        _ => format!("CAST(${n} AS TIME)"),
    }
}

impl TimeBlockService {
    pub async fn list(user_id: Uuid, db: &DbPool) -> Result<Vec<TimeBlock>> {
        let rows = db
            .fetch_all_as::<TimeBlock>(
                "SELECT * FROM calendar.time_blocks WHERE owner_id = $1 ORDER BY priority DESC, label",
                params![user_id],
            )
            .await?;
        Ok(rows)
    }

    pub async fn create(user_id: Uuid, dto: CreateTimeBlockDto, db: &DbPool) -> Result<TimeBlock> {
        let color    = dto.color.unwrap_or_else(|| "#34a853".to_string());
        let priority = dto.priority.unwrap_or_else(|| "medium".to_string());
        let id       = dto.id.unwrap_or_else(kubuno_db::new_id);
        // `Vec<i32>` is stored as a JSON array (portable across the three engines).
        let days     = serde_json::json!(dto.days);
        let start    = time_str(dto.start_time);
        let end      = time_str(dto.end_time);

        let mut tx = db.begin().await?;
        let seq = sync::next_time_block_seq(&mut tx).await?;
        let backend = tx.backend();
        let (t6, t7) = (time_ph(backend, 6), time_ph(backend, 7));
        tx.execute(
            &format!(
                "INSERT INTO calendar.time_blocks
                   (id, owner_id, label, color, days, start_time, end_time, priority, change_seq)
                 VALUES ($1, $2, $3, $4, $5, {t6}, {t7}, $8, $9)"
            ),
            params![id, user_id, dto.label, color, days, start, end, priority, seq],
        )
        .await?;
        tx.commit().await?;

        db.fetch_one_as::<TimeBlock>("SELECT * FROM calendar.time_blocks WHERE id = $1", params![id])
            .await
            .map_err(Into::into)
    }

    pub async fn update(id: Uuid, user_id: Uuid, dto: UpdateTimeBlockDto, db: &DbPool) -> Result<TimeBlock> {
        let tb = db
            .fetch_optional_as::<TimeBlock>(
                "SELECT * FROM calendar.time_blocks WHERE id = $1 AND owner_id = $2",
                params![id, user_id],
            )
            .await?
            .ok_or_else(|| CalendarError::NotFound(format!("Bloc de temps {id}")))?;

        let label      = dto.label.unwrap_or(tb.label);
        let color      = dto.color.unwrap_or(tb.color);
        let days       = dto.days.unwrap_or(tb.days);
        let start_time = dto.start_time.unwrap_or(tb.start_time);
        let end_time   = dto.end_time.unwrap_or(tb.end_time);
        let priority   = dto.priority.unwrap_or(tb.priority);
        let is_active  = dto.is_active.unwrap_or(tb.is_active);

        let days_json = serde_json::json!(days);
        let start     = time_str(start_time);
        let end       = time_str(end_time);

        let mut tx = db.begin().await?;
        let seq = sync::next_time_block_seq(&mut tx).await?;
        let backend = tx.backend();
        let (t4, t5) = (time_ph(backend, 4), time_ph(backend, 5));
        tx.execute(
            &format!(
                "UPDATE calendar.time_blocks
                 SET label = $1, color = $2, days = $3, start_time = {t4}, end_time = {t5},
                     priority = $6, is_active = $7, change_seq = $8
                 WHERE id = $9"
            ),
            params![label, color, days_json, start, end, priority, is_active, seq, id],
        )
        .await?;
        tx.commit().await?;

        db.fetch_one_as::<TimeBlock>("SELECT * FROM calendar.time_blocks WHERE id = $1", params![id])
            .await
            .map_err(Into::into)
    }

    pub async fn delete(id: Uuid, user_id: Uuid, db: &DbPool) -> Result<()> {
        // The row is owner-scoped, so its owner is the acting user — the value
        // the time_block delta filters tombstones on.
        let mut tx = db.begin().await?;
        let seq = sync::next_time_block_seq(&mut tx).await?;
        let deleted = tx
            .execute(
                "DELETE FROM calendar.time_blocks WHERE id = $1 AND owner_id = $2",
                params![id, user_id],
            )
            .await?;
        if deleted == 0 {
            let _ = tx.rollback().await;
            return Err(CalendarError::NotFound(format!("Bloc de temps {id}")));
        }
        kubuno_db::journal::record_tombstone(&mut tx, sync::TIME_BLOCK_TOMBSTONES, id, user_id, seq)
            .await?;
        tx.commit().await?;
        Ok(())
    }
}
