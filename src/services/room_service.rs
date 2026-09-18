//! Booking a room.
//!
//! ## A room is an attendee that answers
//!
//! It is invited like a person and it replies: it accepts when it is free, and
//! it declines when it is not. That is the whole contract, and it is why the
//! room lives in `calendar.attendees` (migration `000010`) rather than in a
//! column on the event — a decline is a status a person already has.
//!
//! Declining rather than refusing the request is deliberate: the meeting is not
//! the room's to cancel. An organiser who books a taken room keeps their
//! meeting and sees, in the same place they see everyone else's answers, that
//! the room said no.
//!
//! ## The directory belongs to the core
//!
//! Rooms are read from `/internal/directory/resources` and never written here.
//! A module that could change what rooms exist would be a module deciding what
//! the organisation contains.

use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use std::collections::HashMap;
use uuid::Uuid;

use crate::errors::{CalendarError, Result};
use crate::models::event::Event;
use crate::services::recurrence_service::RecurrenceService;

/// How far ahead a recurring booking is checked for clashes.
///
/// A rule with no end repeats for ever, and "is this room free for ever?" has no
/// answer worth waiting for. A year is what a room timetable is planned over,
/// and the occurrence cap stops a daily rule from expanding into a list nobody
/// reads. Past the horizon a clash is caught when the occurrence is edited —
/// the honest alternative to pretending we checked.
const HORIZON_DAYS: i64 = 365;
const MAX_OCCURRENCES: usize = 400;

/// A room, as the core's catalogue publishes it. Only the fields a booking needs.
/// The place a room sits in, as the directory publishes it.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct RoomBuilding {
    pub key:  String,
    #[serde(default)]
    pub name: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Room {
    pub id:             Uuid,
    /// Composed by the core; what everybody outside the directory reads.
    pub generated_name: String,
    pub capacity:       i64,
    /// The short name, the place and the equipment — kept SEPARATE from the
    /// composed name because a list reads them as columns, not as one string:
    /// "Salle réunion 1 · Bâtiment Paris · Étage 2 · 10 places · vidéo". The
    /// composed name stays for everywhere a single label is needed.
    #[serde(default)]
    pub name:           String,
    #[serde(default)]
    pub floor_name:     String,
    #[serde(default)]
    pub floor_section:  Option<String>,
    #[serde(default)]
    pub features:       Vec<String>,
    #[serde(default)]
    pub building:       Option<RoomBuilding>,
    /// The directory says this room is never handed back automatically. A rule
    /// the calendar applies but does not own — only an administrator decides
    /// which rooms are governed by it.
    #[serde(default)]
    pub release_exempt: bool,
}

#[derive(Deserialize)]
struct RoomCatalogue {
    resources: Vec<Room>,
}

/// One clash: when, and which meeting already holds the room.
#[derive(Debug, Clone, Serialize)]
pub struct RoomClash {
    pub event_id:  Uuid,
    pub title:     String,
    pub starts_at: DateTime<Utc>,
    pub ends_at:   DateTime<Utc>,
}

pub struct RoomService;

impl RoomService {
    /// The room, if the directory still holds one under that id.
    ///
    /// `None` covers both "no such room" and "the core did not answer", and the
    /// caller refuses in either case: booking a room we cannot describe would
    /// put a row in the guest list that nothing can render.
    pub async fn fetch(
        http: &reqwest::Client,
        core_url: &str,
        secret: &str,
        resource_id: Uuid,
    ) -> Option<Room> {
        Self::catalogue(http, core_url, secret)
            .await?
            .into_iter()
            .find(|r| r.id == resource_id)
    }

