use chrono::{Duration, Utc};
use kubuno_db::{params, DbPool};
use std::sync::Arc;
use uuid::Uuid;

use crate::{errors::Result, models::event::Event, state::AppState};

pub struct ReminderService;

impl ReminderService {
    /// Planifie les rappels d'un événement dans la DB.
    pub async fn schedule_reminders(event: &Event, user_id: Uuid, db: &DbPool) -> Result<()> {
        // Supprimer les anciens rappels non envoyés
        db.execute(
            "DELETE FROM calendar.scheduled_reminders WHERE event_id = $1 AND sent = FALSE",
            params![event.id],
        )
        .await?;

        // Parser les rappels JSONB: [{"type":"popup","minutes_before":15}, ...]
        let reminders = match event.reminders.as_array() {
            Some(arr) => arr.clone(),
            None      => return Ok(()),
        };

        for reminder in reminders {
            let minutes_before = reminder
                .get("minutes_before")
                .and_then(|v| v.as_i64())
                .unwrap_or(15);
            let channel = reminder
                .get("type")
                .and_then(|v| v.as_str())
                .unwrap_or("popup")
                .to_string();
            let remind_at = event.starts_at - Duration::minutes(minutes_before);

            if remind_at > Utc::now() {
                // The process now supplies the primary key (no DEFAULT on the
                // portable engines). The old bare `ON CONFLICT DO NOTHING` only
                // ever guarded the primary key, which a fresh id never hits.
                let ignore = db.backend().insert_ignore_prefix();
                let nothing = db.backend().on_conflict_do_nothing(&["id"]);
                db.execute(
                    &format!(
                        "INSERT {ignore}INTO calendar.scheduled_reminders
                            (id, event_id, user_id, remind_at, channel)
                        VALUES ($1, $2, $3, $4, $5){nothing}"
                    ),
                    params![kubuno_db::new_id(), event.id, user_id, remind_at, channel],
                )
                .await?;
            }
        }

        Ok(())
    }

    /// Worker qui vérifie les rappels toutes les minutes et les envoie.
    pub async fn run_worker(state: Arc<AppState>) {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(60)).await;

            if let Err(e) = Self::process_due_reminders(&state).await {
                tracing::error!(error = %e, "Erreur traitement des rappels");
            }
        }
    }

    async fn process_due_reminders(state: &AppState) -> Result<()> {
        // Récupérer les rappels dus
        let due: Vec<(Uuid, Uuid, String)> = state
            .db
            .fetch_all_as(
                r#"
            SELECT id, user_id, channel
            FROM calendar.scheduled_reminders
            WHERE sent = FALSE AND remind_at <= $1
            ORDER BY remind_at
            LIMIT 100
            "#,
                params![Utc::now()],
            )
            .await?;

        for (reminder_id, user_id, channel) in due {
            tracing::info!(
                reminder_id = %reminder_id,
                user_id = %user_id,
                channel = %channel,
                "Envoi rappel"
            );

            // Marquer comme envoyé
            state
                .db
                .execute(
                    "UPDATE calendar.scheduled_reminders SET sent = TRUE, sent_at = $1 WHERE id = $2",
                    params![Utc::now(), reminder_id],
                )
                .await?;

            // TODO: envoyer via WebSocket ou email selon le canal
        }

        Ok(())
    }
}
