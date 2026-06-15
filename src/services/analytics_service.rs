use chrono::{DateTime, Utc};
use serde::Serialize;
use sqlx::PgPool;
use uuid::Uuid;

use crate::errors::Result;

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct WorkloadRow {
    pub day:          DateTime<Utc>,
    pub event_count:  i64,
    pub total_hours:  f64,
    pub all_day_count:   i64,
    pub recurring_count: i64,
}

#[derive(Debug, Serialize)]
pub struct DistributionRow {
    pub calendar_name: String,
    pub color:         String,
    pub event_count:   i64,
}

pub struct AnalyticsService;

impl AnalyticsService {
    /// Charge de travail des 30 derniers jours (depuis la vue matérialisée).
    pub async fn workload(user_id: Uuid, db: &PgPool) -> Result<Vec<WorkloadRow>> {
        let rows = sqlx::query_as::<_, WorkloadRow>(
            r#"
            SELECT
                day,
                event_count,
                COALESCE(total_hours, 0.0) AS total_hours,
                all_day_count,
                recurring_count
            FROM calendar.analytics_cache
            WHERE owner_id = $1
            ORDER BY day
            "#,
        )
        .bind(user_id)
        .fetch_all(db)
        .await?;
        Ok(rows)
    }

    /// Répartition des événements par calendrier.
    pub async fn distribution(user_id: Uuid, db: &PgPool) -> Result<Vec<DistributionRow>> {
        let rows: Vec<(String, String, i64)> = sqlx::query_as(
            r#"
            SELECT c.name, c.color, COUNT(e.id)::BIGINT
            FROM calendar.calendars c
            LEFT JOIN calendar.events e ON e.calendar_id = c.id
                AND e.starts_at >= NOW() - INTERVAL '30 days'
                AND e.parent_event_id IS NULL
            WHERE c.owner_id = $1
            GROUP BY c.id, c.name, c.color
            ORDER BY COUNT(e.id) DESC
            "#,
        )
        .bind(user_id)
        .fetch_all(db)
        .await?;

        Ok(rows
            .into_iter()
            .map(|(calendar_name, color, event_count)| DistributionRow {
                calendar_name,
                color,
                event_count,
            })
            .collect())
    }

    /// Tendances: nombre d'événements créés par semaine sur les 12 dernières semaines.
    pub async fn trends(user_id: Uuid, db: &PgPool) -> Result<Vec<(DateTime<Utc>, i64)>> {
        let rows: Vec<(DateTime<Utc>, i64)> = sqlx::query_as(
            r#"
            SELECT
                DATE_TRUNC('week', e.created_at) AS week,
                COUNT(*)::BIGINT
            FROM calendar.events e
            JOIN calendar.calendars c ON c.id = e.calendar_id
            WHERE c.owner_id = $1
              AND e.created_at >= NOW() - INTERVAL '12 weeks'
              AND e.parent_event_id IS NULL
            GROUP BY DATE_TRUNC('week', e.created_at)
            ORDER BY week
            "#,
        )
        .bind(user_id)
        .fetch_all(db)
        .await?;
        Ok(rows)
    }

    /// Rafraîchit la vue matérialisée (best-effort, appelé périodiquement).
    pub async fn refresh_cache(db: &PgPool) -> Result<()> {
        sqlx::query("REFRESH MATERIALIZED VIEW CONCURRENTLY calendar.analytics_cache")
            .execute(db)
            .await?;
        Ok(())
    }
}
