//! The reminder check behind the desktop notification worker (web `CalendarNotificationWorker.tsx`): given the
//! upcoming events, which reminders fall due right now. Pure and testable; the platform layer polls this every
//! minute and raises a native notification for each new due reminder.

use kubuno_calendar_core::model::{EventInstance, Instant};

/// A reminder that is due now.
#[derive(Debug, Clone, PartialEq)]
pub struct DueReminder {
    /// A stable key (`<event_id>-<minutes_before>`) for de-duplication across polls.
    pub key: String,
    /// The event title - the notification headline.
    pub title: String,
    /// Minutes before the event this reminder fires.
    pub minutes_before: i64,
    /// The event's start timestamp (ISO), for the notification body.
    pub starts_at: String,
    pub all_day: bool,
}

/// The reminders due within `window_secs` of `now_epoch` (seconds), like the web worker's ±1-minute window.
///
/// `notify_only_if_accepted` skips events the user was invited to but has not accepted (own events, which carry
/// no RSVP, always notify - their `my_status` is `None`).
pub fn due_reminders(events: &[EventInstance], now_epoch: i64, window_secs: i64, notify_only_if_accepted: bool) -> Vec<DueReminder> {
    let mut out = Vec::new();
    for ev in events {
        if notify_only_if_accepted {
            if let Some(st) = ev.my_status.as_deref() {
                if st != "accepted" && st != "tentative" {
                    continue;
                }
            }
        }
        let Some(start) = Instant::parse(&ev.starts_at) else {
            continue;
        };
        for r in &ev.reminders {
            let fires = start.epoch_seconds - r.minutes_before * 60;
            if (fires - now_epoch).abs() <= window_secs {
                out.push(DueReminder {
                    key: format!("{}-{}", ev.event_id, r.minutes_before),
                    title: ev.title.clone(),
                    minutes_before: r.minutes_before,
                    starts_at: ev.starts_at.clone(),
                    all_day: ev.all_day,
                });
            }
        }
    }
    out
}

/// The notification body for a due reminder, in French or English (web `notif_timed_body` / `notif_all_day_body`).
pub fn reminder_body(due: &DueReminder, offset_minutes: i32, fr: bool) -> String {
    let start = Instant::parse(&due.starts_at).unwrap_or_default();
    if due.all_day {
        if fr {
            "Toute la journée aujourd'hui".to_string()
        } else {
            "All day today".to_string()
        }
    } else {
        let lt = start.local(offset_minutes);
        let time = format!("{:02}:{:02}", lt.hour, lt.minute);
        let label = reminder_label(due.minutes_before, fr);
        if fr {
            format!("À {time} · {label}")
        } else {
            format!("At {time} · {label}")
        }
    }
}

fn reminder_label(minutes: i64, fr: bool) -> String {
    match (minutes, fr) {
        (0, true) => "maintenant".into(),
        (0, false) => "now".into(),
        (60, true) => "dans 1 heure".into(),
        (60, false) => "in 1 hour".into(),
        (1440, true) => "dans 1 jour".into(),
        (1440, false) => "in 1 day".into(),
        (m, true) => format!("dans {m} min"),
        (m, false) => format!("in {m} min"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(event_id: &str, starts_at: &str, reminders: Vec<i64>, my_status: Option<&str>) -> EventInstance {
        let mut e = EventInstance {
            id: event_id.into(),
            event_id: event_id.into(),
            calendar_id: "c".into(),
            owner_id: "o".into(),
            title: format!("Event {event_id}"),
            starts_at: starts_at.into(),
            ends_at: starts_at.into(),
            all_day: false,
            is_recurring: false,
            status: "confirmed".into(),
            visibility: "default".into(),
            ical_uid: "u".into(),
            etag: "e".into(),
            my_status: my_status.map(|s| s.to_string()),
            ..Default::default()
        };
        e.reminders = reminders
            .into_iter()
            .map(|m| kubuno_calendar_core::model::EventReminder { kind: "popup".into(), minutes_before: m })
            .collect();
        e
    }

    // 2026-01-01T10:00:00Z = 1767261600 epoch seconds.
    const START: i64 = 1_767_261_600;

    #[test]
    fn fires_within_the_window() {
        let events = [ev("a", "2026-01-01T10:00:00Z", vec![10], None)];
        // 10 minutes before the event = START - 600. Right at that instant it is due.
        let due = due_reminders(&events, START - 600, 60, false);
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].key, "a-10");
    }

    #[test]
    fn does_not_fire_outside_the_window() {
        let events = [ev("a", "2026-01-01T10:00:00Z", vec![10], None)];
        // Two minutes past the reminder time is outside the ±60s window.
        assert!(due_reminders(&events, START - 600 + 120, 60, false).is_empty());
    }

    #[test]
    fn respects_notify_only_if_accepted() {
        let declined = [ev("a", "2026-01-01T10:00:00Z", vec![10], Some("declined"))];
        assert!(due_reminders(&declined, START - 600, 60, true).is_empty());
        let accepted = [ev("a", "2026-01-01T10:00:00Z", vec![10], Some("accepted"))];
        assert_eq!(due_reminders(&accepted, START - 600, 60, true).len(), 1);
        // An own event (no RSVP) always notifies.
        let own = [ev("a", "2026-01-01T10:00:00Z", vec![10], None)];
        assert_eq!(due_reminders(&own, START - 600, 60, true).len(), 1);
    }
}
