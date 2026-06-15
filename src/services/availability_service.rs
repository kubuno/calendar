use chrono::{DateTime, Duration, Utc};
use sqlx::PgPool;
use uuid::Uuid;

use crate::{
    errors::Result,
    models::scheduling::{AvailabilityQuery, AvailableSlot},
};

pub struct AvailabilityService;

impl AvailabilityService {
    /// Trouve les créneaux libres communs entre plusieurs utilisateurs.
    pub async fn find_common_slots(
        query: AvailabilityQuery,
        db: &PgPool,
    ) -> Result<Vec<AvailableSlot>> {
        if query.user_ids.is_empty() {
            return Ok(vec![]);
        }

        let mut slots: Vec<AvailableSlot> = Vec::new();
        let slot_duration = Duration::minutes(30);
        let mut cursor = query.from;

        while cursor < query.until {
            let slot_end = cursor + slot_duration;
            let user_count = query.user_ids.len() as f64;

            // Compter les conflits par utilisateur
            let busy_count: i64 = sqlx::query_scalar(
                r#"
                SELECT COUNT(DISTINCT e.owner_id)
                FROM calendar.events e
                JOIN calendar.calendars c ON c.id = e.calendar_id
                WHERE e.owner_id = ANY($1)
                  AND e.busy = TRUE
                  AND e.status != 'cancelled'
                  AND e.rrule IS NULL
                  AND e.starts_at < $3
                  AND e.ends_at > $2
                "#,
            )
            .bind(&query.user_ids)
            .bind(cursor)
            .bind(slot_end)
            .fetch_one(db)
            .await?;

            let free_count = user_count - busy_count as f64;
            let score = free_count / user_count;

            if score > 0.0 {
                // Fusionner avec le créneau précédent si adjacent
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

    /// Retourne les événements d'un utilisateur dans une fenêtre (pour affichage de dispo).
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