    /// The whole catalogue, as the core publishes it.
    pub async fn catalogue(
        http: &reqwest::Client,
        core_url: &str,
        secret: &str,
    ) -> Option<Vec<Room>> {
        let url = format!("{core_url}/internal/directory/resources");
        let resp = http
            .get(&url)
            .header("X-Internal-Secret", secret)
            .send()
            .await
            .map_err(|e| tracing::warn!(error = %e, "Salles : lecture du catalogue"))
            .ok()?;

        if !resp.status().is_success() {
            tracing::warn!(status = %resp.status(), "Salles : catalogue refusé par le core");
            return None;
        }

        let body: RoomCatalogue = resp
            .json()
            .await
            .map_err(|e| tracing::warn!(error = %e, "Salles : catalogue illisible"))
            .ok()?;

        Some(body.resources)
    }

    /// Does this account belong to a group whose meetings keep their room?
    ///
    /// `false` when the directory does not answer: a rule we cannot read must not
    /// silently protect everybody — the room-level exemption and the size and
    /// duration limits still apply, and they are read from data we do hold.
    async fn in_exempt_group(
        http: &reqwest::Client,
        core_url: &str,
        secret: &str,
        user_id: Uuid,
    ) -> bool {
        #[derive(Deserialize)]
        struct Group { release_exempt: bool }
        #[derive(Deserialize)]
        struct Groups { groups: Vec<Group> }

        let url = format!("{core_url}/internal/directory/users/{user_id}/groups");
        let Ok(resp) = http.get(&url).header("X-Internal-Secret", secret).send().await else {
            tracing::warn!(%user_id, "Libération : groupes du compte illisibles");
            return false;
        };
        if !resp.status().is_success() {
            return false;
        }
        resp.json::<Groups>()
            .await
            .map(|g| g.groups.iter().any(|x| x.release_exempt))
            .unwrap_or(false)
    }

    /// The times an event actually occupies, one entry per occurrence.
    ///
    /// A single event is its own only occurrence. A recurring one is expanded
    /// over the horizon, which is also what bounds the clash search below.
    fn windows(event: &Event) -> Vec<(DateTime<Utc>, DateTime<Utc>)> {
        if event.rrule.is_none() {
            return vec![(event.starts_at, event.ends_at)];
        }
        let until = event.starts_at + Duration::days(HORIZON_DAYS);
        let mut out: Vec<(DateTime<Utc>, DateTime<Utc>)> =
            RecurrenceService::expand(event, None, event.starts_at, until)
                .into_iter()
                .map(|i| (i.starts_at, i.ends_at))
                .collect();
        out.truncate(MAX_OCCURRENCES);
        // An expansion that yields nothing (a rule we could not read) must not be
        // taken as "this room is free at no time at all".
        if out.is_empty() {
            out.push((event.starts_at, event.ends_at));
        }
        out
    }

    /// Every meeting that already holds this room during `event`'s occurrences.
    ///
    /// Recurrence is expanded on BOTH sides. The module's own availability query
    /// skips recurring events (`rrule IS NULL`), which is exactly the case that
    /// matters here: a room is most often held by the weekly meeting, and a
    /// check that missed it would hand out the room every time.
    pub async fn clashes(
        db: &PgPool,
        resource_id: Uuid,
        event: &Event,
    ) -> Result<Vec<RoomClash>> {
        let windows = Self::windows(event);
        let from = windows.iter().map(|w| w.0).min().unwrap_or(event.starts_at);
        let until = windows.iter().map(|w| w.1).max().unwrap_or(event.ends_at);

        // Candidates: the room is on their guest list and has not declined them.
        // A cancelled meeting holds nothing. The event being booked is excluded —
        // a room does not clash with itself.
        let candidates: Vec<Event> = sqlx::query_as::<_, Event>(
            r#"
            SELECT e.* FROM calendar.events e
            JOIN calendar.attendees a ON a.event_id = e.id
            WHERE a.resource_id = $1
              AND a.status <> 'declined'
              AND e.status <> 'cancelled'
              AND e.id <> $2
              AND (e.rrule IS NOT NULL OR (e.starts_at < $4 AND e.ends_at > $3))
            "#,
        )
        .bind(resource_id)
        .bind(event.id)
        .bind(from)
        .bind(until)
        .fetch_all(db)
        .await?;

        let mut clashes = Vec::new();
        for other in &candidates {
            for (os, oe) in Self::windows_within(other, from, until) {
                if windows.iter().any(|(s, e)| *s < oe && *e > os) {
                    clashes.push(RoomClash {
                        event_id:  other.id,
                        title:     other.title.clone(),
                        starts_at: os,
                        ends_at:   oe,
                    });
                    break; // one clash per meeting is enough to say no
                }
            }
        }
        Ok(clashes)
    }

