//! The calendar data model shared with the web client (`web/src/api.ts`) and the local wall-clock conversion
//! of a stored instant.
//!
//! The server returns `EventInstance`s already expanded over the requested window (web `listEvents` → GET
//! `/calendar/events`), so this is the shape the desktop app loads too. Unknown fields are preserved in `extra`
//! for a lossless round trip, as the Office cores do.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

use crate::date::Date;

/// A reminder attached to an event (`EventReminder`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EventReminder {
    #[serde(rename = "type")]
    pub kind: String,
    pub minutes_before: i64,
}

/// One occurrence of an event, as the server returns it (`EventInstance`, `api.ts:66`). A recurring series is
/// returned as one `EventInstance` per occurrence in the window; `rrule`/`is_recurring` describe the series it
/// belongs to but the client does not expand them.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct EventInstance {
    pub id: String,
    pub event_id: String,
    pub calendar_id: String,
    pub owner_id: String,
    pub title: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub location: Option<String>,
    #[serde(default)]
    pub url: Option<String>,
    pub starts_at: String,
    pub ends_at: String,
    pub all_day: bool,
    pub is_recurring: bool,
    #[serde(default)]
    pub rrule: Option<String>,
    pub status: String,
    pub visibility: String,
    #[serde(default)]
    pub busy: Option<bool>,
    #[serde(default)]
    pub timezone: Option<String>,
    pub ical_uid: String,
    pub etag: String,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub reminders: Vec<EventReminder>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub my_status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub guests_can_modify: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub guests_can_invite: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub guests_can_see_guests: Option<bool>,
    /// Any field the server adds that this model does not name yet - kept for a lossless round trip.
    #[serde(flatten)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

/// A calendar the user owns, is shared, or subscribes to (`Calendar`, `api.ts:4`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Calendar {
    pub id: String,
    pub owner_id: String,
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    pub color: String,
    pub cal_type: String,
    pub is_default: bool,
    pub is_visible: bool,
    pub is_public: bool,
    pub timezone: String,
    #[serde(default)]
    pub caldav_token: String,
    #[serde(default)]
    pub subscription_url: Option<String>,
    #[serde(default)]
    pub last_synced_at: Option<String>,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub updated_at: String,
    #[serde(default)]
    pub my_permission: Option<String>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

impl Calendar {
    /// Can the user create events here? Own calendar or shared with write, and not a subscription mirror
    /// (`calendarUtils.writableCalendars`).
    pub fn is_writable(&self) -> bool {
        matches!(self.my_permission.as_deref(), None | Some("owner") | Some("write"))
            && self.subscription_url.is_none()
    }

    /// Locked for editing: read-only share or a subscription (`calendarUtils.isCalendarLocked`).
    pub fn is_locked(&self) -> bool {
        self.my_permission.as_deref() == Some("read") || self.subscription_url.is_some()
    }
}

/// A wall-clock date and time in some local zone (no zone attached) - the result of reading a stored instant
/// in the viewer's zone, the way the web does with `Date.getHours()` etc.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct LocalDateTime {
    pub date: Date,
    /// 0–23.
    pub hour: u32,
    /// 0–59.
    pub minute: u32,
    /// 0–59.
    pub second: u32,
}

impl LocalDateTime {
    /// Minutes since local midnight (`getHours()*60 + getMinutes()`).
    pub fn minute_of_day(self) -> u32 {
        self.hour * 60 + self.minute
    }

    /// True local midnight (`getHours/Minutes/Seconds === 0`).
    pub fn is_midnight(self) -> bool {
        self.hour == 0 && self.minute == 0 && self.second == 0
    }
}

/// A UTC instant, in whole seconds since the Unix epoch - what an ISO 8601 timestamp denotes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Default)]
pub struct Instant {
    pub epoch_seconds: i64,
}

