use kubuno_db::dialect::Assign;
use kubuno_db::{params, DbPool};
use uuid::Uuid;

use crate::{
    errors::{CalendarError, Result},
    models::scheduling::{
        ConfirmPollDto, CreatePollDto, MeetingPoll, PollResponse, PollRespondDto, PollSlot,
    },
    sync,
};

pub struct SchedulingService;

impl SchedulingService {
    pub async fn list_polls(user_id: Uuid, db: &DbPool) -> Result<Vec<MeetingPoll>> {
        let rows = db
            .fetch_all_as::<MeetingPoll>(
                "SELECT * FROM calendar.meeting_polls WHERE organizer_id = $1 ORDER BY created_at DESC",
                params![user_id],
            )
            .await?;
        Ok(rows)
    }

    pub async fn create_poll(user_id: Uuid, dto: CreatePollDto, db: &DbPool) -> Result<MeetingPoll> {
        let duration = dto.duration_minutes.unwrap_or(60);
        let poll_id = kubuno_db::new_id();
        let token = sync::new_tag();

        let mut tx = db.begin().await?;
        tx.execute(
            r#"
            INSERT INTO calendar.meeting_polls
                (id, organizer_id, title, description, duration_minutes, location, public_token, expires_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            "#,
            params![
                poll_id, user_id, dto.title, dto.description, duration, dto.location, token, dto.expires_at
            ],
        )
        .await?;

        for slot in &dto.slots {
            tx.execute(
                "INSERT INTO calendar.poll_slots (id, poll_id, starts_at, ends_at) VALUES ($1, $2, $3, $4)",
                params![kubuno_db::new_id(), poll_id, slot.starts_at, slot.ends_at],
            )
            .await?;
        }
        tx.commit().await?;

        db.fetch_one_as::<MeetingPoll>(
            "SELECT * FROM calendar.meeting_polls WHERE id = $1",
            params![poll_id],
        )
        .await
        .map_err(Into::into)
    }

    pub async fn get_poll(id: Uuid, user_id: Uuid, db: &DbPool) -> Result<MeetingPoll> {
        db.fetch_optional_as::<MeetingPoll>(
            "SELECT * FROM calendar.meeting_polls WHERE id = $1 AND organizer_id = $2",
            params![id, user_id],
        )
        .await?
        .ok_or_else(|| CalendarError::NotFound(format!("Sondage {id}")))
    }

    pub async fn get_poll_by_token(token: &str, db: &DbPool) -> Result<MeetingPoll> {
        db.fetch_optional_as::<MeetingPoll>(
            "SELECT * FROM calendar.meeting_polls WHERE public_token = $1",
            params![token],
        )
        .await?
        .ok_or_else(|| CalendarError::NotFound("Sondage introuvable".to_string()))
    }

    pub async fn get_poll_slots(poll_id: Uuid, db: &DbPool) -> Result<Vec<PollSlot>> {
        let rows = db
            .fetch_all_as::<PollSlot>(
                "SELECT * FROM calendar.poll_slots WHERE poll_id = $1 ORDER BY starts_at",
                params![poll_id],
            )
            .await?;
        Ok(rows)
    }

    pub async fn get_poll_responses(poll_id: Uuid, db: &DbPool) -> Result<Vec<PollResponse>> {
        let rows = db
            .fetch_all_as::<PollResponse>(
                "SELECT * FROM calendar.poll_responses WHERE poll_id = $1 ORDER BY responded_at",
                params![poll_id],
            )
            .await?;
        Ok(rows)
    }

    pub async fn respond_to_poll(
        poll_id: Uuid,
        user_id: Option<Uuid>,
        email: &str,
        dto: PollRespondDto,
        db: &DbPool,
    ) -> Result<Vec<PollResponse>> {
        // The poll must be open — read that on the pool before opening the write
        // transaction.
        let status: Option<String> = db
            .fetch_optional_scalar(
                "SELECT status FROM calendar.meeting_polls WHERE id = $1",
                params![poll_id],
            )
            .await?;
        match status {
            Some(s) if s != "open" => {
                return Err(CalendarError::Validation("Le sondage est fermé".to_string()));
            }
            None => return Err(CalendarError::NotFound(format!("Sondage {poll_id}"))),
            _ => {}
        }

        // Upsert one row per slot answered; the conflict target is (slot_id, email),
        // and both the availability and the response time are refreshed on a re-vote.
        let clause = db.backend().upsert(
            "poll_responses",
            &["slot_id", "email"],
            &[Assign::Incoming("availability"), Assign::Incoming("responded_at")],
        );
        let sql = format!(
            "INSERT INTO calendar.poll_responses
                (id, poll_id, slot_id, user_id, email, display_name, availability, responded_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8){clause}"
        );

        let mut tx = db.begin().await?;
        for resp in &dto.responses {
            tx.execute(
                &sql,
                params![
                    kubuno_db::new_id(), poll_id, resp.slot_id, user_id, email,
                    dto.display_name.clone(), resp.availability.clone(), chrono::Utc::now()
                ],
            )
            .await?;
        }
        tx.commit().await?;

        // The responder's rows, which are exactly the answers just recorded.
        let rows = db
            .fetch_all_as::<PollResponse>(
                "SELECT * FROM calendar.poll_responses WHERE poll_id = $1 AND email = $2 ORDER BY responded_at",
                params![poll_id, email],
            )
            .await?;
        Ok(rows)
    }

    pub async fn delete_poll(id: Uuid, user_id: Uuid, db: &DbPool) -> Result<()> {
        let deleted = db
            .execute(
                "DELETE FROM calendar.meeting_polls WHERE id = $1 AND organizer_id = $2",
                params![id, user_id],
            )
            .await?;

        if deleted == 0 {
            return Err(CalendarError::NotFound(format!("Sondage {id}")));
        }
        Ok(())
    }

    pub async fn confirm_poll(
        id: Uuid,
        user_id: Uuid,
        dto: ConfirmPollDto,
        db: &DbPool,
    ) -> Result<MeetingPoll> {
        // Guarded update (`organizer_id`): check ownership first, then update by
        // id and reselect — a guarded `UPDATE ... RETURNING` has no portable form.
        let owned: Option<Uuid> = db
            .fetch_optional_scalar(
                "SELECT id FROM calendar.meeting_polls WHERE id = $1 AND organizer_id = $2",
                params![id, user_id],
            )
            .await?;
        if owned.is_none() {
            return Err(CalendarError::NotFound(format!("Sondage {id}")));
        }

        db.execute(
            "UPDATE calendar.meeting_polls SET status = 'confirmed', confirmed_slot_id = $1 WHERE id = $2",
            params![dto.slot_id, id],
        )
        .await?;

        db.fetch_one_as::<MeetingPoll>(
            "SELECT * FROM calendar.meeting_polls WHERE id = $1",
            params![id],
        )
        .await
        .map_err(Into::into)
    }
}
