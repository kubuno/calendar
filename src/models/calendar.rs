use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct Calendar {
    pub id:           Uuid,
    pub owner_id:     Uuid,
    pub name:         String,
    pub description:  Option<String>,
    pub color:        String,
    pub cal_type:     String,
    pub is_default:   bool,
    pub is_visible:   bool,
    pub is_public:    bool,
    pub timezone:     String,
    pub caldav_token: String,
    pub ctag:         String,
    /// Remote .ics feed mirrored by this calendar (cal_type = 'subscription').
    pub subscription_url: Option<String>,
    pub last_synced_at:   Option<DateTime<Utc>>,
    pub created_at:   DateTime<Utc>,
    pub updated_at:   DateTime<Utc>,
    /// Caller's rights on this calendar: 'owner' | 'write' | 'read'. Only
    /// populated by `CalendarService::list` (absent from plain SELECT *).
    #[sqlx(default)]
    pub my_permission: Option<String>,
}

#[derive(Debug, Deserialize, validator::Validate)]
pub struct CreateCalendarDto {
    /// Optional client-minted id (local-first sync replay) — honoured verbatim.
    #[serde(default)]
    pub id: Option<Uuid>,
    #[validate(length(min = 1, max = 255))]
    pub name:        String,
    pub description: Option<String>,
    #[validate(length(min = 7, max = 7))]
    pub color:       Option<String>,
    pub cal_type:    Option<String>,
    pub timezone:    Option<String>,
    pub is_public:   Option<bool>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateCalendarDto {
    pub name:        Option<String>,
    pub description: Option<String>,
    pub color:       Option<String>,
    pub timezone:    Option<String>,
    pub is_visible:  Option<bool>,
    pub is_public:   Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct CalendarShare {
    pub id:          Uuid,
    pub calendar_id: Uuid,
    pub shared_with: Uuid,
    pub permission:  String,
    pub created_at:  DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
pub struct ShareCalendarDto {
    pub user_id:    Uuid,
    pub permission: Option<String>,
}

#[derive(Debug, Deserialize, validator::Validate)]
pub struct SubscribeCalendarDto {
    #[validate(length(min = 1, max = 255))]
    pub name:  String,
    #[validate(length(min = 8, max = 2048))]
    pub url:   String,
    #[validate(length(min = 7, max = 7))]
    pub color: Option<String>,
}