    /// A meeting that does not exist yet, shaped as an `Event`.
    ///
    /// Availability is decided by two things — the times occupied, and the room
    /// already held — and both are computed from an `Event`. Rather than write a
    /// second expansion for drafts (which would drift from the first the day a
    /// recurrence rule gains a subtlety), a draft is given the shape of the
    /// thing it is about to become. Only the fields those computations read
    /// carry meaning; the rest are inert placeholders, never persisted.
    ///
    /// `id` is the meeting being edited, so it does not clash with itself, and
    /// the nil id when there is nothing to exclude yet.
    pub fn draft(
        id: Option<Uuid>,
        starts_at: DateTime<Utc>,
        ends_at: DateTime<Utc>,
        rrule: Option<String>,
        timezone: Option<String>,
    ) -> Event {
        let now = Utc::now();
        Event {
            id: id.unwrap_or_else(Uuid::nil),
            calendar_id: Uuid::nil(),
            owner_id: Uuid::nil(),
            title: String::new(),
            description: None,
            location: None,
            url: None,
            starts_at,
            ends_at,
            all_day: false,
            timezone: timezone.unwrap_or_else(|| "UTC".into()),
            color: None,
            rrule,
            exdates: Vec::new(),
            parent_event_id: None,
            recurrence_id: None,
            reminders: serde_json::Value::Null,
            ical_uid: String::new(),
            etag: String::new(),
            sequence: 0,
            status: "confirmed".into(),
            visibility: "default".into(),
            busy: true,
            linked_file_ids: Vec::new(),
            linked_note_id: None,
            linked_task_ids: Vec::new(),
            meeting_duration_minutes: None,
            created_at: now,
            updated_at: now,
            guests_can_modify:     false,
            guests_can_invite:     true,
            guests_can_see_guests: true,
        }
    }

    /// Which rooms are free for a slot, and what holds the others.
    ///
    /// ## Why this exists beside `clashes`
    ///
    /// `clashes` answers for ONE room and needs a saved meeting. A person
    /// composing an invitation needs the opposite: every room at once, for times
    /// that exist only in the form in front of them. Showing a list of rooms
    /// without saying which are free is asking someone to guess and be refused.
    ///
    /// ## One query, not one per room
    ///
    /// Every meeting that holds ANY of the rooms over the window is fetched once
    /// and grouped in memory. Asking per room would be a query per row of a list
    /// that is redrawn each time the organiser nudges the hour.
    pub async fn availability(
        db: &PgPool,
        rooms: &[Uuid],
        slot: &Event,
    ) -> Result<HashMap<Uuid, Vec<RoomClash>>> {
        let mut out: HashMap<Uuid, Vec<RoomClash>> = HashMap::new();
        if rooms.is_empty() {
            return Ok(out);
        }
        let windows = Self::windows(slot);
        let from = windows.iter().map(|w| w.0).min().unwrap_or(slot.starts_at);
        let until = windows.iter().map(|w| w.1).max().unwrap_or(slot.ends_at);

        // The room each candidate holds travels with the event: the same meeting
        // may hold two rooms, and it must be reported against both.
        // `Event` is a row struct, not a column: the room it is held for rides
        // alongside it, flattened, rather than as a tuple sqlx cannot decode.
        #[derive(sqlx::FromRow)]
        struct Held {
            resource_id: Uuid,
            #[sqlx(flatten)]
            event: Event,
        }

        let held: Vec<Held> = sqlx::query_as::<_, Held>(
            r#"
            SELECT a.resource_id, e.*
              FROM calendar.events e
              JOIN calendar.attendees a ON a.event_id = e.id
             WHERE a.resource_id = ANY($1)
               AND a.status <> 'declined'
               AND e.status <> 'cancelled'
               AND e.id <> $2
               AND (e.rrule IS NOT NULL OR (e.starts_at < $4 AND e.ends_at > $3))
            "#,
        )
        .bind(rooms)
        .bind(slot.id)
        .bind(from)
        .bind(until)
        .fetch_all(db)
        .await?;

        for row in &held {
            let (resource_id, other) = (row.resource_id, &row.event);
            for (os, oe) in Self::windows_within(other, from, until) {
                if windows.iter().any(|(s, e)| *s < oe && *e > os) {
                    out.entry(resource_id).or_default().push(RoomClash {
                        event_id:  other.id,
                        title:     other.title.clone(),
                        starts_at: os,
                        ends_at:   oe,
                    });
                    break;
                }
            }
        }
        Ok(out)
    }

