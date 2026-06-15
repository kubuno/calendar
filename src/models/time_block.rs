use chrono::{DateTime, NaiveTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct TimeBlock {
    pub id:         Uuid,
    pub owner_id:   Uuid,
    pub label:      String,
    pub color:      String,
    pub days:       Vec<i32>,
    pub start_time: NaiveTime,
    pub end_time:   NaiveTime,
    pub priority:   String,
    pub is_active:  bool,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize, validator::Validate)]
pub struct CreateTimeBlockDto {
    #[validate(length(min = 1, max = 255))]
    pub label:      String,
    pub color:      Option<String>,
    pub days:       Vec<i32>,
    pub start_time: NaiveTime,
    pub end_time:   NaiveTime,
    pub priority:   Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateTimeBlockDto {
    pub label:      Option<String>,
    pub color:      Option<String>,
    pub days:       Option<Vec<i32>>,
    pub start_time: Option<NaiveTime>,
    pub end_time:   Option<NaiveTime>,
    pub priority:   Option<String>,
    pub is_active:  Option<bool>,
}
