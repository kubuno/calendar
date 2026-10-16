//! The live server path (`--doc <calendar-id>`): the app borrows access tokens from the Kubuno desktop shell's
//! token broker (`kubuno_desktop_sync`) and talks to the account's core - it never holds a password or a
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
        .ok_or_else(|| "no account - is the Kubuno desktop shell running and signed in?".to_string())
}

/// One authenticated request to the account's core; returns `(status, body)`.
fn request(method: &str, path: &str, body: Option<Vec<u8>>) -> Result<(u16, Vec<u8>), String> {
    let account = account()?;
    let mut api = kubuno_desktop_sync::account_api(&account);
    let resp = api.request(method, path, &[], body).map_err(|e| format!("{e:?}"))?;
    Ok((resp.status, resp.body))
}

/// The events of `calendar_id` between `from` (inclusive) and `until` (exclusive), as the server's ready,
/// expanded `EventInstance`s - the same shape the web receives.
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
    // Colour: a chosen swatch, or "default" - on edit that means clearing any per-event colour.
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

/// Subscribe to an external .ics feed (`POST /calendar/calendars/subscribe`): the server mirrors it as a new
/// read-only calendar. Returns the new calendar's name on success.
pub fn subscribe_calendar(name: &str, url: &str, color: &str) -> Result<String, String> {
    let dto = serde_json::json!({ "name": name, "url": url, "color": color });
    let (status, body) = request("POST", &format!("{CAL_PREFIX}/calendars/subscribe"), Some(serde_json::to_vec(&dto).map_err(|e| e.to_string())?))?;
    if !(200..300).contains(&status) {
        return Err(format!("POST subscribe → HTTP {status}"));
    }
    let v: serde_json::Value = serde_json::from_slice(&body).map_err(|e| e.to_string())?;
    Ok(v.get("calendar").and_then(|c| c.get("name")).and_then(|n| n.as_str()).unwrap_or(name).to_string())
}

/// Import an .ics document into `calendar_id` (`POST /calendar/import`). Returns `(total, imported, updated,
/// skipped)`.
pub fn import_ics(calendar_id: &str, ics_content: &str) -> Result<(i64, i64, i64, i64), String> {
    let dto = serde_json::json!({ "calendar_id": calendar_id, "ics_content": ics_content });
    let (status, body) = request("POST", &format!("{CAL_PREFIX}/import"), Some(serde_json::to_vec(&dto).map_err(|e| e.to_string())?))?;
    if !(200..300).contains(&status) {
        return Err(format!("POST import → HTTP {status}"));
    }
    let v: serde_json::Value = serde_json::from_slice(&body).map_err(|e| e.to_string())?;
    let num = |k: &str| v.get(k).and_then(|x| x.as_i64()).unwrap_or(0);
    Ok((num("total"), num("imported"), num("updated"), num("skipped")))
}

/// Export a calendar as .ics (`GET /calendar/calendars/:id/export`). Returns the raw iCalendar bytes.
pub fn export_calendar(calendar_id: &str) -> Result<Vec<u8>, String> {
    let (status, body) = request("GET", &format!("{CAL_PREFIX}/calendars/{}/export", urlencode(calendar_id)), None)?;
    if status != 200 {
        return Err(format!("GET export → HTTP {status}"));
    }
    Ok(body)
}

/// The users a calendar is shared with (`GET /calendar/calendars/:id/shares`): `(shared_with, permission)`.
pub fn list_shares(calendar_id: &str) -> Result<Vec<(String, String)>, String> {
    let (status, body) = request("GET", &format!("{CAL_PREFIX}/calendars/{}/shares", urlencode(calendar_id)), None)?;
    if status != 200 {
        return Err(format!("GET shares → HTTP {status}"));
    }
    let v: serde_json::Value = serde_json::from_slice(&body).map_err(|e| e.to_string())?;
    let arr = v.get("shares").and_then(|a| a.as_array()).cloned().unwrap_or_default();
    Ok(arr
        .iter()
        .filter_map(|s| Some((s.get("shared_with")?.as_str()?.to_string(), s.get("permission").and_then(|p| p.as_str()).unwrap_or("read").to_string())))
        .collect())
}

