//! Remote iCalendar subscriptions: calendars that mirror an external `.ics`
//! feed (externally published calendars, holidays feeds, …).
//!
//! The feed is fetched at subscription time, on manual refresh, and hourly by a
//! background task. Sync is a mirror: events are upserted by their iCalendar
//! UID and events that disappeared from the feed are removed from the calendar.

use chrono::Utc;
use kubuno_db::{params, DbPool, DbValue};
use std::collections::HashSet;
use uuid::Uuid;

use crate::{
    errors::{CalendarError, Result},
    models::{
        calendar::{Calendar, CreateCalendarDto, SubscribeCalendarDto},
        event::CreateEventDto,
    },
    services::{
        calendar_service::CalendarService, event_service::EventService,
        icalendar_service::ICalendarService,
    },
    sync,
};

/// Hard limits keeping a hostile/broken feed from hurting the service.
const MAX_FEED_BYTES: usize = 10 * 1024 * 1024; // 10 MB
const MAX_FEED_EVENTS: usize = 5_000;
const FETCH_TIMEOUT_SECS: u64 = 20;

pub struct SubscriptionService;

impl SubscriptionService {
    /// Validates a user-supplied feed URL: http(s)/webcal only (webcal:// is
    /// rewritten to https://), and obvious loopback/private hosts are rejected
    /// so the module can't be used to probe the internal network (SSRF).
    pub fn validate_url(raw: &str) -> Result<String> {
        let normalized = if let Some(rest) = raw.strip_prefix("webcal://") {
            format!("https://{rest}")
        } else {
            raw.to_string()
        };
        let url = reqwest::Url::parse(&normalized)
            .map_err(|_| CalendarError::Validation("URL de flux invalide".into()))?;
        if url.scheme() != "http" && url.scheme() != "https" {
            return Err(CalendarError::Validation(
                "Seuls les flux http(s) ou webcal sont acceptés".into(),
            ));
        }
        let host = url
            .host_str()
            .ok_or_else(|| CalendarError::Validation("URL de flux sans hôte".into()))?
            .to_ascii_lowercase();
        let is_private = host == "localhost"
            || host == "0.0.0.0"
            || host.ends_with(".local")
            || host.ends_with(".internal")
            || match host.parse::<std::net::IpAddr>() {
                Ok(ip) => match ip {
                    std::net::IpAddr::V4(v4) => {
                        v4.is_loopback()
                            || v4.is_private()
                            || v4.is_link_local()
                            || v4.is_unspecified()
                    }
                    std::net::IpAddr::V6(v6) => {
                        v6.is_loopback() || v6.is_unspecified() || (v6.segments()[0] & 0xfe00) == 0xfc00
                    }
                },
                Err(_) => false,
            };
        if is_private {
            return Err(CalendarError::Validation(
                "Cet hôte n'est pas autorisé pour un abonnement".into(),
            ));
        }
        Ok(url.to_string())
    }

    /// Creates a subscription calendar and runs a first sync right away.
    pub async fn subscribe(
        user_id: Uuid,
        dto: SubscribeCalendarDto,
        instance: &crate::config::InstanceConfig,
        db: &DbPool,
    ) -> Result<Calendar> {
        let url = Self::validate_url(&dto.url)?;

        let cal = CalendarService::create(
            user_id,
            CreateCalendarDto {
                id: None,
                name: dto.name,
                description: None,
                color: dto.color.or_else(|| Some("#6B7280".to_string())),
                cal_type: Some("subscription".to_string()),
                timezone: dto.timezone,
                is_public: Some(false),
            },
            instance,
            db,
        )
        .await?;

        // Stamp the feed URL onto the just-created calendar (a versioned write).
        let mut tx = db.begin().await?;
        let seq = sync::next_calendar_seq(&mut tx).await?;
        tx.execute(
            "UPDATE calendar.calendars SET subscription_url = $1, change_seq = $2 WHERE id = $3",
            params![&url, seq, cal.id],
        )
        .await?;
        tx.commit().await?;

        // First sync: a failure here must not lose the created calendar — the
        // user can retry with the refresh action.
        if let Err(e) = Self::sync(cal.id, user_id, &url, db).await {
            tracing::warn!(calendar = %cal.id, error = %e, "Première synchro d'abonnement échouée");
        }

        CalendarService::get(cal.id, user_id, db).await
    }

    /// Fetches the feed and mirrors it into the calendar (upsert + prune).
    /// Returns (imported, updated, removed).
    pub async fn sync(
        calendar_id: Uuid,
        owner_id: Uuid,
        url: &str,
        db: &DbPool,
    ) -> Result<(usize, usize, usize)> {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(FETCH_TIMEOUT_SECS))
            .user_agent("Kubuno-Calendar/1.0 (+ics-subscription)")
            .build()
            .map_err(|e| CalendarError::Internal(anyhow::anyhow!("client http: {e}")))?;