impl Instant {
    /// Parse an ISO 8601 timestamp the way `new Date(iso)` does for the shapes the server emits:
    /// `YYYY-MM-DDTHH:MM:SS` with an optional fractional second and an optional zone (`Z` or `±HH:MM`).
    /// A timestamp with no zone is read as UTC (the server always stores UTC with `Z`).
    pub fn parse(iso: &str) -> Option<Self> {
        let s = iso.trim();
        let bytes = s.as_bytes();
        if bytes.len() < 10 {
            return None;
        }
        let date = Date::parse(&s[..10])?;
        // No time part: midnight UTC.
        if s.len() == 10 {
            return Some(Instant { epoch_seconds: date.to_days() * 86_400 });
        }
        // Separator 'T' or ' '.
        let sep = bytes[10];
        if sep != b'T' && sep != b't' && sep != b' ' {
            return None;
        }
        let rest = &s[11..];
        // Split off the zone designator.
        let (time_part, offset_seconds) = split_zone(rest)?;
        let mut it = time_part.split(':');
        let hour: i64 = it.next()?.parse().ok()?;
        let minute: i64 = it.next().map(|m| m.parse().ok()).unwrap_or(Some(0))?;
        let sec_field = it.next().unwrap_or("0");
        // Drop a fractional part on the seconds.
        let whole_sec: i64 = sec_field.split('.').next()?.parse().ok()?;
        if it.next().is_some() {
            return None;
        }
        let day_seconds = hour * 3_600 + minute * 60 + whole_sec;
        Some(Instant { epoch_seconds: date.to_days() * 86_400 + day_seconds - offset_seconds })
    }

    /// Read this instant as a wall-clock time in a zone `offset_minutes` east of UTC (e.g. `+120` for GMT+2).
    pub fn local(self, offset_minutes: i32) -> LocalDateTime {
        let total = self.epoch_seconds + offset_minutes as i64 * 60;
        let days = total.div_euclid(86_400);
        let rem = total.rem_euclid(86_400);
        LocalDateTime {
            date: Date::from_days(days),
            hour: (rem / 3_600) as u32,
            minute: ((rem % 3_600) / 60) as u32,
            second: (rem % 60) as u32,
        }
    }

    /// The UTC calendar date of this instant (`getUTCFullYear/Month/Date`), used for all-day events, which the
    /// web stores as `<date>T00:00:00Z … T23:59:59Z` and reads back offset-independently.
    pub fn utc_date(self) -> Date {
        Date::from_days(self.epoch_seconds.div_euclid(86_400))
    }

    /// Build the instant for a wall-clock `date` + time in a zone `offset_minutes` east of UTC (what the event
    /// editor collects locally before sending the server a UTC timestamp).
    pub fn from_local(date: Date, hour: u32, minute: u32, second: u32, offset_minutes: i32) -> Instant {
        let local = date.to_days() * 86_400 + (hour as i64 * 3_600 + minute as i64 * 60 + second as i64);
        Instant { epoch_seconds: local - offset_minutes as i64 * 60 }
    }

    /// `YYYY-MM-DDTHH:MM:SSZ` - the UTC ISO 8601 form the server stores.
    pub fn iso_utc(self) -> String {
        let d = Date::from_days(self.epoch_seconds.div_euclid(86_400));
        let rem = self.epoch_seconds.rem_euclid(86_400);
        format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z", d.year, d.month, d.day, rem / 3_600, (rem % 3_600) / 60, rem % 60)
    }
}