/// Make a calendar public (or private) - `PATCH /calendar/calendars/:id { is_public }` - for the public
/// `.ics`/subscription feed. Returns the new `is_public`.
pub fn set_calendar_public(calendar_id: &str, is_public: bool) -> Result<bool, String> {
    let dto = serde_json::json!({ "is_public": is_public });
    let (status, body) = request("PATCH", &format!("{CAL_PREFIX}/calendars/{}", urlencode(calendar_id)), Some(serde_json::to_vec(&dto).map_err(|e| e.to_string())?))?;
    if !(200..300).contains(&status) {
        return Err(format!("PATCH calendar → HTTP {status}"));
    }
    let v: serde_json::Value = serde_json::from_slice(&body).map_err(|e| e.to_string())?;
    Ok(v.get("calendar").and_then(|c| c.get("is_public")).and_then(|b| b.as_bool()).unwrap_or(is_public))
}

/// Resolve a set of user ids to `(id, display_name)` pairs (`GET /users/lookup?ids=…`), for naming the people
/// a calendar is shared with. Ids the directory does not return keep their raw id.
pub fn lookup_users(ids: &[String]) -> Result<Vec<(String, String)>, String> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let joined = ids.iter().map(|s| urlencode(s)).collect::<Vec<_>>().join(",");
    let (status, body) = request("GET", &format!("/api/v1/users/lookup?ids={joined}"), None)?;
    if status != 200 {
        return Err(format!("GET lookup → HTTP {status}"));
    }
    let v: serde_json::Value = serde_json::from_slice(&body).map_err(|e| e.to_string())?;
    let arr = v.get("users").and_then(|a| a.as_array()).cloned().unwrap_or_default();
    Ok(arr
        .iter()
        .filter_map(|u| {
            let id = u.get("id")?.as_str()?.to_string();
            let name = u.get("display_name").and_then(|n| n.as_str()).filter(|s| !s.is_empty()).or_else(|| u.get("username").and_then(|n| n.as_str())).unwrap_or(&id).to_string();
            Some((id, name))
        })
        .collect())
}

/// Search the directory for a user (`GET /users/search?q=…`): `(id, display_name, username)`, best matches first.
pub fn search_users(query: &str) -> Result<Vec<(String, String, String)>, String> {
    let (status, body) = request("GET", &format!("/api/v1/users/search?limit=8&q={}", urlencode(query)), None)?;
    if status != 200 {
        return Err(format!("GET user search → HTTP {status}"));
    }
    let v: serde_json::Value = serde_json::from_slice(&body).map_err(|e| e.to_string())?;
    let arr = v.get("users").and_then(|a| a.as_array()).cloned().unwrap_or_default();
    Ok(arr
        .iter()
        .filter_map(|u| {
            let id = u.get("id")?.as_str()?.to_string();
            let username = u.get("username").and_then(|n| n.as_str()).unwrap_or("").to_string();
            let display = u.get("display_name").and_then(|n| n.as_str()).filter(|s| !s.is_empty()).unwrap_or(&username).to_string();
            Some((id, display, username))
        })
        .collect())
}

/// Share a calendar with a user (`POST /calendar/calendars/:id/share { user_id, permission }`). `permission`
/// is `"read"` or `"write"`. Re-sharing an existing user updates their permission.
pub fn share_calendar(calendar_id: &str, user_id: &str, permission: &str) -> Result<(), String> {
    let dto = serde_json::json!({ "user_id": user_id, "permission": permission });
    let (status, _) = request("POST", &format!("{CAL_PREFIX}/calendars/{}/share", urlencode(calendar_id)), Some(serde_json::to_vec(&dto).map_err(|e| e.to_string())?))?;
    if !(200..300).contains(&status) {
        return Err(format!("POST share → HTTP {status}"));
    }
    Ok(())
}