    /// The occupied times of an existing meeting, confined to the search window.
    fn windows_within(
        event: &Event,
        from: DateTime<Utc>,
        until: DateTime<Utc>,
    ) -> Vec<(DateTime<Utc>, DateTime<Utc>)> {
        if event.rrule.is_none() {
            return vec![(event.starts_at, event.ends_at)];
        }
        let mut out: Vec<(DateTime<Utc>, DateTime<Utc>)> =
            RecurrenceService::expand(event, None, from, until)
                .into_iter()
                .map(|i| (i.starts_at, i.ends_at))
                .collect();
        out.truncate(MAX_OCCURRENCES);
        out
    }

    /// Re-decides every room held by a meeting whose times just moved.
    ///
    /// The documented behaviour of this kind of calendar: moving a meeting
    /// RELEASES its rooms and tries to book them again at the new hour; a room
    /// that is no longer free declines. Without it a room stays marked
    /// "accepted" for a slot it never agreed to, and two meetings quietly own
    /// the same room — the one failure this feature exists to prevent.
    ///
    /// Best effort by design: the meeting has already been saved, and a room
    /// that cannot be re-decided must not undo somebody's edit. Returns the
    /// rooms that ended up declining, for the caller to tell the organiser.
    pub async fn rebook(db: &PgPool, event: &Event) -> Result<Vec<Uuid>> {
        let held: Vec<Uuid> = sqlx::query_scalar(
            "SELECT resource_id FROM calendar.attendees
              WHERE event_id = $1 AND resource_id IS NOT NULL",
        )
        .bind(event.id)
        .fetch_all(db)
        .await?;
        if held.is_empty() {
            return Ok(Vec::new());
        }

        let busy = Self::availability(db, &held, event).await?;
        let mut declined = Vec::new();
        for id in held {
            let free = !busy.contains_key(&id);
            // `released_at` is cleared on the way through: a room re-decided by a
            // move was not handed back by an empty meeting, and counting it as
            // released would inflate the "hours released" figure.
            sqlx::query(
                "UPDATE calendar.attendees
                    SET status = $3, released_at = NULL
                  WHERE event_id = $1 AND resource_id = $2",
            )
            .bind(event.id)
            .bind(id)
            .bind(if free { "accepted" } else { "declined" })
            .execute(db)
            .await?;
            if !free {
                declined.push(id);
            }
        }
        Ok(declined)
    }

