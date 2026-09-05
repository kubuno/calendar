use chrono::{Duration, TimeZone, Utc};
use icalendar::{Calendar as ICalCalendar, CalendarDateTime, Component, DatePerhapsTime, Event as ICalEvent, EventLike};

use crate::{
    errors::{CalendarError, Result},
    models::event::Event,
};

pub struct ICalendarService;

impl ICalendarService {
    /// Convert a Kubuno event into an iCalendar (.ics) string.
    pub fn event_to_ics(event: &Event, calendar_name: &str) -> String {
        let mut cal = ICalCalendar::new();
        cal.name(calendar_name);

        let mut ical_event = ICalEvent::new();
        ical_event.uid(&event.ical_uid);
        ical_event.summary(&event.title);
        ical_event.starts(event.starts_at);
        ical_event.ends(event.ends_at);
        ical_event.timestamp(Utc::now());

        if let Some(ref desc) = event.description {
            ical_event.description(desc);
        }
        if let Some(ref loc) = event.location {
            ical_event.location(loc);
        }

        // RRULE
        if let Some(ref rrule) = event.rrule {
            let rule = if rrule.starts_with("RRULE:") {
                rrule.clone()
            } else {
                format!("RRULE:{}", rrule)
            };
            ical_event.add_property("RRULE", rule.trim_start_matches("RRULE:"));
        }

        // STATUS
        let status_str = match event.status.as_str() {
            "confirmed"  => "CONFIRMED",
            "tentative"  => "TENTATIVE",
            "cancelled"  => "CANCELLED",
            _            => "CONFIRMED",
        };
        ical_event.add_property("STATUS", status_str);

        // SEQUENCE
        ical_event.add_property("SEQUENCE", event.sequence.to_string());

        cal.push(ical_event.done());
        cal.to_string()
    }

    /// Build an iTIP `VCALENDAR` (`METHOD:REQUEST` or `METHOD:CANCEL`) for a
    /// meeting invitation, carrying the organizer and the guest list.
    ///
    /// This is deliberately **not** [`Self::event_to_ics`]: that one feeds the
    /// public free/busy feed and CalDAV and must never disclose who is invited,
    /// whereas this one exists precisely to carry the `ORGANIZER`/`ATTENDEE`
    /// lines the Mail module turns into an invitation. It is written by hand
    /// rather than through the `icalendar` builder so the exact iTIP shape the
    /// Mail module parses is guaranteed (folding, escaping, `METHOD`, `PARTSTAT`).
    ///
    /// `attendees` is the guest list as `(email, display_name)`; the organizer is
    /// never repeated there.
    pub fn event_to_itip(
        event: &Event,
        organizer_email: &str,
        organizer_name: Option<&str>,
        attendees: &[(String, Option<String>)],
        method: ItipMethod,
    ) -> String {
        let method_str = match method {
            ItipMethod::Request => "REQUEST",
            ItipMethod::Cancel  => "CANCEL",
        };

        let mut lines: Vec<String> = Vec::new();
        lines.push("BEGIN:VCALENDAR".into());
        lines.push("PRODID:-//Kubuno//Calendar//EN".into());
        lines.push("VERSION:2.0".into());
        lines.push("CALSCALE:GREGORIAN".into());
        lines.push(format!("METHOD:{method_str}"));
        lines.push("BEGIN:VEVENT".into());
        lines.push(format!("UID:{}", escape_text(&event.ical_uid)));
        lines.push(format!("DTSTAMP:{}", format_utc_stamp(Utc::now())));
        lines.push(format!("SEQUENCE:{}", event.sequence));

        if event.all_day {
            lines.push(format!("DTSTART;VALUE=DATE:{}", format_date(event.starts_at)));
            // For an all-day event iCalendar's DTEND is the exclusive end date;
            // Kubuno stores an inclusive-ish instant, so emit the day after the
            // last covered day.
            lines.push(format!("DTEND;VALUE=DATE:{}", format_date(event.ends_at)));
        } else {
            lines.push(format!("DTSTART:{}", format_utc_stamp(event.starts_at)));
            lines.push(format!("DTEND:{}", format_utc_stamp(event.ends_at)));
        }

        lines.push(format!("SUMMARY:{}", escape_text(&event.title)));
        if let Some(ref loc) = event.location {
            lines.push(format!("LOCATION:{}", escape_text(loc)));
        }
        if let Some(ref desc) = event.description {
            lines.push(format!("DESCRIPTION:{}", escape_text(desc)));
        }

        // ORGANIZER
        match organizer_name.map(str::trim).filter(|n| !n.is_empty()) {
            Some(name) => lines.push(format!(
                "ORGANIZER;CN={}:mailto:{}",
                escape_param(name),
                escape_text(organizer_email)
            )),
            None => lines.push(format!("ORGANIZER:mailto:{}", escape_text(organizer_email))),
        }

        // ATTENDEE, one per guest.
        for (email, name) in attendees {
            let cn = match name.as_deref().map(str::trim).filter(|n| !n.is_empty()) {
                Some(n) => format!(";CN={}", escape_param(n)),
                None    => String::new(),
            };
            lines.push(format!(
                "ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE{cn}:mailto:{}",
                escape_text(email)
            ));
        }

        if matches!(method, ItipMethod::Cancel) {
            lines.push("STATUS:CANCELLED".into());
        }

        lines.push("END:VEVENT".into());
        lines.push("END:VCALENDAR".into());

        // Fold each logical line and join with CRLF, as RFC 5545 requires.
        let mut out = String::new();
        for line in lines {
            out.push_str(&fold_line(&line));
            out.push_str("\r\n");
        }
        out
    }

