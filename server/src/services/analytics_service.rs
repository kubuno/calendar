use chrono::{DateTime, Datelike, Duration, Utc};
use kubuno_db::dialect::Backend;
use kubuno_db::{params, DbPool};
use serde::Serialize;
use std::collections::BTreeMap;
use uuid::Uuid;

use crate::errors::Result;

#[derive(Debug, Serialize)]
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

/// One raw event row, aggregated in Rust. `DATE_TRUNC` and `EXTRACT(EPOCH …)`
/// are PostgreSQL-only, so the grouping the old materialized view did in SQL is
/// done here — portable across the three engines.
#[derive(sqlx::FromRow)]
struct RawEvent {
    starts_at: DateTime<Utc>,
    ends_at:   DateTime<Utc>,
    all_day:   bool,
    rrule:     Option<String>,
}

/// The UTC start of the day a timestamp falls in.
fn day_start(ts: DateTime<Utc>) -> DateTime<Utc> {
    ts.date_naive().and_hms_opt(0, 0, 0).unwrap_or_default().and_utc()
}

/// The UTC start (Monday 00:00) of the ISO week a timestamp falls in — the same
/// bucket `DATE_TRUNC('week', …)` produced.
fn week_start(ts: DateTime<Utc>) -> DateTime<Utc> {
    let date = ts.date_naive();
    let monday = date - Duration::days(date.weekday().num_days_from_monday() as i64);
    monday.and_hms_opt(0, 0, 0).unwrap_or_default().and_utc()
}

#[derive(Default)]
struct DayAcc {
    event_count:     i64,
    total_hours:     f64,
    all_day_count:   i64,
    recurring_count: i64,
}

pub struct AnalyticsService;

impl AnalyticsService {
    /// Charge de travail des 30 derniers jours, agrégée par jour à la volée.
    pub async fn workload(user_id: Uuid, db: &DbPool) -> Result<Vec<WorkloadRow>> {
        let cutoff = Utc::now() - Duration::days(30);
        let rows: Vec<RawEvent> = db
            .fetch_all_as(
                "SELECT starts_at, ends_at, all_day, rrule
                 FROM calendar.events
                 WHERE owner_id = $1 AND starts_at >= $2 AND parent_event_id IS NULL",
                params![user_id, cutoff],
            )
            .await?;

        let mut by_day: BTreeMap<DateTime<Utc>, DayAcc> = BTreeMap::new();
        for e in rows {
            let acc = by_day.entry(day_start(e.starts_at)).or_default();
            acc.event_count += 1;
            let hours = (e.ends_at - e.starts_at).num_seconds() as f64 / 3600.0;
            acc.total_hours += hours.max(0.0);
            if e.all_day {
                acc.all_day_count += 1;
            }
            if e.rrule.is_some() {
                acc.recurring_count += 1;
            }
        }

        Ok(by_day
            .into_iter()
            .map(|(day, a)| WorkloadRow {
                day,
                event_count: a.event_count,
                total_hours: a.total_hours,
                all_day_count: a.all_day_count,
                recurring_count: a.recurring_count,
            })
            .collect())
    }

    /// Répartition des événements par calendrier.
    pub async fn distribution(user_id: Uuid, db: &DbPool) -> Result<Vec<DistributionRow>> {
        let cutoff = Utc::now() - Duration::days(30);
        // Placeholders ascend in text order: the JOIN's date bound comes before
        // the WHERE owner filter.
        let count = db.backend().count_bigint("e.id");
        let rows: Vec<(String, String, i64)> = db
            .fetch_all_as(
                &format!(
                    r#"
                    SELECT c.name, c.color, {count} AS event_count
                    FROM calendar.calendars c
                    LEFT JOIN calendar.events e ON e.calendar_id = c.id
                        AND e.starts_at >= $1
                        AND e.parent_event_id IS NULL
                    WHERE c.owner_id = $2
                    GROUP BY c.id, c.name, c.color
                    ORDER BY event_count DESC
                    "#
                ),
                params![cutoff, user_id],
            )
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
    pub async fn trends(user_id: Uuid, db: &DbPool) -> Result<Vec<(DateTime<Utc>, i64)>> {
        let cutoff = Utc::now() - Duration::weeks(12);
        let rows: Vec<(DateTime<Utc>,)> = db
            .fetch_all_as(
                "SELECT e.created_at
                 FROM calendar.events e
                 JOIN calendar.calendars c ON c.id = e.calendar_id
                 WHERE c.owner_id = $1 AND e.created_at >= $2 AND e.parent_event_id IS NULL",
                params![user_id, cutoff],
            )
            .await?;

        let mut by_week: BTreeMap<DateTime<Utc>, i64> = BTreeMap::new();
        for (created_at,) in rows {
            *by_week.entry(week_start(created_at)).or_default() += 1;
        }
        Ok(by_week.into_iter().collect())
    }

    /// Rafraîchit la vue matérialisée. PostgreSQL only — the other engines have
    /// no materialized view (the reads above aggregate directly), so it is a
    /// no-op there.
    pub async fn refresh_cache(db: &DbPool) -> Result<()> {
        if db.backend() == Backend::Postgres {
            db.execute(
                "REFRESH MATERIALIZED VIEW CONCURRENTLY calendar.analytics_cache",
                params![],
            )
            .await?;
        }
        Ok(())
    }
}
