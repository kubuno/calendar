//! Retention of past events.
//!
//! An administrator who sets a retention is asking the instance to stop keeping
//! a history nobody reads — a data-minimisation decision, so it is applied by
//! the server and not by whatever client happens to be open. The knob is
//! `event_retention_days`; left at `0` (the default) this worker does nothing at
//! all, and says nothing either.
//!
//! What is deliberately NOT purged:
//!   * recurring series (`rrule IS NOT NULL`) — their `ends_at` describes the
//!     first occurrence, not the end of the series, so age cannot be read from
//!     it and a weekly meeting created years ago is still live;
//!   * mirrored subscription calendars — their content is not the instance's to
//!     keep or drop, and the next sync would bring it back anyway.

use chrono::{DateTime, Duration, Utc};
use kubuno_db::{params, DbValue};
use uuid::Uuid;

use crate::{state::AppState, sync};

/// How often the cleaner wakes up. A retention is expressed in days, so there is
/// nothing to gain from a tighter loop.
const SWEEP_INTERVAL: std::time::Duration = std::time::Duration::from_secs(6 * 3600);

/// Events deleted per pass. Bounds both the transaction and the surprise: a
/// freshly enabled retention on an old instance trims steadily instead of
/// locking the table once.
const BATCH: i64 = 500;

pub struct RetentionService;

impl RetentionService {
    /// Runs the sweep forever. First pass 5 minutes after startup, so a module
    /// restart never coincides with a bulk delete.
    pub async fn run_worker(state: AppState) {
        tokio::time::sleep(std::time::Duration::from_secs(300)).await;
        loop {
            Self::sweep(&state).await;
            tokio::time::sleep(SWEEP_INTERVAL).await;
        }
    }

    /// One pass. Reads the retention at the last moment so an admin edit takes
    /// effect on the next sweep, and stops as soon as a batch comes back short.
    pub async fn sweep(state: &AppState) {
        let days = state.instance().event_retention_days;
        if days <= 0 {
            return;
        }
        let cutoff = Utc::now() - Duration::days(days);

        let mut total: u64 = 0;
        loop {
            match Self::sweep_batch(state, cutoff).await {
                Ok(0) => break,
                Ok(n) => {
                    total += n;
                    if (n as i64) < BATCH {
                        break;
                    }
                }
                Err(e) => {
                    tracing::error!(error = %e, "Purge des événements échus");
                    return;
                }
            }
        }

        if total > 0 {
            tracing::info!(
                purged = total, retention_days = days,
                "Purge des événements terminés au-delà de la rétention"
            );
        }
    }

    /// Deletes one batch of expired events, recording a tombstone for each first.
    /// `DELETE ... WHERE id IN (SELECT ... LIMIT ...)` over the same table has no
    /// portable form (MySQL forbids it), so the batch is read, tombstoned and
    /// deleted by an explicit id list. Returns how many rows went.
    async fn sweep_batch(state: &AppState, cutoff: DateTime<Utc>) -> Result<u64, sqlx::Error> {
        let batch: Vec<(Uuid, Uuid)> = state
            .db
            .fetch_all_as(
                r#"
                SELECT e.id, e.owner_id
                FROM calendar.events e
                JOIN calendar.calendars c ON c.id = e.calendar_id
                WHERE e.ends_at < $1
                  AND e.rrule IS NULL
                  AND c.subscription_url IS NULL
                ORDER BY e.ends_at
                LIMIT $2
                "#,
                params![cutoff, BATCH],
            )
            .await?;
        if batch.is_empty() {
            return Ok(0);
        }
        let n = batch.len() as u64;

        let mut tx = state.db.begin().await?;
        for (id, owner) in &batch {
            let seq = sync::next_event_seq(&mut tx).await?;
            kubuno_db::journal::record_tombstone(&mut tx, sync::EVENT_TOMBSTONES, *id, *owner, seq).await?;
        }
        let in_list = tx.backend().in_list(1, batch.len());
        let binds: Vec<DbValue> = batch.iter().map(|(id, _)| (*id).into()).collect();
        tx.execute(&format!("DELETE FROM calendar.events WHERE id IN ({in_list})"), binds)
            .await?;
        tx.commit().await?;
        Ok(n)
    }
}
