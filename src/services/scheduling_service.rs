use sqlx::PgPool;
use uuid::Uuid;

use crate::{
    errors::{CalendarError, Result},
    models::scheduling::{
        ConfirmPollDto, CreatePollDto, MeetingPoll, PollResponse, PollRespondDto, PollSlot,
    },
};

pub struct SchedulingService;

impl SchedulingService {
    pub async fn list_polls(user_id: Uuid, db: &PgPool) -> Result<Vec<MeetingPoll>> {
        let rows = sqlx::query_as::<_, MeetingPoll>(
            "SELECT * FROM calendar.meeting_polls WHERE organizer_id = $1 ORDER BY created_at DESC",
        )
        .bind(user_id)
        .fetch_all(db)
        .await?;
        Ok(rows)
    }

    pub async fn create_poll(user_id: Uuid, dto: CreatePollDto, db: &PgPool) -> Result<MeetingPoll> {
        let mut tx = db.begin().await?;

        let duration = dto.duration_minutes.unwrap_or(60);

        let poll = sqlx::query_as::<_, MeetingPoll>(
            r#"
            INSERT INTO calendar.meeting_polls
                (organizer_id, title, description, duration_minutes, location, expires_at)
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING *
            "#,
        )
        .bind(user_id)
        .bind(&dto.title)
        .bind(&dto.description)
        .bind(duration)
        .bind(&dto.location)
        .bind(dto.expires_at)
        .fetch_one(&mut *tx)
        .await?;

        for slot in &dto.slots {
            sqlx::query(
                "INSERT INTO calendar.poll_slots (poll_id, starts_at, ends_at) VALUES ($1, $2, $3)",
            )
            .bind(poll.id)
            .bind(slot.starts_at)
            .bind(slot.ends_at)
            .execute(&mut *tx)
            .await?;
        }

        tx.commit().await?;
        Ok(poll)
    }

    pub async fn get_poll(id: Uuid, user_id: Uuid, db: &PgPool) -> Result<MeetingPoll> {
        sqlx::query_as::<_, MeetingPoll>(
            "SELECT * FROM calendar.meeting_polls WHERE id = $1 AND organizer_id = $2",
        )
        .bind(id)
        .bind(user_id)
        .fetch_optional(db)
        .await?
        .ok_or_else(|| CalendarError::NotFound(format!("Sondage {id}")))
    }

    pub async fn get_poll_by_token(token: &str, db: &PgPool) -> Result<MeetingPoll> {
        sqlx::query_as::<_, MeetingPoll>(
            "SELECT * FROM calendar.meeting_polls WHERE public_token = $1",
        )
        .bind(token)
        .fetch_optional(db)
        .await?
        .ok_or_else(|| CalendarError::NotFound("Sondage introuvable".to_string()))
    }

    pub async fn get_poll_slots(poll_id: Uuid, db: &PgPool) -> Result<Vec<PollSlot>> {
        let rows = sqlx::query_as::<_, PollSlot>(
            "SELECT * FROM calendar.poll_slots WHERE poll_id = $1 ORDER BY starts_at",
        )
        .bind(poll_id)
        .fetch_all(db)
        .await?;
        Ok(rows)
    }

    pub async fn get_poll_responses(poll_id: Uuid, db: &PgPool) -> Result<Vec<PollResponse>> {
        let rows = sqlx::query_as::<_, PollResponse>(
            "SELECT * FROM calendar.poll_responses WHERE poll_id = $1 ORDER BY responded_at",
        )
        .bind(poll_id)
        .fetch_all(db)
        .await?;
        Ok(rows)
    }

    pub async fn respond_to_poll(
        poll_id: Uuid,
        user_id: Option<Uuid>,
        email: &str,
        dto: PollRespondDto,
        db: &PgPool,
    ) -> Result<Vec<PollResponse>> {
        let mut tx = db.begin().await?;

        // Vérifier que le sondage est ouvert
        let poll: Option<(String,)> = sqlx::query_as(
            "SELECT status FROM calendar.meeting_polls WHERE id = $1",
        )
        .bind(poll_id)
        .fetch_optional(&mut *tx)
        .await?;

        match poll {
            Some((status,)) if status != "open" => {
                return Err(CalendarError::Validation("Le sondage est fermé".to_string()));
            }
            None => return Err(CalendarError::NotFound(format!("Sondage {poll_id}"))),
            _ => {}
        }

        let mut results = Vec::new();
        for resp in &dto.responses {
            let row = sqlx::query_as::<_, PollResponse>(
                r#"
                INSERT INTO calendar.poll_responses
                    (poll_id, slot_id, user_id, email, display_name, availability)
                VALUES ($1, $2, $3, $4, $5, $6)
                ON CONFLICT (slot_id, email)
                DO UPDATE SET availability = EXCLUDED.availability,
                              responded_at = NOW()
                RETURNING *
                "#,
            )
            .bind(poll_id)
            .bind(resp.slot_id)
            .bind(user_id)
            .bind(email)
            .bind(&dto.display_name)
            .bind(&resp.availability)
            .fetch_one(&mut *tx)
            .await?;
            results.push(row);
        }

        tx.commit().await?;
        Ok(results)
    }

    pub async fn delete_poll(id: Uuid, user_id: Uuid, db: &PgPool) -> Result<()> {
        let deleted = sqlx::query(
            "DELETE FROM calendar.meeting_polls WHERE id = $1 AND organizer_id = $2",
        )
        .bind(id)
        .bind(user_id)
        .execute(db)
        .await?;

        if deleted.rows_affected() == 0 {
            return Err(CalendarError::NotFound(format!("Sondage {id}")));
        }
        Ok(())
    }

    pub async fn confirm_poll(
        id: Uuid,
        user_id: Uuid,
        dto: ConfirmPollDto,
        db: &PgPool,
    ) -> Result<MeetingPoll> {
        let updated = sqlx::query_as::<_, MeetingPoll>(
            r#"
            UPDATE calendar.meeting_polls
            SET status = 'confirmed', confirmed_slot_id = $2
            WHERE id = $1 AND organizer_id = $3
            RETURNING *
            "#,
        )
        .bind(id)
        .bind(dto.slot_id)
        .bind(user_id)
        .fetch_optional(db)
        .await?
        .ok_or_else(|| CalendarError::NotFound(format!("Sondage {id}")))?;

        Ok(updated)
    }
}