    /// Puts the room on the guest list, with the answer it owes.
    ///
    /// Returns the clashes that made it decline, empty when it accepted.
    pub async fn invite(
        db: &PgPool,
        event: &Event,
        room: &Room,
    ) -> Result<Vec<RoomClash>> {
        let clashes = Self::clashes(db, room.id, event).await?;
        let status = if clashes.is_empty() { "accepted" } else { "declined" };

        sqlx::query(
            r#"
            INSERT INTO calendar.attendees (event_id, resource_id, display_name, status, responded_at)
            VALUES ($1, $2, $3, $4, NOW())
            ON CONFLICT (event_id, resource_id) WHERE resource_id IS NOT NULL
            DO UPDATE SET status = EXCLUDED.status,
                          display_name = EXCLUDED.display_name,
                          responded_at = NOW()
            "#,
        )
        .bind(event.id)
        .bind(room.id)
        .bind(&room.generated_name)
        .bind(status)
        .execute(db)
        .await?;

        Ok(clashes)
    }

    /// Takes the room off the guest list. Freeing it is the point, so a room
    /// that was not on it is not an error to report.
    pub async fn remove(db: &PgPool, event_id: Uuid, resource_id: Uuid) -> Result<()> {
        sqlx::query("DELETE FROM calendar.attendees WHERE event_id = $1 AND resource_id = $2")
            .bind(event_id)
            .bind(resource_id)
            .execute(db)
            .await?;
        Ok(())
    }

    /// The owner check every room verb shares.
    pub async fn require_owner(db: &PgPool, event_id: Uuid, user_id: Uuid) -> Result<Event> {
        sqlx::query_as::<_, Event>("SELECT * FROM calendar.events WHERE id = $1 AND owner_id = $2")
            .bind(event_id)
            .bind(user_id)
            .fetch_optional(db)
            .await?
            .ok_or(CalendarError::Forbidden)
    }
}

// ── Giving a room back ───────────────────────────────────────────────────────

/// A meeting must not be emptied of its room at the last moment: somebody is
/// already walking there. Both windows are fixed rather than configurable — a
/// deadline an administrator can shorten to nothing is a deadline that will one
/// day free a room while its occupants sit in it.
const RELEASE_MIN_NOTICE: i64 = 30; // minutes before the start, below which nothing is released
/// A room large enough to be an event space is never freed automatically: the
/// cost of being wrong about it is a cancelled event, not a moved chair.
const RELEASE_MAX_CAPACITY: i64 = 20;
/// A long booking is a workshop or a training day, planned around, not a slot
/// that empties because two people declined.
const RELEASE_MAX_HOURS: i64 = 4;

/// Why a room was NOT given back. Kept as a value rather than a log line so the
/// figure "hours that could not be released" can one day say what stopped it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NotReleased {
    /// Somebody is still expected.
    StillExpected,
    /// Too close to the start, or already started.
    TooLate,
    /// No one but the organiser was invited: nothing emptied out.
    NoGuests,
    /// An outside guest is on the list; we do not know what they will do.
    ExternalGuest,
    /// Somebody on the list belongs to a group whose meetings keep their room.
    ExemptGroup,
    /// A room this large, or a booking this long, is never freed automatically.
    Exempt,
}

