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
    pub last_name:  Option<String>,
    #[validate(email)]
    pub email:      String,
    #[serde(default)]
    pub answers:    Value,
    pub note:       Option<String>,
}

/// Query bounds for the public slot listing.
#[derive(Debug, Deserialize)]
pub struct SlotsQuery {
    pub from:  DateTime<Utc>,
    pub until: DateTime<Utc>,
}
