use chrono::{Duration, Utc};
use sqlx::PgPool;
use std::sync::Arc;
use uuid::Uuid;

use crate::{errors::Result, models::event::Event, state::AppState};

pub struct ReminderService;

impl ReminderService {
    /// Planifie les rappels d'un événement dans la DB.
    pub async fn schedule_reminders(event: &Event, user_id: Uuid, db: &PgPool) -> Result<()> {
        // Supprimer les anciens rappels non envoyés
        sqlx::query(
            "DELETE FROM calendar.scheduled_reminders WHERE event_id = $1 AND sent = FALSE",
        )
        .bind(event.id)
        .execute(db)
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
                sqlx::query(
                    r#"
                    INSERT INTO calendar.scheduled_reminders
                        (event_id, user_id, remind_at, channel)
                    VALUES ($1, $2, $3, $4)
                    ON CONFLICT DO NOTHING
                    "#,
                )
                .bind(event.id)
                .bind(user_id)
                .bind(remind_at)
                .bind(&channel)
                .execute(db)
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
        let due: Vec<(Uuid, Uuid, String)> = sqlx::query_as(
            r#"
            SELECT id, user_id, channel
            FROM calendar.scheduled_reminders
            WHERE sent = FALSE AND remind_at <= NOW()
            ORDER BY remind_at
            LIMIT 100
            "#,
        )
        .fetch_all(&state.db)
        .await?;

        for (reminder_id, user_id, channel) in due {
            tracing::info!(
                reminder_id = %reminder_id,
                user_id = %user_id,
                channel = %channel,
                "Envoi rappel"
            );

            // Marquer comme envoyé
            sqlx::query(
                "UPDATE calendar.scheduled_reminders SET sent = TRUE, sent_at = NOW() WHERE id = $1",
            )
            .bind(reminder_id)
            .execute(&state.db)
            .await?;

            // TODO: envoyer via WebSocket ou email selon le canal
        }

        Ok(())
    }
}
