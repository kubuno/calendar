//! What the rooms were used for, over a period.
//!
//! ## Why this lives here and not in the console
//!
//! The bookings are rows of the `calendar` schema, and the core does not read
//! another component's schema — that is the rule that keeps a module replaceable.
//! So the module counts its own bookings and answers with figures; the console
//! asks through the internal relay and draws them.
//!
//! ## Occurrences, not events
//!
//! A weekly meeting holding a room occupies it every week. Counting rows would
//! report it once, and the busiest room in the building would look idle. Every
//! recurring booking is therefore expanded across the window, exactly as the
//! clash detection expands it — the same lesson, in the other direction.
//!
//! ## Days and hours belong to a place
//!
//! Instants are stored in UTC, which is right, but "Monday" and "nine o'clock"
//! are not properties of an instant — they are what a clock in a given zone says
//! about it. Cut in UTC, a nine o'clock meeting in Paris falls in the eight
//! o'clock column, and an eight o'clock one in Tokyo falls on the day before.
//! The caller therefore names the zone, and every bucket is cut in it.

use chrono::{DateTime, Datelike, Duration, Timelike, Utc, Weekday};
use chrono_tz::Tz;
use kubuno_db::{params, DbPool};
use serde::Serialize;
use std::collections::HashMap;
use uuid::Uuid;

use crate::errors::Result;
use crate::models::event::Event;
use crate::services::recurrence_service::RecurrenceService;

/// The working day a booking rate is measured against.
///
/// A rate needs a denominator, and "every hour of every day" is not one: nobody
/// books a meeting room at four in the morning, and a rate computed over 24×7
/// makes every room look permanently free. Weekends are out for the same reason
/// — which is also how the figure is read elsewhere.
const WORKDAY_HOURS: f64 = 8.0;

#[derive(Debug, Serialize)]
pub struct RoomStats {
    pub from: DateTime<Utc>,
    pub to:   DateTime<Utc>,
    /// Occurrences a room actually held.
    pub bookings:      i64,
    pub booked_hours:  f64,
    /// Occurrences a room refused — a clash, or a meeting that emptied out.
    pub declined:      i64,
    /// Hours handed back automatically. Countable only because a released room
    /// carries a stamp that a room refusing a clash does not.
    pub released_hours: f64,
    /// Rooms in the directory, and the hours they could have been booked for.
    pub rooms:           i64,
    pub available_hours: f64,
    /// `booked_hours / available_hours`, or `null` when there is no room at all
    /// — a rate over nothing is not zero, it is meaningless.
    pub booking_rate: Option<f64>,
    pub per_day:  Vec<DayUsage>,
    pub per_hour: Vec<HourUsage>,
    pub per_room: Vec<RoomUsage>,
}

#[derive(Debug, Serialize)]
pub struct DayUsage {
    pub date:     String,
    pub hours:    f64,
    pub bookings: i64,
}

#[derive(Debug, Serialize)]
pub struct HourUsage {
    /// Hour of the day, 0–23, read on a clock in the zone the caller named.
    pub hour:  u32,
    pub hours: f64,
}

#[derive(Debug, Serialize)]
pub struct RoomUsage {
    pub resource_id: Uuid,
    pub name:        String,
    pub capacity:    i64,
    pub hours:       f64,
    pub bookings:    i64,
    pub declined:    i64,
}

/// One occupied slot, after recurrence has been flattened out.
struct Slot {
    resource_id: Uuid,
    start:       DateTime<Utc>,
    end:         DateTime<Utc>,
    accepted:    bool,
    released:    bool,
}

pub struct RoomStatsService;

