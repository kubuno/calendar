use chrono::{Duration, TimeZone, Utc};
use icalendar::{Calendar as ICalCalendar, CalendarDateTime, Component, DatePerhapsTime, Event as ICalEvent, EventLike};

use crate::{
    errors::{CalendarError, Result},
    models::event::Event,
};

pub struct ICalendarService;

impl ICalendarService {
    /// Convertit un événement Kubuno en chaîne iCalendar (.ics).
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
        ical_event.add_property("SEQUENCE", &event.sequence.to_string());

        cal.push(ical_event.done());
        cal.to_string()
    }

    /// Convertit un calendrier entier (liste d'événements) en .ics.
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
            ical_event.add_property("SEQUENCE", &event.sequence.to_string());

            cal.push(ical_event.done());
        }

        cal.to_string()
    }

    /// Parse un flux iCalendar et retourne les événements extraits.
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
