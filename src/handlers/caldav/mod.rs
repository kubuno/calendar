use axum::{
    extract::{Path, State},
    http::{Method, StatusCode},
    response::{IntoResponse, Response},
    routing::any,
    Router,
};

use crate::{
    services::icalendar_service::ICalendarService,
    state::AppState,
};

pub fn caldav_router() -> Router<AppState> {
    Router::new()
        .route("/.well-known/caldav", any(well_known))
        .route("/caldav/:username/", any(user_principal))
        .route("/caldav/:username/:token/", any(calendar_collection))
        .route("/caldav/:username/:token/:uid", any(event_resource))
}

// ── Handler helpers ───────────────────────────────────────────────────────────

fn xml_response(status: StatusCode, body: impl Into<String>) -> Response {
    (
        status,
        [(axum::http::header::CONTENT_TYPE, "application/xml; charset=utf-8")],
        body.into(),
    )
        .into_response()
}

const XML_MULTISTATUS_START: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">"#;
const XML_MULTISTATUS_END: &str = "</D:multistatus>";

// ── Well-known redirect ───────────────────────────────────────────────────────

async fn well_known(method: Method) -> Response {
    match method.as_str() {
        "OPTIONS" => (
            StatusCode::OK,
            [("Allow", "OPTIONS, PROPFIND, GET")],
            "",
        )
            .into_response(),
        _ => (
            StatusCode::MOVED_PERMANENTLY,
            [(axum::http::header::LOCATION, "/caldav/")],
            "",
        )
            .into_response(),
    }
}

// ── User principal ────────────────────────────────────────────────────────────

async fn user_principal(
    method: Method,
    State(_state): State<AppState>,
    Path(username): Path<String>,
) -> Response {
    match method.as_str() {
        "OPTIONS" => (
            StatusCode::OK,
            [(
                "Allow",
                "OPTIONS, GET, HEAD, PROPFIND, REPORT",
            )],
        )
            .into_response(),
        "PROPFIND" => {
            let body = format!(
                r#"{XML_MULTISTATUS_START}
  <D:response>
    <D:href>/caldav/{username}/</D:href>
    <D:propstat>
      <D:prop>
        <D:displayname>{username}</D:displayname>
        <D:resourcetype><D:principal/><D:collection/></D:resourcetype>
        <C:calendar-home-set><D:href>/caldav/{username}/</D:href></C:calendar-home-set>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
{XML_MULTISTATUS_END}"#
            );
            xml_response(StatusCode::MULTI_STATUS, body)
        }
        _ => StatusCode::METHOD_NOT_ALLOWED.into_response(),
    }
}

// ── Calendar collection ───────────────────────────────────────────────────────

async fn calendar_collection(
    method: Method,
    State(state): State<AppState>,
    Path((username, token)): Path<(String, String)>,
) -> Response {
    match method.as_str() {
        "OPTIONS" => (
            StatusCode::OK,
            [("Allow", "OPTIONS, GET, HEAD, PROPFIND, REPORT, PUT, DELETE")],
        )
            .into_response(),
        "PROPFIND" => {
            // Charger le calendrier par son caldav_token
            let cal_result = sqlx::query_as::<_, crate::models::calendar::Calendar>(
                "SELECT * FROM calendar.calendars WHERE caldav_token = $1",
            )
            .bind(&token)
            .fetch_optional(&state.db)
            .await;

            let cal = match cal_result {
                Ok(Some(c)) => c,
                Ok(None)    => return StatusCode::NOT_FOUND.into_response(),
                Err(e)      => {
                    tracing::error!(error = %e, "CalDAV DB error");
                    return StatusCode::INTERNAL_SERVER_ERROR.into_response();
                }
            };

            let body = format!(
                r#"{XML_MULTISTATUS_START}
  <D:response>
    <D:href>/caldav/{username}/{token}/</D:href>
    <D:propstat>
      <D:prop>
        <D:displayname>{}</D:displayname>
        <D:resourcetype><D:collection/><C:calendar/></D:resourcetype>
        <C:calendar-color>{}</C:calendar-color>
        <D:getctag>{}</D:getctag>
        <D:sync-token>{}</D:sync-token>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
{XML_MULTISTATUS_END}"#,
                cal.name, cal.color, cal.ctag, cal.ctag
            );
            xml_response(StatusCode::MULTI_STATUS, body)
        }
        "REPORT" => {
            // Retourner tous les événements du calendrier en format multi-status
            let events_result = sqlx::query_as::<_, crate::models::event::Event>(
                "SELECT * FROM calendar.events WHERE calendar_id = $1 AND status != 'cancelled'",
            )
            .bind(
                sqlx::query_scalar::<_, uuid::Uuid>(
                    "SELECT id FROM calendar.calendars WHERE caldav_token = $1",
                )
                .bind(&token)
                .fetch_optional(&state.db)
                .await
                .ok()
                .flatten()
                .unwrap_or_default(),
            )
            .fetch_all(&state.db)
            .await;

            let events = match events_result {
                Ok(e)  => e,
                Err(e) => {
                    tracing::error!(error = %e, "CalDAV REPORT DB error");
                    return StatusCode::INTERNAL_SERVER_ERROR.into_response();
                }
            };

            let mut responses = String::new();
            for event in &events {
                let ics = ICalendarService::event_to_ics(event, "Kubuno");
                let escaped_ics = ics.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;");
                responses.push_str(&format!(
                    r#"  <D:response>
    <D:href>/caldav/{username}/{token}/{}.ics</D:href>
    <D:propstat>
      <D:prop>
        <D:getetag>{}</D:getetag>
        <C:calendar-data>{}</C:calendar-data>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
"#,
                    event.ical_uid, event.etag, escaped_ics
                ));
            }

            let body = format!("{XML_MULTISTATUS_START}\n{responses}{XML_MULTISTATUS_END}");
            xml_response(StatusCode::MULTI_STATUS, body)
        }
        _ => StatusCode::METHOD_NOT_ALLOWED.into_response(),
    }
}

