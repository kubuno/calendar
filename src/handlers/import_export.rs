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

    let mut imported = 0usize;
    let mut errors   = Vec::<String>::new();

    for p in parsed {
        let create_dto = CreateEventDto {
            calendar_id: dto.calendar_id,
            title:       p.summary,
            description: p.description,
            location:    p.location,
            url:         None,
            starts_at:   p.starts_at,
            ends_at:     p.ends_at,
            all_day:     Some(false),
            timezone:    Some("UTC".to_string()),
            color:       None,
            rrule:       p.rrule,
            reminders:   None,
            status:      None,
            visibility:  None,
            busy:        Some(true),
        };

        match EventService::create(user.id, create_dto, &state.db).await {
            Ok(_)  => imported += 1,
            Err(e) => errors.push(e.to_string()),
        }
    }

    Ok(Json(serde_json::json!({
        "imported": imported,
        "errors":   errors,
    })))
}
