//! The live server path (`--doc <calendar-id>`): the app borrows access tokens from the Kubuno desktop shell's
//! token broker (`kubuno_desktop_sync`) and talks to the account's core — it never holds a password or a
//! refresh token. Events are read with `GET /calendar/events` (the server expands recurring series over the
//! window) and mutated with the calendar REST API, exactly as the web client does (`web/src/api.ts`).

use std::sync::Arc;

use kubuno_calendar_core::date::Date;
use kubuno_calendar_core::layout::month_grid;
use kubuno_calendar_core::model::EventInstance;

const CAL_PREFIX: &str = "/api/v1/calendar";

/// Install this app's token broker (the shell's, or the sandbox's under `KUBUNO_SANDBOX_DIR`). Call once before
/// any live request; a missing broker is logged and every later request then fails cleanly.
pub fn install_broker() {
    match kubuno_desktop_sync::tokens::BrokerProvider::for_app(crate::app::PROGRAM) {
        Ok(p) => kubuno_desktop_sync::tokens::install(Arc::new(p)),
        Err(e) => tracing::error!("[calendar] no token broker: {e}"),
    }
}

/// Percent-encode a path segment / query value (the unreserved set stays).
pub fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn account() -> Result<kubuno_desktop_sync::AccountRef, String> {
    kubuno_desktop_sync::current_account()
        .map_err(|e| format!("{e:?}"))?
        .ok_or_else(|| "no account — is the Kubuno desktop shell running and signed in?".to_string())
}

/// One authenticated request to the account's core; returns `(status, body)`.
fn request(method: &str, path: &str, body: Option<Vec<u8>>) -> Result<(u16, Vec<u8>), String> {
    let account = account()?;
    let mut api = kubuno_desktop_sync::account_api(&account);
    let resp = api.request(method, path, &[], body).map_err(|e| format!("{e:?}"))?;
    Ok((resp.status, resp.body))
}

/// The events of `calendar_id` over the window that covers `anchor`'s month grid (the server returns ready,
/// expanded `EventInstance`s — the same shape the web receives).
pub fn fetch_month(calendar_id: &str, anchor: Date, week_starts_on: u32) -> Result<Vec<EventInstance>, String> {
    let grid = month_grid(anchor, week_starts_on);
    let from = grid.first().ok_or("empty grid")?;
    let until = grid.last().ok_or("empty grid")?.add_days(1);
    let path = format!(
        "{CAL_PREFIX}/events?from={}T00:00:00Z&until={}T00:00:00Z&calendar_ids={}",
        from.iso(),
        until.iso(),
        urlencode(calendar_id),
    );
    let (status, body) = request("GET", &path, None)?;
    if status != 200 {
        return Err(format!("GET events → HTTP {status}"));
    }
    #[derive(serde::Deserialize)]
    struct Events {
        events: Vec<EventInstance>,
    }
    let parsed: Events = serde_json::from_slice(&body).map_err(|e| e.to_string())?;
    Ok(parsed.events)
}

/// Create a timed event on `calendar_id` (`POST /calendar/events`). Returns the created event's id.
pub fn create_event(calendar_id: &str, title: &str, starts_at: &str, ends_at: &str, all_day: bool) -> Result<String, String> {
    let dto = serde_json::json!({
        "calendar_id": calendar_id,
        "title": title,
        "starts_at": starts_at,
        "ends_at": ends_at,
        "all_day": all_day,
    });
    let (status, body) = request("POST", &format!("{CAL_PREFIX}/events"), Some(serde_json::to_vec(&dto).map_err(|e| e.to_string())?))?;
    if !(200..300).contains(&status) {
        return Err(format!("POST event → HTTP {status}"));
    }
    #[derive(serde::Deserialize)]
    struct Created {
        event: EventInstance,
    }
    let parsed: Created = serde_json::from_slice(&body).map_err(|e| e.to_string())?;
    Ok(parsed.event.event_id)
}

/// Rename an event (`PATCH /calendar/events/:id`). `scope`/`occurrence` target a recurring series.
pub fn rename_event(event_id: &str, title: &str, scope: Option<&str>, occurrence: Option<&str>) -> Result<(), String> {
    let mut path = format!("{CAL_PREFIX}/events/{}", urlencode(event_id));
    let q = query(scope, occurrence);
    if !q.is_empty() {
        path.push('?');
        path.push_str(&q);
    }
    let dto = serde_json::json!({ "title": title });
    let (status, _) = request("PATCH", &path, Some(serde_json::to_vec(&dto).map_err(|e| e.to_string())?))?;
    if !(200..300).contains(&status) {
        return Err(format!("PATCH event → HTTP {status}"));
    }
    Ok(())
}

/// Delete an event (`DELETE /calendar/events/:id`). `scope`/`occurrence` target a recurring series.
pub fn delete_event(event_id: &str, scope: Option<&str>, occurrence: Option<&str>) -> Result<(), String> {
    let mut path = format!("{CAL_PREFIX}/events/{}", urlencode(event_id));
    let q = query(scope, occurrence);
    if !q.is_empty() {
        path.push('?');
        path.push_str(&q);
    }
    let (status, _) = request("DELETE", &path, None)?;
    if !(200..300).contains(&status) {
        return Err(format!("DELETE event → HTTP {status}"));
    }
    Ok(())
}

fn query(scope: Option<&str>, occurrence: Option<&str>) -> String {
    let mut parts = Vec::new();
    if let Some(s) = scope {
        parts.push(format!("scope={}", urlencode(s)));
    }
    if let Some(o) = occurrence {
        parts.push(format!("occurrence={}", urlencode(o)));
    }
    parts.join("&")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_ids() {
        assert_eq!(urlencode("cafe0000-0000-4000-8000-000000000001"), "cafe0000-0000-4000-8000-000000000001");
        assert_eq!(urlencode("a b/c"), "a%20b%2Fc");
    }

    #[test]
    fn builds_query() {
        assert_eq!(query(Some("this"), Some("2026-10-12T07:00:00Z")), "scope=this&occurrence=2026-10-12T07%3A00%3A00Z");
        assert_eq!(query(None, None), "");
    }
}
