//! An offline sample dataset, so the app (and the captures/tests) can render a full month without a server.
//! The events sit in October 2026 and exercise the month grid: single timed events, overlapping events, a
//! one-day all-day event and a multi-day banner that crosses a week boundary.

use std::collections::BTreeMap;

use kubuno_calendar_core::model::{Calendar, EventInstance};

/// Two sample calendars (`cal_type = personal`).
pub fn calendars() -> Vec<Calendar> {
    let mk = |id: &str, name: &str, color: &str, default: bool| Calendar {
        id: id.into(),
        owner_id: "me".into(),
        name: name.into(),
        description: None,
        color: color.into(),
        cal_type: "personal".into(),
        is_default: default,
        is_visible: true,
        is_public: false,
        timezone: "Europe/Paris".into(),
        caldav_token: String::new(),
        subscription_url: None,
        last_synced_at: None,
        created_at: String::new(),
        updated_at: String::new(),
        my_permission: Some("owner".into()),
        extra: BTreeMap::new(),
    };
    vec![
        mk("work", "Work", "#1a73e8", true),
        mk("perso", "Personal", "#0b8043", false),
    ]
}

fn event(id: &str, cal: &str, title: &str, start: &str, end: &str, all_day: bool, color: &str) -> EventInstance {
    EventInstance {
        id: id.into(),
        event_id: id.into(),
        calendar_id: cal.into(),
        owner_id: "me".into(),
        title: title.into(),
        description: None,
        location: None,
        url: None,
        starts_at: start.into(),
        ends_at: end.into(),
        all_day,
        is_recurring: false,
        rrule: None,
        status: "confirmed".into(),
        visibility: "public".into(),
        busy: Some(true),
        timezone: None,
        ical_uid: id.into(),
        etag: String::new(),
        color: Some(color.into()),
        reminders: vec![],
        my_status: None,
        guests_can_modify: None,
        guests_can_invite: None,
        guests_can_see_guests: None,
        extra: BTreeMap::new(),
    }
}

/// The sample events for October 2026 (UTC instants, as the server stores them).
pub fn events() -> Vec<EventInstance> {
    vec![
        // A week of standups (one timed chip a day, Mon–Fri of the 12th–16th).
        event("e1", "work", "Standup", "2026-10-12T07:00:00Z", "2026-10-12T07:15:00Z", false, "#1a73e8"),
        event("e2", "work", "Standup", "2026-10-13T07:00:00Z", "2026-10-13T07:15:00Z", false, "#1a73e8"),
        event("e3", "work", "Standup", "2026-10-14T07:00:00Z", "2026-10-14T07:15:00Z", false, "#1a73e8"),
        // Two overlapping meetings on the same day (so a day shows several chips + « +N »).
        event("e4", "work", "Design review", "2026-10-14T13:00:00Z", "2026-10-14T14:00:00Z", false, "#9334e6"),
        event("e5", "work", "1:1 with Sam", "2026-10-14T13:30:00Z", "2026-10-14T14:30:00Z", false, "#e8710a"),
        event("e6", "perso", "Dentist", "2026-10-14T15:00:00Z", "2026-10-14T15:45:00Z", false, "#0b8043"),
        event("e7", "perso", "Pick up kids", "2026-10-14T16:00:00Z", "2026-10-14T16:30:00Z", false, "#d93025"),
        // A one-day all-day event.
        event("e8", "perso", "Birthday", "2026-10-09T00:00:00Z", "2026-10-09T23:59:59Z", true, "#f09300"),
        // A multi-day banner that crosses the week boundary (Thu 15th → Mon 19th).
        event("e9", "work", "Conference", "2026-10-15T00:00:00Z", "2026-10-19T23:59:59Z", true, "#4D38DB"),
        // A late-month timed event.
        event("e10", "work", "Sprint demo", "2026-10-28T14:00:00Z", "2026-10-28T15:00:00Z", false, "#1a73e8"),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sample_is_well_formed() {
        assert_eq!(calendars().len(), 2);
        let evs = events();
        assert!(evs.iter().any(|e| e.all_day));
        assert!(evs.iter().filter(|e| !e.all_day).count() >= 5);
    }
}
