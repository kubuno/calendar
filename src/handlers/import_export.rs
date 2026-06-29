use axum::{extract::State, Extension, Json};
use uuid::Uuid;

use crate::{
    errors::Result,
    middleware::CalendarUser,
    models::event::CreateEventDto,
    services::{event_service::EventService, icalendar_service::ICalendarService},
    state::AppState,
};

#[derive(serde::Deserialize)]
pub struct ImportDto {
    pub calendar_id: Uuid,
    pub ics_content: String,
}

pub async fn import_ics(
    State(state): State<AppState>,
    Extension(user): Extension<CalendarUser>,
    Json(dto): Json<ImportDto>,
) -> Result<Json<serde_json::Value>> {
    let parsed = ICalendarService::parse_ics(&dto.ics_content)?;
    let total  = parsed.len();

    let mut imported = 0usize;
    let mut updated  = 0usize;
    let mut skipped  = 0usize;
    let mut errors   = Vec::<String>::new();

    for p in parsed {
        // Preserve the event's iCalendar UID for idempotent re-imports; generate
        // one only when the source event lacks it.
        let ical_uid = if p.uid.trim().is_empty() {
            format!("{}@kubuno.local", Uuid::new_v4())
        } else {
            p.uid.clone()
        };

        let create_dto = CreateEventDto {
            calendar_id: dto.calendar_id,
            title:       p.summary,
            description: p.description,
            location:    p.location,
            url:         None,
            starts_at:   p.starts_at,
            ends_at:     p.ends_at,
            all_day:     Some(p.all_day),
            timezone:    Some("UTC".to_string()),
            color:       None,
            rrule:       p.rrule,
            reminders:   None,
            status:      None,
            visibility:  None,
            busy:        Some(true),
        };

        match EventService::import_event(user.id, create_dto, &ical_uid, &state.db).await {
            Ok(Some(true))  => imported += 1,
            Ok(Some(false)) => updated  += 1,
            Ok(None)        => skipped  += 1,
            Err(e)          => errors.push(e.to_string()),
        }
    }

    Ok(Json(serde_json::json!({
        "total":    total,
        "imported": imported,
        "updated":  updated,
        "skipped":  skipped,
        "errors":   errors,
    })))
}
