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
        // The poll must exist, be open and not expired, and every answered slot must
        // be one of its own — all checked on the pool before opening the write
        // transaction.
        let poll = db
            .fetch_optional_as::<MeetingPoll>(
                "SELECT * FROM calendar.meeting_polls WHERE id = $1",
                params![poll_id],
            )
            .await?
            .ok_or_else(|| CalendarError::NotFound(format!("Sondage {poll_id}")))?;
        let slot_ids: Vec<Uuid> = Self::get_poll_slots(poll_id, db).await?.iter().map(|s| s.id).collect();
        let email = validate_poll_answer(&poll, &slot_ids, email, &dto, chrono::Utc::now())?;
        let email = email.as_str();
        let display_name = dto
            .display_name
            .as_deref()
            .map(str::trim)
            .filter(|n| !n.is_empty())
            .map(str::to_string);

        // Upsert one row per slot answered; the conflict target is (slot_id, email),
        // and both the availability and the response time are refreshed on a re-vote.
        // Every slot was checked to belong to THIS poll, so a re-vote can only touch
        // this poll's rows.
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
                    display_name.clone(), resp.availability.clone(), chrono::Utc::now()
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

/// Values a poll answer may take (the `poll_responses.availability` CHECK).
pub const POLL_AVAILABILITY: [&str; 3] = ["available", "maybe", "unavailable"];
/// Longest accepted e-mail address (RFC 5321 path limit).
const MAX_EMAIL_LEN: usize = 254;
/// Longest accepted display name (the column width).
const MAX_DISPLAY_NAME_LEN: usize = 255;
/// Most slots one answer may carry (a poll never offers more).
const MAX_ANSWERED_SLOTS: usize = 500;

/// Checks a poll answer before anything is written, and returns the respondent e-mail to record (trimmed).
///
/// The answer page is not trusted: the poll must be open and not expired, the e-mail must be an address, every
/// answered slot must be one of THIS poll's slots (an id taken from another poll is refused, so an answer can
/// neither attach to nor overwrite another poll's votes), each slot is answered once, and the availability must
/// be one of the three known values.
pub fn validate_poll_answer(
    poll: &MeetingPoll,
    poll_slot_ids: &[Uuid],
    email: &str,
    dto: &PollRespondDto,
    now: chrono::DateTime<chrono::Utc>,
) -> Result<String> {
    use validator::ValidateEmail;

    if poll.status != "open" {
        return Err(CalendarError::Validation("Le sondage est fermé".to_string()));
    }
    if poll.expires_at.is_some_and(|e| e < now) {
        return Err(CalendarError::Validation("Ce sondage a expiré".to_string()));
    }
    let email = email.trim();
    if email.is_empty() || email.chars().count() > MAX_EMAIL_LEN || !email.validate_email() {
        return Err(CalendarError::Validation("Adresse e-mail invalide".to_string()));
    }
    if dto
        .display_name
        .as_deref()
        .is_some_and(|n| n.trim().chars().count() > MAX_DISPLAY_NAME_LEN)
    {
        return Err(CalendarError::Validation("Nom trop long".to_string()));
    }
    if dto.responses.is_empty() || dto.responses.len() > MAX_ANSWERED_SLOTS {
        return Err(CalendarError::Validation("Nombre de réponses invalide".to_string()));
    }
    let mut seen = std::collections::HashSet::new();
    for r in &dto.responses {
        if !poll_slot_ids.contains(&r.slot_id) {
            return Err(CalendarError::Validation("Créneau inconnu pour ce sondage".to_string()));
        }
        if !seen.insert(r.slot_id) {
            return Err(CalendarError::Validation("Créneau répété".to_string()));
        }
        if !POLL_AVAILABILITY.contains(&r.availability.as_str()) {
            return Err(CalendarError::Validation("Disponibilité invalide".to_string()));
        }
    }
    Ok(email.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::scheduling::SlotResponseDto;
    use chrono::{Duration, Utc};

    fn poll(status: &str, expires_in_hours: Option<i64>) -> MeetingPoll {
        let now = Utc::now();
        MeetingPoll {
            id: Uuid::new_v4(),
            organizer_id: Uuid::new_v4(),
            title: "Sync".into(),
            description: None,
            duration_minutes: 30,
            location: None,
            public_token: "t".into(),
            status: status.into(),
            confirmed_slot_id: None,
            expires_at: expires_in_hours.map(|h| now + Duration::hours(h)),
            created_at: now,
            updated_at: now,
        }
    }

    fn answer(slots: &[(Uuid, &str)]) -> PollRespondDto {
        PollRespondDto {
            responses: slots
                .iter()
                .map(|(id, a)| SlotResponseDto { slot_id: *id, availability: a.to_string() })
                .collect(),
            email: None,
            display_name: Some("Ada".into()),
        }
    }

    #[test]
    fn a_valid_answer_passes_and_the_email_is_trimmed() {
        let (s1, s2) = (Uuid::new_v4(), Uuid::new_v4());
        let got = validate_poll_answer(
            &poll("open", Some(1)),
            &[s1, s2],
            " ada@example.org ",
            &answer(&[(s1, "available"), (s2, "maybe")]),
            Utc::now(),
        );
        assert_eq!(got.expect("valid"), "ada@example.org");
    }

    #[test]
    fn a_slot_of_another_poll_is_refused() {
        let own = Uuid::new_v4();
        let foreign = Uuid::new_v4();
        let got = validate_poll_answer(
            &poll("open", None),
            &[own],
            "a@example.org",
            &answer(&[(foreign, "available")]),
            Utc::now(),
        );
        assert!(matches!(got, Err(CalendarError::Validation(_))));
    }

    #[test]
    fn bad_values_are_refused() {
        let s = Uuid::new_v4();
        let p = poll("open", None);
        let now = Utc::now();
        for email in ["", "   ", "not-an-email", "a@"] {
            assert!(validate_poll_answer(&p, &[s], email, &answer(&[(s, "available")]), now).is_err(), "{email}");
        }
        let long = format!("{}@example.org", "a".repeat(250));
        assert!(validate_poll_answer(&p, &[s], &long, &answer(&[(s, "available")]), now).is_err());
        assert!(validate_poll_answer(&p, &[s], "a@example.org", &answer(&[(s, "yes")]), now).is_err());
        assert!(validate_poll_answer(&p, &[s], "a@example.org", &answer(&[]), now).is_err());
        assert!(validate_poll_answer(&p, &[s], "a@example.org", &answer(&[(s, "available"), (s, "maybe")]), now).is_err());
        let mut named = answer(&[(s, "available")]);
        named.display_name = Some("x".repeat(256));
        assert!(validate_poll_answer(&p, &[s], "a@example.org", &named, now).is_err());
    }

    #[test]
    fn closed_and_expired_polls_take_no_answer() {
        let s = Uuid::new_v4();
        let now = Utc::now();
        let one = answer(&[(s, "available")]);
        assert!(validate_poll_answer(&poll("closed", None), &[s], "a@example.org", &one, now).is_err());
        assert!(validate_poll_answer(&poll("open", Some(-1)), &[s], "a@example.org", &one, now).is_err());
    }
}
