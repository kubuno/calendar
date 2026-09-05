use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    Extension,
    Json,
};
use uuid::Uuid;

use crate::{
    errors::Result,
    events::publisher,
    handlers::attendees,
    middleware::CalendarUser,
    models::event::{CreateEventDto, EventsQuery, RecurrenceScope, UpdateEventDto},
    services::{
        event_service::EventService,
        icalendar_service::{ICalendarService, ItipMethod},
    },
    state::AppState,
};

#[derive(serde::Deserialize, Default)]
pub struct DeleteQuery {
    #[serde(default)]
    pub scope: RecurrenceScope,
    pub occurrence: Option<chrono::DateTime<chrono::Utc>>,
}

#[derive(serde::Deserialize, Default)]
pub struct UpdateQuery {
    #[serde(default)]
    pub scope: RecurrenceScope,
    /// Start of the targeted occurrence (required for scope=this on a series).
    pub occurrence: Option<chrono::DateTime<chrono::Utc>>,
}

pub async fn list(
    State(state): State<AppState>,
    Extension(user): Extension<CalendarUser>,
    Query(query): Query<EventsQuery>,
) -> Result<Json<serde_json::Value>> {
    let instances = EventService::list(user.id, query, &state.db).await?;
    Ok(Json(serde_json::json!({ "events": instances, "count": instances.len() })))
}

pub async fn create(
    State(state): State<AppState>,
    Extension(user): Extension<CalendarUser>,
    Json(dto): Json<CreateEventDto>,
) -> Result<(StatusCode, Json<serde_json::Value>)> {
    use validator::Validate;
    dto.validate()
        .map_err(|e| crate::errors::CalendarError::Validation(e.to_string()))?;

    // Guests supplied inline on creation, kept aside before the DTO is consumed.
    let guests = dto.attendees.clone().unwrap_or_default();
    for g in &guests {
        g.validate()
            .map_err(|e| crate::errors::CalendarError::Validation(e.to_string()))?;
    }

    let event = EventService::create(user.id, dto, &state.db).await?;

    // Publier l'event vers le core (best-effort)
    let state2 = state.clone();
    let event_id = event.id;
    let user_id = user.id;
    tokio::spawn(async move {
        publisher::publish_event_created(&state2, event_id, user_id).await;
    });

    // Record the guests and, when the instance enables it, ask the Mail module
    // to send the invitations.
    if !guests.is_empty() {
        let invited =
            attendees::insert_guests(&state, event.id, user.id, &user.email, &guests).await?;
        if state.instance().send_email_invitations && !invited.is_empty() {
            attendees::mark_notified(&state.db, event.id, event.sequence).await?;
            let state2 = state.clone();
            let event2 = event.clone();
            let organizer_email = user.email.clone();
            tokio::spawn(async move {
                publisher::publish_invite(
                    &state2,
                    ItipMethod::Request,
                    &event2,
                    &organizer_email,
                    None,
                    &invited,
                )
                .await;
            });
        }
    }

    Ok((StatusCode::CREATED, Json(serde_json::json!({ "event": event }))))
}

pub async fn get(
    State(state): State<AppState>,
    Extension(user): Extension<CalendarUser>,
    Path(id): Path<Uuid>,
) -> Result<Json<serde_json::Value>> {
    let event = EventService::get(id, user.id, &state.db).await?;
    Ok(Json(serde_json::json!({ "event": event })))
}

pub async fn update(
    State(state): State<AppState>,
    Extension(user): Extension<CalendarUser>,
    Path(id): Path<Uuid>,
    Query(q): Query<UpdateQuery>,
    Json(dto): Json<UpdateEventDto>,
) -> Result<Json<serde_json::Value>> {
    let event = EventService::update(id, user.id, dto, q.scope, q.occurrence, &state.db).await?;
    // Notify the people the event is shared with.
    {
        let state2 = state.clone();
        let user_id = user.id;
        let title = event.title.clone();
        tokio::spawn(async move {
            publisher::publish_event_modified(&state2, id, user_id, &title, "updated").await;
        });
    }

    // Re-send the invitation to the guests (SEQUENCE was bumped by the update),
    // so an updated meeting reaches its attendees. Best-effort.
    if state.instance().send_email_invitations {
        let guests = attendees::fetch_guests(&state.db, event.id).await?;
        if !guests.is_empty() {
            attendees::mark_notified(&state.db, event.id, event.sequence).await?;
            let state2 = state.clone();
            let event2 = event.clone();
            let organizer_email = user.email.clone();
            tokio::spawn(async move {
                publisher::publish_invite(
                    &state2,
                    ItipMethod::Request,
                    &event2,
                    &organizer_email,
                    None,
                    &guests,
                )
                .await;
            });
        }
    }

    Ok(Json(serde_json::json!({ "event": event })))
}

pub async fn delete(
    State(state): State<AppState>,
    Extension(user): Extension<CalendarUser>,
    Path(id): Path<Uuid>,
    Query(q): Query<DeleteQuery>,
) -> Result<StatusCode> {
    // Snapshot the event and its guest list BEFORE the delete: the CASCADE wipes
    // the attendees, and a cancellation needs them. Only a full removal of the
    // event warrants a cancellation e-mail — trimming a recurrence ("this and
    // following") is not a cancellation of the meeting.
    let send_invitations = state.instance().send_email_invitations;
    let snapshot = if send_invitations {
        match EventService::get(id, user.id, &state.db).await {
            Ok(ev) => {
                let full_delete = matches!(q.scope, RecurrenceScope::All)
                    || ev.rrule.is_none()
                    || (matches!(q.scope, RecurrenceScope::This) && q.occurrence.is_none());
                if full_delete {
                    let guests = attendees::fetch_guests(&state.db, id).await.unwrap_or_default();
                    if guests.is_empty() { None } else { Some((ev, guests)) }
                } else {
                    None
                }
            }
            Err(_) => None,
        }
    } else {
        None
    };

    EventService::delete(id, user.id, q.scope, q.occurrence, &state.db).await?;

    if let Some((event, guests)) = snapshot {
        let state2 = state.clone();
        let organizer_email = user.email.clone();
        tokio::spawn(async move {
            publisher::publish_invite(
                &state2,
                ItipMethod::Cancel,
                &event,
                &organizer_email,
                None,
                &guests,
            )
            .await;
        });
    }

    Ok(StatusCode::NO_CONTENT)
}

pub async fn export_ics(
    State(state): State<AppState>,
    Extension(user): Extension<CalendarUser>,
    Path(id): Path<Uuid>,
) -> Result<([(axum::http::HeaderName, String); 1], String)> {
    let event = EventService::get(id, user.id, &state.db).await?;
    let ics = ICalendarService::event_to_ics(&event, "Kubuno Calendar");

    Ok(([
        (axum::http::header::CONTENT_TYPE, "text/calendar; charset=utf-8".to_string()),
    ], ics))
}