        let resp = client
            .get(url)
            .send()
            .await
            .map_err(|e| CalendarError::Validation(format!("Flux inaccessible : {e}")))?;
        if !resp.status().is_success() {
            return Err(CalendarError::Validation(format!(
                "Flux inaccessible (HTTP {})",
                resp.status()
            )));
        }
        let body = resp
            .bytes()
            .await
            .map_err(|e| CalendarError::Validation(format!("Lecture du flux : {e}")))?;
        if body.len() > MAX_FEED_BYTES {
            return Err(CalendarError::Validation("Flux trop volumineux (max 10 Mo)".into()));
        }
        let ics = String::from_utf8_lossy(&body).into_owned();

        let parsed = ICalendarService::parse_ics(&ics)?;
        let mut imported = 0usize;
        let mut updated = 0usize;
        let mut uids: Vec<String> = Vec::with_capacity(parsed.len());

        for p in parsed.into_iter().take(MAX_FEED_EVENTS) {
            let ical_uid = if p.uid.trim().is_empty() {
                // No UID in the source: derive a stable one from the content so
                // re-syncs stay idempotent.
                format!("gen-{:x}@kubuno.sub", md5_like(&format!("{}|{}|{}", p.summary, p.starts_at, calendar_id)))
            } else {
                // Namespace by calendar so two subscriptions to feeds sharing
                // UIDs (or a feed also imported manually) never collide.
                format!("{}@sub.{}", p.uid, calendar_id)
            };

            let dto = CreateEventDto {
                id: None,
                calendar_id,
                title: p.summary,
                description: p.description,
                location: p.location,
                url: None,
                starts_at: p.starts_at,
                ends_at: p.ends_at,
                all_day: Some(p.all_day),
                timezone: Some("UTC".to_string()),
                color: None,
                rrule: p.rrule,
                reminders: None,
                status: None,
                visibility: None,
                busy: Some(true),
                attendees: None,
                guests_can_modify:     None,
                guests_can_invite:     None,
                guests_can_see_guests: None,
            };
            match EventService::import_event(owner_id, dto, &ical_uid, db).await {
                Ok(Some(true)) => imported += 1,
                Ok(Some(false)) => updated += 1,
                Ok(None) => {}
                Err(e) => tracing::warn!(calendar = %calendar_id, error = %e, "Événement de flux ignoré"),
            }
            uids.push(ical_uid);
        }

        // Prune: events gone from the feed disappear from the mirror. `= ANY(...)`
        // has no portable form, and the deleted rows need explicit tombstones (an
        // FK cascade runs no application code), so the calendar's events are read,
        // the ones absent from the feed are filtered in Rust, tombstoned and then
        // deleted by an explicit id list.
        let existing: Vec<(Uuid, Uuid, String)> = db
            .fetch_all_as(
                "SELECT id, owner_id, ical_uid FROM calendar.events WHERE calendar_id = $1",
                params![calendar_id],
            )
            .await?;
        let keep: HashSet<&str> = uids.iter().map(String::as_str).collect();
        let doomed: Vec<(Uuid, Uuid)> = existing
            .iter()
            .filter(|(_, _, uid)| !keep.contains(uid.as_str()))
            .map(|(id, owner, _)| (*id, *owner))
            .collect();
        let removed = doomed.len();

        if !doomed.is_empty() {
            let mut tx = db.begin().await?;
            for (id, owner) in &doomed {
                let seq = sync::next_event_seq(&mut tx).await?;
                kubuno_db::journal::record_tombstone(&mut tx, sync::EVENT_TOMBSTONES, *id, *owner, seq).await?;
            }
            let in_list = tx.backend().in_list(1, doomed.len());
            let binds: Vec<DbValue> = doomed.iter().map(|(id, _)| (*id).into()).collect();
            tx.execute(&format!("DELETE FROM calendar.events WHERE id IN ({in_list})"), binds)
                .await?;
            tx.commit().await?;
        }

        // Sync-metadata refresh (last_synced_at + ctag), deliberately without a
        // change_seq bump — an hourly mirror pass is not a user-facing calendar
        // change, and events ride their own delta feed.
        db.execute(
            "UPDATE calendar.calendars SET last_synced_at = $1, ctag = $2 WHERE id = $3",
            params![Utc::now(), sync::new_tag(), calendar_id],
        )
        .await?;

        Ok((imported, updated, removed))
    }

    /// Background pass: refresh every subscription calendar (called hourly).
    pub async fn sync_all(db: &DbPool) {
        let subs: Vec<(Uuid, Uuid, String)> = match db
            .fetch_all_as(
                "SELECT id, owner_id, subscription_url
                   FROM calendar.calendars
                  WHERE subscription_url IS NOT NULL",
                params![],
            )
            .await
        {
            Ok(rows) => rows,
            Err(e) => {
                tracing::error!(error = %e, "Lecture des abonnements pour la synchro périodique");
                return;
            }
        };

        for (id, owner, url) in subs {
            if let Err(e) = Self::sync(id, owner, &url, db).await {
                tracing::warn!(calendar = %id, error = %e, "Synchro périodique d'abonnement échouée");
            }
        }
    }
}

/// Tiny stable content hash (FNV-1a) — only used to derive UIDs for feed events
/// that carry none; no cryptographic strength needed.
fn md5_like(s: &str) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in s.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}