// ── Event resource ────────────────────────────────────────────────────────────

async fn event_resource(
    method: Method,
    State(state): State<AppState>,
    Path((_username, token, uid_with_ext)): Path<(String, String, String)>,
) -> Response {
    let uid = uid_with_ext.trim_end_matches(".ics");

    match method.as_str() {
        "GET" | "HEAD" => {
            let event_result = sqlx::query_as::<_, crate::models::event::Event>(
                r#"
                SELECT e.* FROM calendar.events e
                JOIN calendar.calendars c ON c.id = e.calendar_id
                WHERE c.caldav_token = $1 AND e.ical_uid = $2
                "#,
            )
            .bind(&token)
            .bind(uid)
            .fetch_optional(&state.db)
            .await;

            match event_result {
                Ok(Some(event)) => {
                    let ics = ICalendarService::event_to_ics(&event, "Kubuno");
                    (
                        StatusCode::OK,
                        [
                            (axum::http::header::CONTENT_TYPE, "text/calendar; charset=utf-8"),
                            (axum::http::header::ETAG, event.etag.as_str()),
                        ],
                        ics,
                    )
                        .into_response()
                }
                Ok(None)    => StatusCode::NOT_FOUND.into_response(),
                Err(e)      => {
                    tracing::error!(error = %e, "CalDAV GET error");
                    StatusCode::INTERNAL_SERVER_ERROR.into_response()
                }
            }
        }
        "DELETE" => {
            let del_result = sqlx::query(
                r#"
                DELETE FROM calendar.events e
                USING calendar.calendars c
                WHERE e.calendar_id = c.id
                  AND c.caldav_token = $1
                  AND e.ical_uid = $2
                "#,
            )
            .bind(&token)
            .bind(uid)
            .execute(&state.db)
            .await;

            match del_result {
                Ok(r) if r.rows_affected() > 0 => StatusCode::NO_CONTENT.into_response(),
                Ok(_)  => StatusCode::NOT_FOUND.into_response(),
                Err(e) => {
                    tracing::error!(error = %e, "CalDAV DELETE error");
                    StatusCode::INTERNAL_SERVER_ERROR.into_response()
                }
            }
        }
        "PUT" => {
            // CalDAV PUT: créer ou mettre à jour un événement depuis un .ics
            // On obtient le body depuis le request body
            // Note: dans ce handler simplifié, le body n'est pas disponible directement
            // sans l'extractor axum::body::Bytes — voir note ci-dessous.
            // Pour l'instant, retourner 201 Created comme stub.
            tracing::warn!("CalDAV PUT non implémenté pour uid={}", uid);
            StatusCode::CREATED.into_response()
        }
        "OPTIONS" => (
            StatusCode::OK,
            [("Allow", "OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND")],
        )
            .into_response(),
        _ => StatusCode::METHOD_NOT_ALLOWED.into_response(),
    }
}
