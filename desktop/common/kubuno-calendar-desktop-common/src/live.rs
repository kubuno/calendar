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

/// The events of `calendar_id` between `from` (inclusive) and `until` (exclusive), as the server's ready,
/// expanded `EventInstance`s — the same shape the web receives.
pub fn fetch_events(calendar_id: &str, from: Date, until: Date) -> Result<Vec<EventInstance>, String> {
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

/// The events over the window that covers `anchor`'s month grid.
pub fn fetch_month(calendar_id: &str, anchor: Date, week_starts_on: u32) -> Result<Vec<EventInstance>, String> {
    let grid = month_grid(anchor, week_starts_on);
    let from = *grid.first().ok_or("empty grid")?;
    let until = grid.last().ok_or("empty grid")?.add_days(1);
    fetch_events(calendar_id, from, until)
}

/// The events of `anchor`'s whole year (for the Year view's density dots).
pub fn fetch_year(calendar_id: &str, anchor: Date) -> Result<Vec<EventInstance>, String> {
    let from = Date { year: anchor.year, month: 1, day: 1 };
    let until = Date { year: anchor.year + 1, month: 1, day: 1 };
    fetch_events(calendar_id, from, until)
}

/// A wide window (`today` ± one year) to search over, matching the web search range.
pub fn fetch_search_range(calendar_id: &str, today: Date) -> Result<Vec<EventInstance>, String> {
    let from = Date { year: today.year - 1, ..today };
    let until = Date { year: today.year + 1, ..today };
    fetch_events(calendar_id, from, until)
}

/// What the event editor collected, ready for the REST API. `edit_id` present = edit (PATCH), absent = create
/// (POST); `occurrence`/`scope` target a recurring series on an edit.
#[derive(Debug, Clone, Default)]
pub struct EventWrite {
    pub title: String,
    pub starts_at: String,
    pub ends_at: String,
    pub all_day: bool,
    pub location: String,
    pub description: String,
    pub rrule: Option<String>,
    /// The chosen event colour (`#rrggbb`); `None` = "default (calendar colour)".
    pub color: Option<String>,
    /// The reminders to store, as `(method, minutes_before)` pairs. `None` leaves them unchanged; an empty
    /// vector clears them.
    pub reminders: Option<Vec<(String, i64)>>,
    /// Guest e-mail addresses to invite (create only; the server's `attendees` input). `None` = unchanged.
    pub attendees: Option<Vec<String>>,
    pub guests_can_modify: Option<bool>,
    pub guests_can_invite: Option<bool>,
    pub guests_can_see_guests: Option<bool>,
    /// The calendar the event belongs to, chosen in the calendar picker. On create it selects the target
    /// calendar; on edit it moves the event. `None` keeps the default/current calendar.
    pub calendar_target: Option<String>,
    pub edit_id: Option<String>,
    pub occurrence: Option<String>,
    pub scope: Option<String>,
}

/// Create or update an event from the editor's data. Create = `POST /calendar/events`; edit = `PATCH
/// /calendar/events/:id` with the recurring `scope`/`occurrence` as query parameters.
pub fn save_event(calendar_id: &str, w: &EventWrite) -> Result<(), String> {
    let mut body = serde_json::Map::new();
    body.insert("title".into(), serde_json::Value::String(w.title.clone()));
    body.insert("starts_at".into(), serde_json::Value::String(w.starts_at.clone()));
    body.insert("ends_at".into(), serde_json::Value::String(w.ends_at.clone()));
    body.insert("all_day".into(), serde_json::Value::Bool(w.all_day));
    body.insert("location".into(), serde_json::Value::String(w.location.clone()));
    body.insert("description".into(), serde_json::Value::String(w.description.clone()));
    // Colour: a chosen swatch, or "default" — on edit that means clearing any per-event colour.
    match &w.color {
        Some(c) => {
            body.insert("color".into(), serde_json::Value::String(c.clone()));
        }
        None if w.edit_id.is_some() => {
            body.insert("clear_color".into(), serde_json::Value::Bool(true));
        }
        None => {}
    }
    if let Some(rems) = &w.reminders {
        let arr: Vec<serde_json::Value> = rems
            .iter()
            .map(|(kind, minutes)| serde_json::json!({ "type": kind, "minutes_before": minutes }))
            .collect();
        body.insert("reminders".into(), serde_json::Value::Array(arr));
    }
    if let Some(emails) = &w.attendees {
        let arr: Vec<serde_json::Value> = emails.iter().map(|e| serde_json::json!({ "email": e })).collect();
        body.insert("attendees".into(), serde_json::Value::Array(arr));
    }
    if let Some(v) = w.guests_can_modify {
        body.insert("guests_can_modify".into(), serde_json::Value::Bool(v));
    }
    if let Some(v) = w.guests_can_invite {
        body.insert("guests_can_invite".into(), serde_json::Value::Bool(v));
    }
    if let Some(v) = w.guests_can_see_guests {
        body.insert("guests_can_see_guests".into(), serde_json::Value::Bool(v));
    }
    match &w.rrule {
        Some(r) => {
            body.insert("rrule".into(), serde_json::Value::String(r.clone()));
        }
        None if w.edit_id.is_some() => {
            // Editing to "does not repeat" clears the rule (the web's `clear_rrule`).
            body.insert("clear_rrule".into(), serde_json::Value::Bool(true));
        }
        None => {}
    }
    match &w.edit_id {
        None => {
            let target = w.calendar_target.as_deref().unwrap_or(calendar_id);
            body.insert("calendar_id".into(), serde_json::Value::String(target.to_string()));
            let (status, _) = request("POST", &format!("{CAL_PREFIX}/events"), Some(serde_json::to_vec(&body).map_err(|e| e.to_string())?))?;
            if !(200..300).contains(&status) {
                return Err(format!("POST event → HTTP {status}"));
            }
        }
        Some(id) => {
            // On edit the picker moves the event to another calendar.
            if let Some(target) = &w.calendar_target {
                body.insert("calendar_id".into(), serde_json::Value::String(target.clone()));
            }
            let mut path = format!("{CAL_PREFIX}/events/{}", urlencode(id));
            let q = query(w.scope.as_deref(), w.occurrence.as_deref());
            if !q.is_empty() {
                path.push('?');
                path.push_str(&q);
            }
            let (status, _) = request("PATCH", &path, Some(serde_json::to_vec(&body).map_err(|e| e.to_string())?))?;
            if !(200..300).contains(&status) {
                return Err(format!("PATCH event → HTTP {status}"));
            }
            // Guests are not part of the event PATCH; reconcile them through the attendee API.
            if let Some(desired) = &w.attendees {
                sync_attendees(id, desired)?;
            }
        }
    }
    Ok(())
}

/// The guests of an event (`GET /calendar/events/:id/attendees`): `(attendee id, email, is_organizer)`.
pub fn fetch_attendees(event_id: &str) -> Result<Vec<(String, String, bool)>, String> {
    let (status, body) = request("GET", &format!("{CAL_PREFIX}/events/{}/attendees", urlencode(event_id)), None)?;
    if status != 200 {
        return Err(format!("GET attendees → HTTP {status}"));
    }
    let v: serde_json::Value = serde_json::from_slice(&body).map_err(|e| e.to_string())?;
    let arr = v.get("attendees").and_then(|a| a.as_array()).or_else(|| v.as_array()).cloned().unwrap_or_default();
    Ok(arr
        .iter()
        .filter_map(|a| {
            let aid = a.get("id").and_then(|x| x.as_str())?.to_string();
            let email = a.get("email").and_then(|x| x.as_str()).unwrap_or_default().to_string();
            let organizer = a.get("is_organizer").and_then(|x| x.as_bool()).unwrap_or(false);
            Some((aid, email, organizer))
        })
        .collect())
}

/// The guest e-mails a user can edit (everyone but the organizer), for prefilling the editor on an edit.
pub fn fetch_guest_emails(event_id: &str) -> Vec<String> {
    fetch_attendees(event_id)
        .unwrap_or_default()
        .into_iter()
        .filter(|(_, email, organizer)| !organizer && !email.is_empty())
        .map(|(_, email, _)| email)
        .collect()
}

/// Invite one guest to an existing event (`POST /calendar/events/:id/attendees`).
fn add_attendee(event_id: &str, email: &str) -> Result<(), String> {
    let dto = serde_json::json!({ "email": email });
    let (status, _) = request("POST", &format!("{CAL_PREFIX}/events/{}/attendees", urlencode(event_id)), Some(serde_json::to_vec(&dto).map_err(|e| e.to_string())?))?;
    if !(200..300).contains(&status) {
        return Err(format!("POST attendee → HTTP {status}"));
    }
    Ok(())
}

/// Remove one guest from an event (`DELETE /calendar/events/:id/attendees/:aid`).
fn remove_attendee(event_id: &str, aid: &str) -> Result<(), String> {
    let (status, _) = request("DELETE", &format!("{CAL_PREFIX}/events/{}/attendees/{}", urlencode(event_id), urlencode(aid)), None)?;
    if !(200..300).contains(&status) {
        return Err(format!("DELETE attendee → HTTP {status}"));
    }
    Ok(())
}

/// Reconcile an edited event's guest list with the server (the attendee API, since `PATCH /events` does not
/// take attendees): invite the e-mails that were added, remove the non-organizer guests that were dropped.
fn sync_attendees(event_id: &str, desired: &[String]) -> Result<(), String> {
    let current = fetch_attendees(event_id)?;
    for email in desired {
        if !email.is_empty() && !current.iter().any(|(_, e, _)| e.eq_ignore_ascii_case(email)) {
            add_attendee(event_id, email)?;
        }
    }
    for (aid, email, organizer) in &current {
        if !organizer && !email.is_empty() && !desired.iter().any(|d| d.eq_ignore_ascii_case(email)) {
            remove_attendee(event_id, aid)?;
        }
    }
    Ok(())
}

/// The calendars the signed-in user can see (`GET /calendar/calendars`), for the editor's calendar picker and
/// the sidebar. The server returns `{ "calendars": [ … ] }`.
pub fn fetch_calendars() -> Result<Vec<kubuno_calendar_core::model::Calendar>, String> {
    let (status, body) = request("GET", &format!("{CAL_PREFIX}/calendars"), None)?;
    if status != 200 {
        return Err(format!("GET calendars → HTTP {status}"));
    }
    #[derive(serde::Deserialize)]
    struct Calendars {
        calendars: Vec<kubuno_calendar_core::model::Calendar>,
    }
    let parsed: Calendars = serde_json::from_slice(&body).map_err(|e| e.to_string())?;
    Ok(parsed.calendars)
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
    // Read the new id leniently (`{ "event": { "event_id" | "id": … } }`): the create response carries fields
    // this model may not name, and all we need back is the id to delete/edit it.
    let v: serde_json::Value = serde_json::from_slice(&body).map_err(|e| e.to_string())?;
    let ev = v.get("event").unwrap_or(&v);
    ev.get("event_id")
        .or_else(|| ev.get("id"))
        .and_then(|x| x.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "create response had no event id".to_string())
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