impl RoomService {
    /// Gives back the rooms of a meeting that has emptied out.
    ///
    /// The rule, and the guards around it, follow the behaviour this feature has
    /// elsewhere: **when every invitee but one has declined**, the room declines
    /// too and is handed back — while the MEETING is left alone. Cancelling it is
    /// not the room's decision, and two people who cannot come do not speak for
    /// the organiser.
    ///
    /// Best-effort by construction: it is called after an RSVP has already been
    /// recorded, and a failure here must never make that answer fail. The caller
    /// ignores the error; the room simply stays booked.
    ///
    /// Returns the rooms actually given back, or why nothing was.
    pub async fn release_if_deserted(
        db: &PgPool,
        http: &reqwest::Client,
        core_url: &str,
        secret: &str,
        event_id: Uuid,
        internal_domain: impl Fn(&str) -> bool,
    ) -> Result<std::result::Result<Vec<Uuid>, NotReleased>> {
        let Some(event) = sqlx::query_as::<_, Event>("SELECT * FROM calendar.events WHERE id = $1")
            .bind(event_id)
            .fetch_optional(db)
            .await?
        else {
            return Ok(Err(NotReleased::TooLate));
        };

        // Too late, or already under way. A recurring meeting is judged on the
        // occurrence at hand — its own start — which is what `starts_at` holds
        // for the row an RSVP answers.
        let notice = event.starts_at - Utc::now();
        if notice < Duration::minutes(RELEASE_MIN_NOTICE) {
            return Ok(Err(NotReleased::TooLate));
        }
        if event.ends_at - event.starts_at > Duration::hours(RELEASE_MAX_HOURS) {
            return Ok(Err(NotReleased::Exempt));
        }

        // The people. Rooms answer too, but a room declining does not mean the
        // meeting emptied — that is the very thing being decided here.
        let guests: Vec<(Option<String>, String, bool)> = sqlx::query_as(
            "SELECT email, status, is_organizer FROM calendar.attendees
              WHERE event_id = $1 AND resource_id IS NULL",
        )
        .bind(event_id)
        .fetch_all(db)
        .await?;

        let invitees: Vec<&(Option<String>, String, bool)> =
            guests.iter().filter(|(_, _, organizer)| !organizer).collect();
        if invitees.is_empty() {
            return Ok(Err(NotReleased::NoGuests));
        }
        if invitees
            .iter()
            .any(|(email, _, _)| email.as_deref().is_some_and(|e| !internal_domain(e)))
        {
            return Ok(Err(NotReleased::ExternalGuest));
        }

        // A population whose meetings keep their room, wherever they meet. Asked
        // of the directory only once the meeting is otherwise releasable — it is
        // one call per invitee, and the cheap refusals above spare it.
        let ids: Vec<Uuid> = sqlx::query_scalar(
            "SELECT user_id FROM calendar.attendees
              WHERE event_id = $1 AND resource_id IS NULL AND is_organizer = FALSE
                AND user_id IS NOT NULL",
        )
        .bind(event_id)
        .fetch_all(db)
        .await?;
        for user_id in ids {
            if Self::in_exempt_group(http, core_url, secret, user_id).await {
                return Ok(Err(NotReleased::ExemptGroup));
            }
        }

        let declined = invitees.iter().filter(|(_, s, _)| s == "declined").count();
        if declined == 0 || declined < invitees.len() - 1 {
            return Ok(Err(NotReleased::StillExpected));
        }

        // The rooms still held by this meeting.
        let held: Vec<(Uuid,)> = sqlx::query_as(
            "SELECT resource_id FROM calendar.attendees
              WHERE event_id = $1 AND resource_id IS NOT NULL AND status <> 'declined'",
        )
        .bind(event_id)
        .fetch_all(db)
        .await?;
        if held.is_empty() {
            return Ok(Ok(vec![]));
        }

        let catalogue = Self::catalogue(http, core_url, secret).await.unwrap_or_default();
        let mut freed = Vec::new();
        for (resource_id,) in held {
            // A large room is exempt. A room the catalogue no longer describes is
            // left alone too: we cannot tell whether it is one of those.
            let Some(room) = catalogue.iter().find(|r| r.id == resource_id) else { continue };
            if room.release_exempt || room.capacity >= RELEASE_MAX_CAPACITY {
                continue;
            }
            sqlx::query(
                "UPDATE calendar.attendees
                    SET status = 'declined', released_at = NOW(), responded_at = NOW()
                  WHERE event_id = $1 AND resource_id = $2",
            )
            .bind(event_id)
            .bind(resource_id)
            .execute(db)
            .await?;
            freed.push(resource_id);
            tracing::info!(%event_id, %resource_id, "Salle libérée : la réunion s'est vidée");
        }
        Ok(Ok(freed))
    }
}