/// Separate a time-of-day string from its trailing zone, returning the bare `HH:MM[:SS]` and the zone's offset
/// east of UTC in seconds. No zone = UTC (0).
fn split_zone(rest: &str) -> Option<(&str, i64)> {
    if let Some(stripped) = rest.strip_suffix(['Z', 'z']) {
        return Some((stripped, 0));
    }
    // Look for a '+' or a '-' that is not inside the time (i.e. after the first two digits).
    let bytes = rest.as_bytes();
    for (i, &b) in bytes.iter().enumerate().skip(1) {
        if b == b'+' || b == b'-' {
            let zone = &rest[i..];
            let sign = if b == b'+' { 1 } else { -1 };
            let z = &zone[1..];
            let mut zi = z.split(':');
            let zh: i64 = zi.next()?.parse().ok()?;
            let zm: i64 = zi.next().map(|m| m.parse().ok()).unwrap_or(Some(0))?;
            return Some((&rest[..i], sign * (zh * 3_600 + zm * 60)));
        }
    }
    Some((rest, 0))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_utc_instant() {
        let i = Instant::parse("2026-10-12T14:30:00Z").expect("instant");
        // 14:30 UTC read at GMT+2 → 16:30 local on the same day.
        let l = i.local(120);
        assert_eq!(l.date, Date::new(2026, 10, 12).expect("d"));
        assert_eq!(l.hour, 16);
        assert_eq!(l.minute, 30);
        assert_eq!(l.minute_of_day(), 16 * 60 + 30);
    }

    #[test]
    fn local_day_shift_west_of_utc() {
        // Midnight UTC read at GMT-5 is the previous evening.
        let i = Instant::parse("2026-10-12T00:00:00Z").expect("i");
        let l = i.local(-300);
        assert_eq!(l.date, Date::new(2026, 10, 11).expect("d"));
        assert_eq!(l.hour, 19);
    }

    #[test]
    fn all_day_utc_date_is_offset_independent() {
        let end = Instant::parse("2026-10-12T23:59:59Z").expect("i");
        assert_eq!(end.utc_date(), Date::new(2026, 10, 12).expect("d"));
        let start = Instant::parse("2026-10-12T00:00:00Z").expect("i");
        assert_eq!(start.utc_date(), Date::new(2026, 10, 12).expect("d"));
    }

    #[test]
    fn local_round_trip_to_utc_iso() {
        // 10:00 local at GMT+2 → 08:00:00Z on the same day.
        let i = Instant::from_local(Date::new(2026, 10, 15).expect("d"), 10, 0, 0, 120);
        assert_eq!(i.iso_utc(), "2026-10-15T08:00:00Z");
        // Parsing it back and reading it local gives 10:00 again.
        assert_eq!(Instant::parse(&i.iso_utc()).expect("i").local(120).minute_of_day(), 10 * 60);
    }

    #[test]
    fn parses_offset_zone() {
        let i = Instant::parse("2026-10-12T14:30:00+02:00").expect("i");
        // +02:00 means local 14:30 is 12:30 UTC.
        assert_eq!(i, Instant::parse("2026-10-12T12:30:00Z").expect("i"));
    }

    #[test]
    fn event_round_trips_with_unknown_fields() {
        let json = r##"{
            "id":"i1","event_id":"e1","calendar_id":"c1","owner_id":"u1","title":"Standup",
            "description":null,"location":null,"url":null,
            "starts_at":"2026-10-12T09:00:00Z","ends_at":"2026-10-12T09:30:00Z",
            "all_day":false,"is_recurring":true,"rrule":"FREQ=DAILY","status":"confirmed",
            "visibility":"public","busy":true,"ical_uid":"uid-1","etag":"W/1",
            "color":"#1a73e8","reminders":[{"type":"popup","minutes_before":10}],
            "server_only_field":42
        }"##;
        let ev: EventInstance = serde_json::from_str(json).expect("parse");
        assert_eq!(ev.title, "Standup");
        assert_eq!(ev.reminders.len(), 1);
        assert_eq!(ev.extra.get("server_only_field").and_then(|v| v.as_i64()), Some(42));
        // The unknown field survives serialization.
        let back = serde_json::to_string(&ev).expect("ser");
        assert!(back.contains("server_only_field"));
    }

    #[test]
    fn calendar_permissions() {
        let mut c = Calendar {
            id: "c".into(), owner_id: "u".into(), name: "Perso".into(), description: None,
            color: "#1a73e8".into(), cal_type: "personal".into(), is_default: true, is_visible: true,
            is_public: false, timezone: "Europe/Paris".into(), caldav_token: String::new(),
            subscription_url: None, last_synced_at: None, created_at: String::new(),
            updated_at: String::new(), my_permission: None, extra: BTreeMap::new(),
        };
        assert!(c.is_writable() && !c.is_locked());
        c.my_permission = Some("read".into());
        assert!(!c.is_writable() && c.is_locked());
        c.my_permission = Some("write".into());
        c.subscription_url = Some("https://x/feed.ics".into());
        assert!(!c.is_writable() && c.is_locked());
    }
}