    /// Convert a whole calendar (list of events) into .ics.
    pub fn calendar_to_ics(events: &[Event], calendar_name: &str) -> String {
        let mut cal = ICalCalendar::new();
        cal.name(calendar_name);

        for event in events {
            let mut ical_event = ICalEvent::new();
            ical_event.uid(&event.ical_uid);
            ical_event.summary(&event.title);
            ical_event.starts(event.starts_at);
            ical_event.ends(event.ends_at);
            ical_event.timestamp(Utc::now());

            if let Some(ref desc) = event.description {
                ical_event.description(desc);
            }
            if let Some(ref loc) = event.location {
                ical_event.location(loc);
            }
            if let Some(ref rrule) = event.rrule {
                ical_event.add_property("RRULE", rrule.trim_start_matches("RRULE:"));
            }
            ical_event.add_property("SEQUENCE", event.sequence.to_string());

            cal.push(ical_event.done());
        }

        cal.to_string()
    }

    /// Same calendar, stripped down to when the owner is busy.
    ///
    /// Used by the public feed when the administration limited what a published
    /// calendar discloses: the times still leave the instance — that is the whole
    /// point of a free/busy feed — but the title, the description, the location
    /// and the URL never do. Entries the owner marked as free (`busy = false`)
    /// are left out entirely: they say nothing about availability and would only
    /// disclose that *something* happens then.
    pub fn calendar_to_busy_ics(events: &[Event], calendar_name: &str) -> String {
        let mut cal = ICalCalendar::new();
        cal.name(calendar_name);

        for event in events.iter().filter(|e| e.busy) {
            let mut ical_event = ICalEvent::new();
            ical_event.uid(&event.ical_uid);
            ical_event.summary("Occupé");
            ical_event.starts(event.starts_at);
            ical_event.ends(event.ends_at);
            ical_event.timestamp(Utc::now());
            // A recurring series still has to repeat, or the feed would show one
            // busy slot where there are fifty.
            if let Some(ref rrule) = event.rrule {
                ical_event.add_property("RRULE", rrule.trim_start_matches("RRULE:"));
            }
            ical_event.add_property("SEQUENCE", event.sequence.to_string());
            ical_event.add_property("CLASS", "PRIVATE");
            ical_event.add_property("TRANSP", "OPAQUE");

            cal.push(ical_event.done());
        }

        cal.to_string()
    }

    /// Parse an iCalendar feed and return the extracted events.
    /// Retourne des tuples (ical_uid, summary, dtstart, dtend, description, location, rrule).
    pub fn parse_ics(ics_content: &str) -> Result<Vec<ParsedIcsEvent>> {
        let calendar: ICalCalendar = ics_content
            .parse()
            .map_err(|e: String| CalendarError::Validation(format!("ICS invalide: {}", e)))?;

        let mut events = Vec::new();

        for component in calendar.components {
            if let icalendar::CalendarComponent::Event(e) = component {
                let uid     = e.get_uid().unwrap_or("").to_string();
                let summary = e.get_summary().unwrap_or("Sans titre").to_string();

                let dtstart = e.get_start().and_then(date_perhaps_time_to_utc);
                let dtend   = e.get_end().and_then(date_perhaps_time_to_utc);

                // DTSTART is mandatory; events without a start are skipped.
                let (starts_at, all_day) = match dtstart {
                    Some(s) => s,
                    None => continue,
                };

                // DTEND is optional in iCalendar. When absent, fall back to a
                // sensible default: +1 day for all-day events, +1 hour otherwise.
                let ends_at = match dtend {
                    Some((end, _)) => end,
                    None if all_day => starts_at + Duration::days(1),
                    None => starts_at + Duration::hours(1),
                };

                let description = e.get_description().map(|s| s.to_string());
                let location    = e.get_location().map(|s| s.to_string());
                let rrule       = e.property_value("RRULE").map(|s| s.to_string());

                events.push(ParsedIcsEvent {
                    uid,
                    summary,
                    starts_at,
                    ends_at,
                    all_day,
                    description,
                    location,
                    rrule,
                });
            }
        }

        Ok(events)
    }
}

