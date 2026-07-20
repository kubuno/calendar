use chrono::{DateTime, Duration, Utc};
use sqlx::PgPool;
use uuid::Uuid;

use crate::{
    errors::Result,
    models::scheduling::{AvailabilityQuery, AvailableSlot},
};

pub struct AvailabilityService;

impl AvailabilityService {
    /// Find the common free slots between several users.
    ///
    /// A single query loads every busy interval of the window (recurring
    /// series are expanded in memory), then a stepped sweep
    /// de 30 min calcule la proportion de participants disponibles (score).
    pub async fn find_common_slots(
        query: AvailabilityQuery,
        db: &PgPool,
    ) -> Result<Vec<AvailableSlot>> {
        if query.user_ids.is_empty() {
            return Ok(vec![]);
        }

        // Every "busy" event of the window — including recurring masters
        // whose occurrences may fall inside it (earlier starts_at).
        let events: Vec<crate::models::event::Event> = sqlx::query_as(
            r#"
            SELECT e.*
            FROM calendar.events e
            WHERE e.owner_id = ANY($1)
              AND e.busy = TRUE
              AND e.status != 'cancelled'
              AND (
                    (e.rrule IS NULL AND e.starts_at < $3 AND e.ends_at > $2)
                 OR (e.rrule IS NOT NULL AND e.starts_at < $3)
              )
            "#,
        )
        .bind(&query.user_ids)
        .bind(query.from)
        .bind(query.until)
        .fetch_all(db)
        .await?;

        // Busy intervals per user (recurrences expanded).
        let mut busy: Vec<(Uuid, DateTime<Utc>, DateTime<Utc>)> = Vec::new();
        for e in &events {
            if e.rrule.is_some() {
                for occ in crate::services::recurrence_service::RecurrenceService::expand(
                    e, None, query.from, query.until,
                ) {
                    busy.push((e.owner_id, occ.starts_at, occ.ends_at));
                }
            } else {
                busy.push((e.owner_id, e.starts_at, e.ends_at));
            }
        }

        let mut slots: Vec<AvailableSlot> = Vec::new();
        let slot_duration = Duration::minutes(30);
        let user_count = query.user_ids.len() as f64;
        let mut cursor = query.from;

        while cursor < query.until {
            let slot_end = cursor + slot_duration;

            let busy_users: std::collections::HashSet<Uuid> = busy
                .iter()
                .filter(|(_, s, e)| *s < slot_end && *e > cursor)
                .map(|(u, _, _)| *u)
                .collect();
            let score = (user_count - busy_users.len() as f64) / user_count;

            if score > 0.0 {
                // Merge with the previous slot when adjacent with the same score
                if let Some(last) = slots.last_mut() {
                    if last.ends_at == cursor && (last.score - score).abs() < 0.01 {
                        last.ends_at = slot_end;
                        cursor = slot_end;
                        continue;
                    }
                }
                slots.push(AvailableSlot {
                    starts_at: cursor,
                    ends_at:   slot_end,
                    score,
                });
            }

            cursor = slot_end;
        }

        Ok(slots)
    }

    /// Return a user's events within a window (for availability display).
    pub async fn get_user_availability(
        user_id: Uuid,
        from: DateTime<Utc>,
        until: DateTime<Utc>,
        db: &PgPool,
    ) -> Result<Vec<(DateTime<Utc>, DateTime<Utc>)>> {
        let rows: Vec<(DateTime<Utc>, DateTime<Utc>)> = sqlx::query_as(
            r#"
            SELECT e.starts_at, e.ends_at
            FROM calendar.events e
            WHERE e.owner_id = $1
              AND e.busy = TRUE
              AND e.status != 'cancelled'
              AND e.rrule IS NULL
              AND e.starts_at < $3
              AND e.ends_at > $2
            ORDER BY e.starts_at
            "#,
        )
        .bind(user_id)
        .bind(from)
        .bind(until)
        .fetch_all(db)
        .await?;

        Ok(rows)
    }
}
