use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct Attendee {
    pub id:              Uuid,
    pub event_id:        Uuid,
    pub user_id:         Option<Uuid>,
    pub email:           String,
    pub display_name:    Option<String>,
    pub status:          String,
    pub is_organizer:    bool,
    pub rsvp_token:      Option<String>,
    pub rsvp_expires_at: Option<DateTime<Utc>>,
    pub invited_at:      DateTime<Utc>,
    pub responded_at:    Option<DateTime<Utc>>,
    pub comment:         Option<String>,
}

#[derive(Debug, Deserialize, validator::Validate)]
pub struct InviteAttendeeDto {
    #[validate(email)]
    pub email:        String,
    pub display_name: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct RsvpDto {
    pub status:  String,
    pub comment: Option<String>,
}
