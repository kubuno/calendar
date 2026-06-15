use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct Event {
    pub id:               Uuid,
    pub calendar_id:      Uuid,
    pub owner_id:         Uuid,
    pub title:            String,
    pub description:      Option<String>,
    pub location:         Option<String>,
    pub url:              Option<String>,
    pub starts_at:        DateTime<Utc>,
    pub ends_at:          DateTime<Utc>,
    pub all_day:          bool,
    pub timezone:         String,
    pub color:            Option<String>,
    pub rrule:            Option<String>,
    pub exdates:          Vec<DateTime<Utc>>,
    pub parent_event_id:  Option<Uuid>,
    pub recurrence_id:    Option<DateTime<Utc>>,
    pub reminders:        Value,
    pub ical_uid:         String,
    pub etag:             String,
    pub sequence:         i32,
    pub status:           String,
    pub visibility:       String,
    pub busy:             bool,
    pub linked_file_ids:  Vec<Uuid>,
    pub linked_note_id:   Option<Uuid>,
    pub linked_task_ids:  Vec<Uuid>,
    pub meeting_duration_minutes: Option<i32>,
    pub created_at:       DateTime<Utc>,
    pub updated_at:       DateTime<Utc>,
}

/// Représente une occurrence d'un événement (récurrent ou non).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EventInstance {
    pub id:           String,   // "{event_id}" ou "{event_id}_{timestamp}"
    pub event_id:     Uuid,
    pub calendar_id:  Uuid,
    pub owner_id:     Uuid,
    pub title:        String,
    pub description:  Option<String>,
    pub location:     Option<String>,
    pub starts_at:    DateTime<Utc>,
    pub ends_at:      DateTime<Utc>,
    pub all_day:      bool,
    pub is_recurring: bool,
    pub rrule:        Option<String>,
    pub reminders:    Value,
    pub status:       String,
    pub visibility:   String,
    pub busy:         bool,
    pub timezone:     String,
    pub ical_uid:     String,
    pub etag:         String,
    pub color:        Option<String>, // couleur du calendrier
}

#[derive(Debug, Deserialize, validator::Validate)]
pub struct CreateEventDto {
    pub calendar_id:  Uuid,
    #[validate(length(min = 1, max = 500))]
    pub title:        String,
    pub description:  Option<String>,
    pub location:     Option<String>,
    pub url:          Option<String>,
    pub starts_at:    DateTime<Utc>,
    pub ends_at:      DateTime<Utc>,
    pub all_day:      Option<bool>,
    pub timezone:     Option<String>,
    pub color:        Option<String>,
    pub rrule:        Option<String>,
    pub reminders:    Option<Value>,
    pub status:       Option<String>,
    pub visibility:   Option<String>,
    pub busy:         Option<bool>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateEventDto {
    pub calendar_id:  Option<Uuid>,
    pub title:        Option<String>,
    pub description:  Option<String>,
    pub location:     Option<String>,
    pub url:          Option<String>,
    pub starts_at:    Option<DateTime<Utc>>,
    pub ends_at:      Option<DateTime<Utc>>,
    pub all_day:      Option<bool>,
    pub timezone:     Option<String>,
    pub color:        Option<String>,
    #[serde(default)]
    pub clear_color:  bool,
    pub rrule:        Option<String>,
    pub reminders:    Option<Value>,
    pub status:       Option<String>,
    pub visibility:   Option<String>,
    pub busy:         Option<bool>,
}

#[derive(Debug, Deserialize)]
pub struct EventsQuery {
    pub from:        Option<DateTime<Utc>>,
    pub until:       Option<DateTime<Utc>>,
    pub calendar_id: Option<Uuid>,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum RecurrenceScope {
    #[default]
    This,
    Following,
    All,
}