/// Revoke a user's access to a calendar (`DELETE /calendar/calendars/:id/share/:user_id`).
pub fn unshare_calendar(calendar_id: &str, user_id: &str) -> Result<(), String> {
    let (status, _) = request("DELETE", &format!("{CAL_PREFIX}/calendars/{}/share/{}", urlencode(calendar_id), urlencode(user_id)), None)?;
    if !(200..300).contains(&status) {
        return Err(format!("DELETE share → HTTP {status}"));
    }
    Ok(())
}

/// The public read-only `.ics` feed URL of a calendar (web `calendarApi.publicFeedUrl`): the account's server
/// origin plus the calendar's CalDAV token. Valid only while the calendar `is_public`.
pub fn public_feed_url(caldav_token: &str) -> String {
    format!("{}/api/v1/calendar/public/calendars/{}/feed.ics", server_origin(), urlencode(caldav_token))
}

/// The account's server origin (no trailing slash), for building the CalDAV / feed URLs the way the web does
/// from `window.location.origin`.
pub fn server_origin() -> String {
    account().map(|a| a.server_url.trim_end_matches('/').to_string()).unwrap_or_default()
}

/// The signed-in user's username (`GET /api/v1/me`), used in the CalDAV endpoint URLs. Falls back to the email.
pub fn fetch_username() -> Result<String, String> {
    let (status, body) = request("GET", "/api/v1/me", None)?;
    if status != 200 {
        return Err(format!("GET me → HTTP {status}"));
    }
    let v: serde_json::Value = serde_json::from_slice(&body).map_err(|e| e.to_string())?;
    let u = v.get("user").unwrap_or(&v);
    Ok(u.get("username")
        .and_then(|x| x.as_str())
        .filter(|s| !s.is_empty())
        .or_else(|| u.get("email").and_then(|x| x.as_str()))
        .unwrap_or("")
        .to_string())
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

// ── Appointment schedules (bookable booking pages) ───────────────────────────────────────────────────────────
// The desktop counterpart of the web `appointmentApi` (`web/src/api.ts`) and `AppointmentScheduleEditor.tsx`.

/// One availability rule: weekly (weekday 0=Mon…6=Sun) or date-specific. Times are minutes from midnight in the
/// schedule's timezone (web `AvailabilityRule`).
#[derive(Debug, Clone, Default)]
pub struct AvailRule {
    pub weekday: Option<i32>,
    pub specific_date: Option<String>,
    pub start_minute: i32,
    pub end_minute: i32,
}

/// The editable shape of an appointment schedule (web `SaveScheduleDto`).
#[derive(Debug, Clone, Default)]
pub struct ScheduleWrite {
    pub calendar_id: String,
    pub title: String,
    pub description: Option<String>,
    pub duration_minutes: i32,
    pub buffer_minutes: Option<i32>,
    pub max_per_day: Option<i32>,
    pub timezone: String,
    pub window_type: String,
    pub window_max_days: Option<i32>,
    pub window_min_hours: Option<i32>,
    pub window_start_date: Option<String>,
    pub window_end_date: Option<String>,
    pub location_type: String,
    pub location_details: Option<String>,
    pub guests_can_invite: bool,
    pub host_name: Option<String>,
    pub email_reminders: Vec<i32>,
    pub availability: Vec<AvailRule>,
}

/// A schedule as the sidebar list needs it.
#[derive(Debug, Clone, Default)]
pub struct ScheduleSummary {
    pub id: String,
    pub title: String,
    pub duration_minutes: i32,
    pub public_token: String,
}

/// A schedule's full editable state, for seeding the editor when editing (web `appointmentApi.get`).
#[derive(Debug, Clone, Default)]
pub struct ScheduleFull {
    pub id: String,
    pub write: ScheduleWrite,
    pub public_token: String,
}

fn sched_summary(v: &serde_json::Value) -> Option<ScheduleSummary> {
    Some(ScheduleSummary {
        id: v.get("id")?.as_str()?.to_string(),
        title: v.get("title").and_then(|x| x.as_str()).unwrap_or("").to_string(),
        duration_minutes: v.get("duration_minutes").and_then(|x| x.as_i64()).unwrap_or(0) as i32,
        public_token: v.get("public_token").and_then(|x| x.as_str()).unwrap_or("").to_string(),
    })
}

/// The owner's bookable schedules (`GET /calendar/appointment-schedules`).
pub fn list_schedules() -> Result<Vec<ScheduleSummary>, String> {
    let (status, body) = request("GET", &format!("{CAL_PREFIX}/appointment-schedules"), None)?;
    if status != 200 {
        return Err(format!("GET schedules → HTTP {status}"));
    }
    let v: serde_json::Value = serde_json::from_slice(&body).map_err(|e| e.to_string())?;
    Ok(v.get("schedules").and_then(|a| a.as_array()).map(|a| a.iter().filter_map(sched_summary).collect()).unwrap_or_default())
}

/// One schedule with its availability (`GET /calendar/appointment-schedules/:id`), for the editor.
pub fn get_schedule(id: &str) -> Result<ScheduleFull, String> {
    let (status, body) = request("GET", &format!("{CAL_PREFIX}/appointment-schedules/{}", urlencode(id)), None)?;
    if status != 200 {
        return Err(format!("GET schedule → HTTP {status}"));
    }
    let v: serde_json::Value = serde_json::from_slice(&body).map_err(|e| e.to_string())?;
    let s = v.get("schedule").ok_or("no schedule in response")?;
    let str_opt = |k: &str| s.get(k).and_then(|x| x.as_str()).map(|x| x.to_string());
    let i32_opt = |k: &str| s.get(k).and_then(|x| x.as_i64()).map(|x| x as i32);
    let availability = s
        .get("availability")
        .and_then(|a| a.as_array())
        .map(|a| {
            a.iter()
                .map(|r| AvailRule {
                    weekday: r.get("weekday").and_then(|x| x.as_i64()).map(|x| x as i32),
                    specific_date: r.get("specific_date").and_then(|x| x.as_str()).map(|x| x.to_string()),
                    start_minute: r.get("start_minute").and_then(|x| x.as_i64()).unwrap_or(0) as i32,
                    end_minute: r.get("end_minute").and_then(|x| x.as_i64()).unwrap_or(0) as i32,
                })
                .collect()
        })
        .unwrap_or_default();
    let reminders = s
        .get("email_reminders")
        .and_then(|a| a.as_array())
        .map(|a| a.iter().filter_map(|x| x.as_i64().map(|n| n as i32)).collect())
        .unwrap_or_default();
    Ok(ScheduleFull {
        id: s.get("id").and_then(|x| x.as_str()).unwrap_or(id).to_string(),
        public_token: s.get("public_token").and_then(|x| x.as_str()).unwrap_or("").to_string(),
        write: ScheduleWrite {
            calendar_id: str_opt("calendar_id").unwrap_or_default(),
            title: str_opt("title").unwrap_or_default(),
            description: str_opt("description"),
            duration_minutes: i32_opt("duration_minutes").unwrap_or(60),
            buffer_minutes: i32_opt("buffer_minutes"),
            max_per_day: i32_opt("max_per_day"),
            timezone: str_opt("timezone").unwrap_or_else(|| "UTC".to_string()),
            window_type: str_opt("window_type").unwrap_or_else(|| "rolling".to_string()),
            window_max_days: i32_opt("window_max_days"),
            window_min_hours: i32_opt("window_min_hours"),
            window_start_date: str_opt("window_start_date"),
            window_end_date: str_opt("window_end_date"),
            location_type: str_opt("location_type").unwrap_or_else(|| "none".to_string()),
            location_details: str_opt("location_details"),
            guests_can_invite: s.get("guests_can_invite").and_then(|x| x.as_bool()).unwrap_or(true),
            host_name: str_opt("host_name"),
            email_reminders: reminders,
            availability,
        },
    })
}

/// Create or update an appointment schedule (`POST`/`PATCH /calendar/appointment-schedules`). Returns its id.
pub fn save_schedule(w: &ScheduleWrite, edit_id: Option<&str>) -> Result<String, String> {
    let rules: Vec<serde_json::Value> = w
        .availability
        .iter()
        .map(|r| serde_json::json!({ "weekday": r.weekday, "specific_date": r.specific_date, "start_minute": r.start_minute, "end_minute": r.end_minute }))
        .collect();
    let dto = serde_json::json!({
        "calendar_id": w.calendar_id,
        "title": w.title,
        "description": w.description,
        "duration_minutes": w.duration_minutes,
        "buffer_minutes": w.buffer_minutes,
        "max_per_day": w.max_per_day,
        "timezone": w.timezone,
        "window_type": w.window_type,
        "window_max_days": w.window_max_days,
        "window_min_hours": w.window_min_hours,
        "window_start_date": w.window_start_date,
        "window_end_date": w.window_end_date,
        "location_type": w.location_type,
        "location_details": w.location_details,
        "guests_can_invite": w.guests_can_invite,
        "host_name": w.host_name,
        "email_reminders": w.email_reminders,
        "availability": rules,
    });
    let body = serde_json::to_vec(&dto).map_err(|e| e.to_string())?;
    let (status, resp) = match edit_id {
        Some(id) => request("PATCH", &format!("{CAL_PREFIX}/appointment-schedules/{}", urlencode(id)), Some(body))?,
        None => request("POST", &format!("{CAL_PREFIX}/appointment-schedules"), Some(body))?,
    };
    if !(200..300).contains(&status) {
        return Err(format!("save schedule → HTTP {status}"));
    }
    let v: serde_json::Value = serde_json::from_slice(&resp).map_err(|e| e.to_string())?;
    Ok(v.get("schedule").and_then(|s| s.get("id")).and_then(|x| x.as_str()).unwrap_or("").to_string())
}

/// Delete an appointment schedule (`DELETE /calendar/appointment-schedules/:id`).
pub fn delete_schedule(id: &str) -> Result<(), String> {
    let (status, _) = request("DELETE", &format!("{CAL_PREFIX}/appointment-schedules/{}", urlencode(id)), None)?;
    if !(200..300).contains(&status) {
        return Err(format!("DELETE schedule → HTTP {status}"));
    }
    Ok(())
}

/// The public booking-page URL to share with invitees (web `appointmentApi.bookingPageUrl`).
pub fn booking_page_url(token: &str) -> String {
    format!("{}/api/v1/calendar/public/appointments/{}/page", server_origin(), urlencode(token))
}

// ── Weather (sidebar forecast) ───────────────────────────────────────────────────────────────────────────────
// The desktop counterpart of the web `weatherApi` (`web/src/api.ts`) + the sidebar weather section.

/// A geocoding match (web `GeocodingResult`).
#[derive(Debug, Clone, Default)]
pub struct GeoResult {
    pub name: String,
    pub latitude: f64,
    pub longitude: f64,
    pub timezone: String,
    pub country: String,
    pub admin1: Option<String>,
}

/// A saved weather location (web `WeatherLocation`).
#[derive(Debug, Clone, Default)]
pub struct WeatherLoc {
    pub id: String,
    pub name: String,
    pub latitude: f64,
    pub longitude: f64,
    pub timezone: String,
    pub is_default: bool,
}

/// Today's headline forecast for a location (the subset the sidebar shows).
#[derive(Debug, Clone, Default)]
pub struct ForecastToday {
    pub weather_code: i32,
    pub temp_max: f64,
    pub temp_min: f64,
    pub precip_prob: i32,
    pub current_temp: Option<f64>,
}

/// Search the geocoder for a place (`GET /calendar/weather/geocode?q=…`).
pub fn weather_geocode(query: &str, lang: &str) -> Result<Vec<GeoResult>, String> {
    let (status, body) = request("GET", &format!("{CAL_PREFIX}/weather/geocode?lang={}&q={}", urlencode(lang), urlencode(query)), None)?;
    if status != 200 {
        return Err(format!("GET geocode → HTTP {status}"));
    }
    let v: serde_json::Value = serde_json::from_slice(&body).map_err(|e| e.to_string())?;
    let arr = v.get("results").and_then(|a| a.as_array()).cloned().unwrap_or_default();
    Ok(arr
        .iter()
        .filter_map(|r| {
            Some(GeoResult {
                name: r.get("name")?.as_str()?.to_string(),
                latitude: r.get("latitude")?.as_f64()?,
                longitude: r.get("longitude")?.as_f64()?,
                timezone: r.get("timezone").and_then(|x| x.as_str()).unwrap_or("UTC").to_string(),
                country: r.get("country").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                admin1: r.get("admin1").and_then(|x| x.as_str()).map(|s| s.to_string()),
            })
        })
        .collect())
}

/// Save a weather location (`POST /calendar/weather/locations`). Returns its id.
pub fn weather_add_location(name: &str, latitude: f64, longitude: f64, timezone: &str) -> Result<String, String> {
    let dto = serde_json::json!({ "name": name, "latitude": latitude, "longitude": longitude, "timezone": timezone });
    let (status, body) = request("POST", &format!("{CAL_PREFIX}/weather/locations"), Some(serde_json::to_vec(&dto).map_err(|e| e.to_string())?))?;
    if !(200..300).contains(&status) {
        return Err(format!("POST location → HTTP {status}"));
    }
    let v: serde_json::Value = serde_json::from_slice(&body).map_err(|e| e.to_string())?;
    Ok(v.get("location").and_then(|l| l.get("id")).and_then(|x| x.as_str()).unwrap_or("").to_string())
}

/// The user's saved weather locations (`GET /calendar/weather/locations`).
pub fn weather_locations() -> Result<Vec<WeatherLoc>, String> {
    let (status, body) = request("GET", &format!("{CAL_PREFIX}/weather/locations"), None)?;
    if status != 200 {
        return Err(format!("GET locations → HTTP {status}"));
    }
    let v: serde_json::Value = serde_json::from_slice(&body).map_err(|e| e.to_string())?;
    let arr = v.get("locations").and_then(|a| a.as_array()).cloned().unwrap_or_default();
    Ok(arr
        .iter()
        .filter_map(|l| {
            Some(WeatherLoc {
                id: l.get("id")?.as_str()?.to_string(),
                name: l.get("name").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                latitude: l.get("latitude").and_then(|x| x.as_f64()).unwrap_or(0.0),
                longitude: l.get("longitude").and_then(|x| x.as_f64()).unwrap_or(0.0),
                timezone: l.get("timezone").and_then(|x| x.as_str()).unwrap_or("UTC").to_string(),
                is_default: l.get("is_default").and_then(|x| x.as_bool()).unwrap_or(false),
            })
        })
        .collect())
}

/// Delete a weather location (`DELETE /calendar/weather/locations/:id`).
pub fn weather_delete_location(id: &str) -> Result<(), String> {
    let (status, _) = request("DELETE", &format!("{CAL_PREFIX}/weather/locations/{}", urlencode(id)), None)?;
    if !(200..300).contains(&status) {
        return Err(format!("DELETE location → HTTP {status}"));
    }
    Ok(())
}

// ── Module settings (per-user preferences) ──────────────────────────────────────────────────────────────────
// The desktop counterpart of the web `CalendarSettingsPage` / `ModuleSettingsForm` / `calendarSettings.ts`.

/// The module's resolved settings as `key → effective value` (`GET /modules/calendar/config`). The `effective`
/// value is the user override ?? instance default ?? factory default.
pub fn fetch_calendar_settings() -> Result<std::collections::HashMap<String, SettingValue>, String> {
    let (status, body) = request("GET", "/api/v1/modules/calendar/config", None)?;
    if status != 200 {
        return Err(format!("GET config → HTTP {status}"));
    }
    let v: serde_json::Value = serde_json::from_slice(&body).map_err(|e| e.to_string())?;
    let arr = v.get("settings").and_then(|a| a.as_array()).cloned().unwrap_or_default();
    Ok(arr
        .iter()
        .filter_map(|s| {
            let key = s.get("key")?.as_str()?.to_string();
            let eff = s.get("effective")?;
            let val = if let Some(b) = eff.as_bool() {
                SettingValue::Bool(b)
            } else if let Some(n) = eff.as_i64() {
                SettingValue::Int(n)
            } else {
                SettingValue::Str(eff.as_str().unwrap_or("").to_string())
            };
            Some((key, val))
        })
        .collect())
}

/// A setting value to persist, so callers need not depend on `serde_json`.
#[derive(Debug, Clone)]
pub enum SettingValue {
    Str(String),
    Int(i64),
    Bool(bool),
}

impl SettingValue {
    fn to_json(&self) -> serde_json::Value {
        match self {
            SettingValue::Str(s) => serde_json::Value::from(s.clone()),
            SettingValue::Int(n) => serde_json::Value::from(*n),
            SettingValue::Bool(b) => serde_json::Value::from(*b),
        }
    }

    /// The value as the string a dropdown binds to (numbers are rendered decimal).
    pub fn as_string(&self) -> String {
        match self {
            SettingValue::Str(s) => s.clone(),
            SettingValue::Int(n) => n.to_string(),
            SettingValue::Bool(b) => b.to_string(),
        }
    }

    /// The value as a bool (false unless it is a `Bool`).
    pub fn as_bool(&self) -> bool {
        matches!(self, SettingValue::Bool(true))
    }
}

/// Persist changed settings as user preferences (`PATCH /me { preferences: { calendar: { … } } }`). The whole
/// module bag is re-sent merged with the current one, since the server merges `preferences` only at the root.
pub fn save_calendar_settings(changes: &[(String, SettingValue)]) -> Result<(), String> {
    // Read the current calendar preferences so we merge rather than drop sibling keys.
    let (status, body) = request("GET", "/api/v1/me", None)?;
    if status != 200 {
        return Err(format!("GET me → HTTP {status}"));
    }
    let me: serde_json::Value = serde_json::from_slice(&body).map_err(|e| e.to_string())?;
    let mut cal = me
        .get("user")
        .and_then(|u| u.get("preferences"))
        .and_then(|p| p.get("calendar"))
        .and_then(|c| c.as_object())
        .cloned()
        .unwrap_or_default();
    for (k, v) in changes {
        cal.insert(k.clone(), v.to_json());
    }
    let dto = serde_json::json!({ "preferences": { "calendar": serde_json::Value::Object(cal) } });
    let (status, _) = request("PATCH", "/api/v1/me", Some(serde_json::to_vec(&dto).map_err(|e| e.to_string())?))?;
    if !(200..300).contains(&status) {
        return Err(format!("PATCH me → HTTP {status}"));
    }
    Ok(())
}

/// Today's forecast for a location (`GET /calendar/weather/forecast?lat&lon&tz`).
pub fn weather_forecast_today(latitude: f64, longitude: f64, timezone: &str) -> Result<ForecastToday, String> {
    let (status, body) = request("GET", &format!("{CAL_PREFIX}/weather/forecast?lat={latitude}&lon={longitude}&tz={}", urlencode(timezone)), None)?;
    if status != 200 {
        return Err(format!("GET forecast → HTTP {status}"));
    }
    let v: serde_json::Value = serde_json::from_slice(&body).map_err(|e| e.to_string())?;
    let f = v.get("forecast").ok_or("no forecast")?;
    let day = f.get("days").and_then(|d| d.as_array()).and_then(|d| d.first()).ok_or("no days")?;
    Ok(ForecastToday {
        weather_code: day.get("weather_code").and_then(|x| x.as_i64()).unwrap_or(0) as i32,
        temp_max: day.get("temp_max").and_then(|x| x.as_f64()).unwrap_or(0.0),
        temp_min: day.get("temp_min").and_then(|x| x.as_f64()).unwrap_or(0.0),
        precip_prob: day.get("precip_prob_max").and_then(|x| x.as_i64()).unwrap_or(0) as i32,
        current_temp: f.get("current").and_then(|c| c.get("temp")).and_then(|x| x.as_f64()),
    })
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
