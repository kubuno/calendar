use chrono::{DateTime, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

// ── Persisted rows ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct AppointmentSchedule {
    pub id:                Uuid,
    pub owner_id:          Uuid,
    pub calendar_id:       Uuid,
    pub public_token:      String,
    pub title:             String,
    pub description:       Option<String>,
    pub color:             Option<String>,
    pub duration_minutes:  i32,
    pub buffer_minutes:    Option<i32>,
    pub max_per_day:       Option<i32>,
    pub timezone:          String,
    pub window_type:       String,
    pub window_max_days:   Option<i32>,
    pub window_min_hours:  Option<i32>,
    pub window_start_date: Option<NaiveDate>,
    pub window_end_date:   Option<NaiveDate>,
    pub location_type:     String,
    pub location_details:  Option<String>,
    pub guests_can_invite: bool,
    pub host_name:         Option<String>,
    pub host_avatar_url:   Option<String>,
    pub form_fields:       Value,
    pub calendar_invite:   bool,
    pub email_reminders:   Value,
    pub created_at:        DateTime<Utc>,
    pub updated_at:        DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct AppointmentAvailability {
    pub id:            Uuid,
    pub schedule_id:   Uuid,
    pub weekday:       Option<i16>,
    pub specific_date: Option<NaiveDate>,
    pub start_minute:  i32,
    pub end_minute:    i32,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct AppointmentBooking {
    pub id:          Uuid,
    pub schedule_id: Uuid,
    pub starts_at:   DateTime<Utc>,
    pub ends_at:     DateTime<Utc>,
    pub first_name:  String,
    pub last_name:   Option<String>,
    pub email:       String,
    pub answers:     Value,
    pub note:        Option<String>,
    pub event_id:    Option<Uuid>,
    pub status:      String,
    pub created_at:  DateTime<Utc>,
}

// ── Composite responses ─────────────────────────────────────────────────────

/// A schedule with its availability rules — the shape the editor loads / saves.
#[derive(Debug, Clone, Serialize)]
pub struct ScheduleWithRules {
    #[serde(flatten)]
    pub schedule:     AppointmentSchedule,
    pub availability: Vec<AppointmentAvailability>,
}

/// Public view of a schedule (no owner id, calendar id, etc.), for the booking page.
#[derive(Debug, Clone, Serialize)]
pub struct PublicSchedule {
    pub token:            String,
    pub title:            String,
    pub description:      Option<String>,
    pub color:            Option<String>,
    pub duration_minutes: i32,
    pub timezone:         String,
    pub location_type:    String,
    pub location_details: Option<String>,
    pub host_name:        Option<String>,
    pub host_avatar_url:  Option<String>,
    pub form_fields:      Value,
}

/// A single bookable slot.
#[derive(Debug, Clone, Serialize)]
pub struct Slot {
    pub starts_at: DateTime<Utc>,
    pub ends_at:   DateTime<Utc>,
}

// ── Input DTOs ──────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct AvailabilityRuleDto {
    pub weekday:       Option<i16>,
    pub specific_date: Option<NaiveDate>,
    pub start_minute:  i32,
    pub end_minute:    i32,
}

#[derive(Debug, Deserialize, validator::Validate)]
pub struct SaveScheduleDto {
    pub calendar_id:       Uuid,
    #[validate(length(max = 500))]
    pub title:             Option<String>,
    pub description:       Option<String>,
    pub color:             Option<String>,
    #[validate(range(min = 1, max = 1440))]
    pub duration_minutes:  i32,
    pub buffer_minutes:    Option<i32>,
    pub max_per_day:       Option<i32>,
    pub timezone:          Option<String>,
    pub window_type:       Option<String>,
    pub window_max_days:   Option<i32>,
    pub window_min_hours:  Option<i32>,
    pub window_start_date: Option<NaiveDate>,
    pub window_end_date:   Option<NaiveDate>,
    pub location_type:     Option<String>,
    pub location_details:  Option<String>,
    pub guests_can_invite: Option<bool>,
    pub host_name:         Option<String>,
    pub host_avatar_url:   Option<String>,
    pub form_fields:       Option<Value>,
    pub calendar_invite:   Option<bool>,
    pub email_reminders:   Option<Value>,
    #[serde(default)]
    pub availability:      Vec<AvailabilityRuleDto>,
}

/// A booking request from the public page.
#[derive(Debug, Deserialize, validator::Validate)]
pub struct BookDto {
    pub starts_at: DateTime<Utc>,
    #[validate(length(min = 1, max = 255))]
    pub first_name: String,
    #[validate(length(max = 255))]
    pub last_name:  Option<String>,
    #[validate(email, length(max = 254))]
    pub email:      String,
    /// Answers to the schedule's booking questions: an object (or nothing), at most
    /// `MAX_BOOKING_ANSWERS_BYTES` once serialised (checked by `BookDto::check_answers`).
    #[serde(default)]
    pub answers:    Value,
    #[validate(length(max = 5000))]
    pub note:       Option<String>,
}

/// Query bounds for the public slot listing.
#[derive(Debug, Deserialize)]
pub struct SlotsQuery {
    pub from:  DateTime<Utc>,
    pub until: DateTime<Utc>,
}

/// Largest accepted `answers` payload of a public booking, serialised.
pub const MAX_BOOKING_ANSWERS_BYTES: usize = 16 * 1024;

impl BookDto {
    /// The public booking page is not trusted with the shape or the size of the answers it stores on the
    /// owner's calendar: an object or nothing, and small.
    pub fn check_answers(&self) -> Result<(), String> {
        match &self.answers {
            Value::Null | Value::Object(_) => {}
            _ => return Err("Réponses invalides".to_string()),
        }
        let size = serde_json::to_vec(&self.answers).map(|v| v.len()).unwrap_or(usize::MAX);
        if size > MAX_BOOKING_ANSWERS_BYTES {
            return Err("Réponses trop volumineuses".to_string());
        }
        Ok(())
    }
}

#[cfg(test)]
mod book_dto_tests {
    use super::*;
    use validator::Validate;

    fn dto(answers: Value) -> BookDto {
        BookDto {
            starts_at: Utc::now(),
            first_name: "Ada".into(),
            last_name: None,
            email: "ada@example.org".into(),
            answers,
            note: None,
        }
    }

    #[test]
    fn answers_must_be_a_small_object() {
        assert!(dto(Value::Null).check_answers().is_ok());
        assert!(dto(serde_json::json!({ "q": "a" })).check_answers().is_ok());
        assert!(dto(serde_json::json!([1, 2])).check_answers().is_err());
        assert!(dto(serde_json::json!("text")).check_answers().is_err());
        assert!(dto(serde_json::json!({ "q": "x".repeat(MAX_BOOKING_ANSWERS_BYTES) })).check_answers().is_err());
    }

    #[test]
    fn free_text_fields_are_bounded() {
        let mut d = dto(Value::Null);
        assert!(d.validate().is_ok());
        d.note = Some("x".repeat(5001));
        assert!(d.validate().is_err());
        d.note = None;
        d.last_name = Some("x".repeat(256));
        assert!(d.validate().is_err());
        d.last_name = None;
        d.email = "not-an-email".into();
        assert!(d.validate().is_err());
    }
}