impl RoomStatsService {
    pub async fn compute(
        db: &DbPool,
        http: &reqwest::Client,
        core_url: &str,
        secret: &str,
        from: DateTime<Utc>,
        to: DateTime<Utc>,
        tz: Tz,
    ) -> Result<RoomStats> {
        // Every meeting in the window that has a room on its guest list. A
        // recurring one is taken whatever its own start, because its occurrences
        // may well fall inside a window its first date does not.
        // Placeholders must ascend in text order (the portable rewriter refuses
        // `$2 ... $1`), so `to` takes $1 and `from` takes $2.
        let rows: Vec<(Uuid, String, Option<DateTime<Utc>>, Uuid)> = db
            .fetch_all_as(
                r#"
            SELECT a.resource_id, a.status, a.released_at, e.id
              FROM calendar.attendees a
              JOIN calendar.events e ON e.id = a.event_id
             WHERE a.resource_id IS NOT NULL
               AND e.status <> 'cancelled'
               AND (e.rrule IS NOT NULL OR (e.starts_at < $1 AND e.ends_at > $2))
            "#,
                params![to, from],
            )
            .await?;

        let mut events: HashMap<Uuid, Event> = HashMap::new();
        for (_, _, _, event_id) in &rows {
            if events.contains_key(event_id) {
                continue;
            }
            if let Some(e) = db
                .fetch_optional_as::<Event>("SELECT * FROM calendar.events WHERE id = $1", params![*event_id])
                .await?
            {
                events.insert(*event_id, e);
            }
        }

        let mut slots: Vec<Slot> = Vec::new();
        for (resource_id, status, released_at, event_id) in &rows {
            let Some(event) = events.get(event_id) else { continue };
            let occurrences: Vec<(DateTime<Utc>, DateTime<Utc>)> = if event.rrule.is_none() {
                vec![(event.starts_at, event.ends_at)]
            } else {
                RecurrenceService::expand(event, None, from, to)
                    .into_iter()
                    .map(|i| (i.starts_at, i.ends_at))
                    .collect()
            };
            for (start, end) in occurrences {
                if end <= from || start >= to {
                    continue;
                }
                slots.push(Slot {
                    resource_id: *resource_id,
                    start,
                    end,
                    accepted: status != "declined",
                    released: released_at.is_some(),
                });
            }
        }

        // The catalogue names the rooms and sizes the denominator. Without it the
        // figures still stand; only the rate and the names are missing.
        let catalogue = crate::services::room_service::RoomService::catalogue(http, core_url, secret)
            .await
            .unwrap_or_default();

        let hours_of = |s: &Slot| (s.end - s.start).num_seconds() as f64 / 3600.0;

        let mut per_day: HashMap<String, (f64, i64)> = HashMap::new();
        let mut per_hour: HashMap<u32, f64> = HashMap::new();
        let mut per_room: HashMap<Uuid, (f64, i64, i64)> = HashMap::new();
        let (mut bookings, mut booked_hours, mut declined, mut released_hours) = (0i64, 0.0, 0i64, 0.0);

        for slot in &slots {
            let h = hours_of(slot);
            let entry = per_room.entry(slot.resource_id).or_insert((0.0, 0, 0));
            if slot.accepted {
                bookings += 1;
                booked_hours += h;
                entry.0 += h;
                entry.1 += 1;
                let local = slot.start.with_timezone(&tz);
                let day = per_day.entry(local.format("%Y-%m-%d").to_string()).or_insert((0.0, 0));
                day.0 += h;
                day.1 += 1;
                *per_hour.entry(local.hour()).or_insert(0.0) += h;
            } else {
                declined += 1;
                entry.2 += 1;
                if slot.released {
                    released_hours += h;
                }
            }
        }

        // Working hours in the window: weekdays only, one working day each —
        // counted on the same calendar the buckets are cut on, or the rate and
        // its denominator would disagree about which days the window covers.
        let mut workdays = 0i64;
        let mut cursor = from.with_timezone(&tz).date_naive();
        let last = to.with_timezone(&tz).date_naive();
        while cursor <= last {
            if !matches!(cursor.weekday(), Weekday::Sat | Weekday::Sun) {
                workdays += 1;
            }
            cursor += Duration::days(1);
        }
        let rooms = catalogue.len() as i64;
        let available_hours = rooms as f64 * workdays as f64 * WORKDAY_HOURS;

        let mut per_room_out: Vec<RoomUsage> = per_room
            .into_iter()
            .map(|(id, (hours, bookings, declined))| {
                let room = catalogue.iter().find(|r| r.id == id);
                RoomUsage {
                    resource_id: id,
                    // A room the directory no longer holds still had bookings, and
                    // dropping it would silently shrink the totals below.
                    name:     room.map(|r| r.generated_name.clone()).unwrap_or_else(|| "—".into()),
                    capacity: room.map(|r| r.capacity).unwrap_or(0),
                    hours,
                    bookings,
                    declined,
                }
            })
            .collect();
        per_room_out.sort_by(|a, b| b.hours.total_cmp(&a.hours));

        let mut per_day_out: Vec<DayUsage> = per_day
            .into_iter()
            .map(|(date, (hours, bookings))| DayUsage { date, hours, bookings })
            .collect();
        per_day_out.sort_by(|a, b| a.date.cmp(&b.date));

        let mut per_hour_out: Vec<HourUsage> =
            per_hour.into_iter().map(|(hour, hours)| HourUsage { hour, hours }).collect();
        per_hour_out.sort_by_key(|h| h.hour);

        Ok(RoomStats {
            from,
            to,
            bookings,
            booked_hours,
            declined,
            released_hours,
            rooms,
            available_hours,
            booking_rate: (available_hours > 0.0).then(|| booked_hours / available_hours),
            per_day:  per_day_out,
            per_hour: per_hour_out,
            per_room: per_room_out,
        })
    }
}
