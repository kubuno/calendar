use chrono::{DateTime, Utc};
use std::collections::HashSet;

use crate::{
    errors::{CalendarError, Result},
    models::event::{Event, EventInstance},
};

pub struct RecurrenceService;

impl RecurrenceService {
    /// Valide une RRULE string (sans le préfixe RRULE:).
    pub fn validate_rrule(rrule: &str) -> Result<()> {
        let full = format!(
            "DTSTART:20240101T000000Z\n{}",
            if rrule.starts_with("RRULE:") {
                rrule.to_string()
            } else {
                format!("RRULE:{}", rrule)
            }
        );
        full.parse::<rrule::RRuleSet>()
            .map(|_| ())
            .map_err(|e| CalendarError::InvalidRRule(e.to_string()))
    }

    /// Expand les occurrences d'un événement récurrent dans la fenêtre [from, until].
    pub fn expand(
        event: &Event,
        calendar_color: Option<String>,
        from: DateTime<Utc>,
        until: DateTime<Utc>,
    ) -> Vec<EventInstance> {
        let rrule_str = match &event.rrule {
            Some(r) => r.clone(),
            None    => return vec![],
        };

        let dtstart_str = format!(
            "DTSTART:{}\n{}",
            event.starts_at.format("%Y%m%dT%H%M%SZ"),
            if rrule_str.starts_with("RRULE:") {
                rrule_str.clone()
            } else {
                format!("RRULE:{}", rrule_str)
            }
        );

        let set: rrule::RRuleSet = match dtstart_str.parse() {
            Ok(s)  => s,
            Err(e) => {
                tracing::warn!(error = %e, event_id = %event.id, "Impossible de parser RRULE");
                return vec![];
            }
        };

        let duration = event.ends_at - event.starts_at;

        let from_tz  = rrule::Tz::UTC;
        let until_tz = rrule::Tz::UTC;
        let from_dt  = from.with_timezone(&from_tz);
        let until_dt = until.with_timezone(&until_tz);

        let occurrences = set
            .after(from_dt)
            .before(until_dt)
            .all(500)
            .dates;

        let exdate_set: HashSet<i64> =
            event.exdates.iter().map(|d| d.timestamp()).collect();

        occurrences
            .into_iter()
            .filter(|occ| !exdate_set.contains(&occ.timestamp()))
            .map(|occ| {
                let occ_utc: DateTime<Utc> = occ.with_timezone(&Utc);
                EventInstance {
                    id:           format!("{}_{}", event.id, occ_utc.timestamp()),
                    event_id:     event.id,
                    calendar_id:  event.calendar_id,
                    owner_id:     event.owner_id,
                    title:        event.title.clone(),
                    description:  event.description.clone(),
                    location:     event.location.clone(),
                    starts_at:    occ_utc,
                    ends_at:      occ_utc + duration,
                    all_day:      event.all_day,
                    is_recurring: true,
                    rrule:        event.rrule.clone(),
                    reminders:    event.reminders.clone(),
                    status:       event.status.clone(),
                    visibility:   event.visibility.clone(),
                    busy:         event.busy,
                    timezone:     event.timezone.clone(),
                    ical_uid:     event.ical_uid.clone(),
                    etag:         event.etag.clone(),
                    color:        calendar_color.clone(),
                }
            })
            .collect()
    }

    /// Convertit un Event non-récurrent en EventInstance.
    pub fn single_to_instance(event: &Event, color: Option<String>) -> EventInstance {
        EventInstance {
            id:           event.id.to_string(),
            event_id:     event.id,
            calendar_id:  event.calendar_id,
            owner_id:     event.owner_id,
            title:        event.title.clone(),
            description:  event.description.clone(),
            location:     event.location.clone(),
            starts_at:    event.starts_at,
            ends_at:      event.ends_at,
            all_day:      event.all_day,
            is_recurring: false,
            rrule:        None,
            reminders:    event.reminders.clone(),
            status:       event.status.clone(),
            visibility:   event.visibility.clone(),
            busy:         event.busy,
            timezone:     event.timezone.clone(),
            ical_uid:     event.ical_uid.clone(),
            etag:         event.etag.clone(),
            color,
        }
    }
}
