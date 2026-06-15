use crate::state::AppState;
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

pub async fn publish_event_updated(state: &AppState, event_id: Uuid, user_id: Uuid) {
    let payload = json!({
        "type": "EventUpdated",
        "payload": {
            "event_id":  event_id,
            "user_id":   user_id,
            "module_id": "calendar",
        }
    });
    send_to_core(state, &payload).await;
}

pub async fn publish_event_deleted(state: &AppState, event_id: Uuid, user_id: Uuid) {
    let payload = json!({
        "type": "EventDeleted",
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

async fn send_to_core(state: &AppState, payload: &serde_json::Value) {
    let url = format!("{}/internal/events/publish", state.settings.core.url);
    match reqwest::Client::new()
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
