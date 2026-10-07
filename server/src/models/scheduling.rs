use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct MeetingPoll {
    pub id:                Uuid,
    pub organizer_id:      Uuid,
    pub title:             String,
    pub description:       Option<String>,
    pub duration_minutes:  i32,
    pub location:          Option<String>,
    pub public_token:      String,
    pub status:            String,
    pub confirmed_slot_id: Option<Uuid>,
    pub expires_at:        Option<DateTime<Utc>>,
    pub created_at:        DateTime<Utc>,
    pub updated_at:        DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct PollSlot {
    pub id:              Uuid,
    pub poll_id:         Uuid,
    pub starts_at:       DateTime<Utc>,
    pub ends_at:         DateTime<Utc>,
    pub available_count: i32,
    pub created_at:      DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct PollResponse {
    pub id:           Uuid,
    pub poll_id:      Uuid,
    pub slot_id:      Uuid,
    pub user_id:      Option<Uuid>,
    pub email:        String,
    pub display_name: Option<String>,
    pub availability: String,
    pub responded_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize, validator::Validate)]
pub struct CreatePollDto {
    #[validate(length(min = 1, max = 500))]
    pub title:            String,
    pub description:      Option<String>,
    pub duration_minutes: Option<i32>,
    pub location:         Option<String>,
    pub expires_at:       Option<DateTime<Utc>>,
    pub slots:            Vec<PollSlotDto>,
}

#[derive(Debug, Deserialize)]
pub struct PollSlotDto {
    pub starts_at: DateTime<Utc>,
    pub ends_at:   DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
pub struct PollRespondDto {
    pub responses:    Vec<SlotResponseDto>,
    pub email:        Option<String>,
    pub display_name: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct SlotResponseDto {
    pub slot_id:      Uuid,
    pub availability: String,
}

#[derive(Debug, Deserialize)]
pub struct ConfirmPollDto {
    pub slot_id:     Uuid,
    pub create_event: Option<bool>,
}

#[derive(Debug, Deserialize)]
pub struct AvailabilityQuery {
    pub from:     DateTime<Utc>,
    pub until:    DateTime<Utc>,
    pub user_ids: Vec<Uuid>,
}

#[derive(Debug, Serialize)]
pub struct AvailableSlot {
    pub starts_at: DateTime<Utc>,
    pub ends_at:   DateTime<Utc>,
    pub score:     f64, // 1.0 = tous disponibles
}
