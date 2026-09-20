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
    /// Exception dates. A JSON array of RFC3339 timestamps on every engine
    /// (PostgreSQL `jsonb`, MySQL `JSON`, SQLite `TEXT`) — see kubuno-db §2.8.
    #[sqlx(json)]
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
    /// A JSON array of UUIDs (hyphenated strings) on every engine — see §2.8.
    #[sqlx(json)]
    pub linked_file_ids:  Vec<Uuid>,
    pub linked_note_id:   Option<Uuid>,
    /// A JSON array of UUIDs (hyphenated strings) on every engine — see §2.8.
    #[sqlx(json)]
    pub linked_task_ids:  Vec<Uuid>,
    pub meeting_duration_minutes: Option<i32>,
    /// What the organiser lets the guests do — see migration `000012`. Three
    /// separate decisions rather than one "level": they are not ordered, and a
    /// meeting whose guests may invite but not see each other is a real one.
    #[serde(default)]
    pub guests_can_modify:     bool,
    #[serde(default = "yes")]
    pub guests_can_invite:     bool,
    #[serde(default = "yes")]
    pub guests_can_see_guests: bool,
    pub created_at:       DateTime<Utc>,
    pub updated_at:       DateTime<Utc>,
}

/// The permissive side of the two defaults, spelled once.
fn yes() -> bool { true }

/// Represents one occurrence of an event (recurring or not).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EventInstance {
    pub id:           String,   // "{event_id}" ou "{event_id}_{timestamp}"
    pub event_id:     Uuid,
    pub calendar_id:  Uuid,
    pub owner_id:     Uuid,
    pub title:        String,
    pub description:  Option<String>,
    pub location:     Option<String>,
    pub url:          Option<String>,
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
    /// Participation status of the requesting user when they are an attendee
    /// ('accepted' | 'declined' | 'tentative' | 'needs-action'), else None.
    /// Lets the client honour the "show declined events" display preference.
    #[serde(default)]
    pub my_status:    Option<String>,
    /// What the organiser lets the guests do. Carried on the occurrence because
    /// that is what a client holds when it draws the event — asking for the
    /// master row just to know whether a checkbox is ticked would be a request
    /// per event.
    #[serde(default)]
    pub guests_can_modify:     bool,
    #[serde(default = "yes")]
    pub guests_can_invite:     bool,
    #[serde(default = "yes")]
    pub guests_can_see_guests: bool,
}

#[derive(Debug, Deserialize, validator::Validate)]
pub struct CreateEventDto {
    /// Optional client-minted id (local-first sync replay) — honoured verbatim.
    #[serde(default)]
    pub id: Option<Uuid>,
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
    /// Guests to invite immediately on creation. The server inserts a row for
    /// each, resolves those matching an instance account, and — when the
    /// instance allows it — asks the Mail module to send the invitations.
    #[serde(default)]
    pub attendees:    Option<Vec<crate::models::attendee::AttendeeInputDto>>,
    /// Absent keeps the documented default: guests may invite and see one
    /// another, and may not rewrite the event.
    pub guests_can_modify:     Option<bool>,
    pub guests_can_invite:     Option<bool>,
    pub guests_can_see_guests: Option<bool>,
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
    /// Remove the recurrence ("Does not repeat") — `rrule: None` means
    /// "unchanged", hence this explicit flag, like `clear_color`.
    #[serde(default)]
    pub clear_rrule:  bool,
    pub reminders:    Option<Value>,
    pub status:       Option<String>,
    pub visibility:   Option<String>,
    pub busy:         Option<bool>,
    pub guests_can_modify:     Option<bool>,
    pub guests_can_invite:     Option<bool>,
    pub guests_can_see_guests: Option<bool>,

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