/// Which iTIP method a generated invitation carries.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ItipMethod {
    /// A new or updated meeting invitation.
    Request,
    /// A cancellation of a previously sent invitation.
    Cancel,
}

/// UTC timestamp in iCalendar basic form: `20260905T140000Z`.
fn format_utc_stamp(dt: chrono::DateTime<Utc>) -> String {
    dt.format("%Y%m%dT%H%M%SZ").to_string()
}

/// Date-only value for all-day events: `20260905`.
fn format_date(dt: chrono::DateTime<Utc>) -> String {
    dt.format("%Y%m%d").to_string()
}

/// Escapes a property TEXT value per RFC 5545 §3.3.11: backslash, semicolon,
/// comma and newlines. Carriage returns are dropped (a bare CR is not valid in
/// a value and folding re-adds CRLF around logical lines).
fn escape_text(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for ch in value.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            ';'  => out.push_str("\\;"),
            ','  => out.push_str("\\,"),
            '\n' => out.push_str("\\n"),
            '\r' => {}
            _    => out.push(ch),
        }
    }
    out
}

/// Escapes a parameter value (e.g. a `CN`). A value carrying `"`, `;`, `,` or
/// `:` must be double-quoted; an embedded double quote cannot be represented, so
/// it is dropped. Newlines are stripped.
fn escape_param(value: &str) -> String {
    let cleaned: String = value.chars().filter(|c| *c != '"' && *c != '\r' && *c != '\n').collect();
    if cleaned.contains([';', ',', ':']) {
        format!("\"{cleaned}\"")
    } else {
        cleaned
    }
}

/// Folds one logical line to at most 75 octets per physical line, inserting
/// `CRLF` + a single space between fragments, and never splitting a multi-byte
/// UTF-8 character across the boundary (RFC 5545 §3.1). The returned string
/// carries the interior fold breaks but no trailing `CRLF`.
fn fold_line(line: &str) -> String {
    const LIMIT: usize = 75;
    if line.len() <= LIMIT {
        return line.to_string();
    }
    let mut out = String::with_capacity(line.len() + line.len() / LIMIT * 3);
    let mut count = 0usize; // octets written on the current physical line
    let mut first = true;
    for ch in line.chars() {
        let ch_len = ch.len_utf8();
        // A continuation line starts with a space that counts toward its budget.
        let budget = if first { LIMIT } else { LIMIT - 1 };
        if count + ch_len > budget {
            out.push_str("\r\n ");
            count = 1; // the leading space
            first = false;
        }
        out.push(ch);
        count += ch_len;
    }
    out
}

#[derive(Debug)]
pub struct ParsedIcsEvent {
    pub uid:         String,
    pub summary:     String,
    pub starts_at:   chrono::DateTime<Utc>,
    pub ends_at:     chrono::DateTime<Utc>,
    pub all_day:     bool,
    pub description: Option<String>,
    pub location:    Option<String>,
    pub rrule:       Option<String>,
}

/// Converts an icalendar `DatePerhapsTime` into a UTC instant, returning
/// whether the source value was a date-only (all-day) value.
fn date_perhaps_time_to_utc(dpt: DatePerhapsTime) -> Option<(chrono::DateTime<Utc>, bool)> {
    match dpt {
        DatePerhapsTime::DateTime(cdt) => {
            let dt = match cdt {
                CalendarDateTime::Utc(dt) => dt,
                CalendarDateTime::Floating(naive) => Utc.from_utc_datetime(&naive),
                CalendarDateTime::WithTimezone { date_time, tzid } => {
                    // Resolve the named timezone (e.g. "Europe/Paris") to convert
                    // the local wall-clock time to UTC; fall back to treating the
                    // value as UTC when the TZID is unknown.
                    tzid.parse::<chrono_tz::Tz>()
                        .ok()
                        .and_then(|tz| tz.from_local_datetime(&date_time).single())
                        .map(|dt| dt.with_timezone(&Utc))
                        .unwrap_or_else(|| Utc.from_utc_datetime(&date_time))
                }
            };
            Some((dt, false))
        }
        DatePerhapsTime::Date(d) => {
            Some((Utc.from_utc_datetime(&d.and_hms_opt(0, 0, 0)?), true))
        }
    }
}
