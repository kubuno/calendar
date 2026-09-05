use crate::{
    models::event::Event,
    services::icalendar_service::{ICalendarService, ItipMethod},
    state::AppState,
};
use serde_json::json;
use uuid::Uuid;

pub async fn publish_event_created(state: &AppState, event_id: Uuid, user_id: Uuid) {
    let payload = json!({
        "type": "EventCreated",
        "payload": {
            "event_id":  event_id,
            "user_id":   user_id,
            "module_id": "calendar",
        }
    });
    send_to_core(state, &payload).await;
}

/// Notifie les utilisateurs avec qui l'événement est partagé (partages de
/// calendrier + participants) qu'il a été modifié. Délivré en WS uniquement à
/// ces utilisateurs (via le routage ciblé du core sur `recipient_user_ids`).
pub async fn publish_event_modified(
    state: &AppState,
    event_id: Uuid,
    actor_id: Uuid,
    title: &str,
    kind: &str, // "updated" | "deleted"
) {
    let recipients: Vec<Uuid> = sqlx::query_scalar::<_, Uuid>(
        r#"
        SELECT DISTINCT u FROM (
            SELECT cs.shared_with AS u
            FROM calendar.calendar_shares cs
            JOIN calendar.events e ON e.calendar_id = cs.calendar_id
            WHERE e.id = $1
            UNION
            SELECT a.user_id AS u
            FROM calendar.attendees a
            WHERE a.event_id = $1 AND a.user_id IS NOT NULL
        ) s
        WHERE u <> $2
        "#,
    )
    .bind(event_id)
    .bind(actor_id)
    .fetch_all(&state.db)
    .await
    .unwrap_or_default();

    if recipients.is_empty() {
        return;
    }

    let payload = json!({
        "type": "Custom",
        "payload": {
            "event_type": "EventModified",
            "module_id":  "calendar",
            "payload": {
                "recipient_user_ids": recipients,
                "event_id":           event_id,
                "title":              title,
                "kind":               kind,
            }
        }
    });
    send_to_core(state, &payload).await;
}

/// Publishes a `calendar.invite` on the core's bus so the Mail module sends (or
/// cancels) the invitation e-mails. It is a module→module data channel: the
/// payload carries **no** `recipient_user_ids`, so the core delivers it to the
/// subscribed modules without raising any user-facing push notification.
///
/// Best-effort: a failure is logged and swallowed so it never breaks the user's
/// create/update/delete request.
pub async fn publish_invite(
    state: &AppState,
    method: ItipMethod,
    event: &Event,
    organizer_email: &str,
    organizer_name: Option<&str>,
    attendees: &[(String, Option<String>)],
) {
    if attendees.is_empty() {
        return;
    }

    let method_str = match method {
        ItipMethod::Request => "request",
        ItipMethod::Cancel  => "cancel",
    };

    let ics = ICalendarService::event_to_itip(event, organizer_email, organizer_name, attendees, method);

    let attendees_json: Vec<serde_json::Value> = attendees
        .iter()
        .map(|(email, name)| json!({ "email": email, "name": name }))
        .collect();

    let payload = json!({
        "type": "Custom",
        "payload": {
            "event_type": "calendar.invite",
            "module_id":  "calendar",
            "payload": {
                "method":            method_str,
                "organizer_user_id": event.owner_id,
                "organizer_email":   organizer_email,
                "organizer_name":    organizer_name,
                "event_uid":         event.ical_uid,
                "sequence":          event.sequence,
                "summary":           event.title,
                "starts_at":         event.starts_at,
                "ends_at":           event.ends_at,
                "all_day":           event.all_day,
                "location":          event.location,
                "description":       event.description,
                "attendees":         attendees_json,
                "ics":               ics,
            }
        }
    });
    send_to_core(state, &payload).await;
}

async fn send_to_core(state: &AppState, payload: &serde_json::Value) {
    let url = format!("{}/internal/events/publish", state.settings.core.url);
    match state
        .http
        .post(&url)
        .header("X-Internal-Secret", &state.settings.core.internal_secret)
        .json(payload)
        .send()
        .await
    {
        Ok(r) if r.status().is_success() => {}
        Ok(r) => tracing::warn!(status = %r.status(), "Publish event: réponse inattendue"),
        Err(e) => tracing::warn!(error = %e, "Publish event: erreur réseau"),
    }
}
