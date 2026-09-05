//! Instance-wide settings of the calendar module, as the administrator left them
//! in the console.
//!
//! Declared by `module.toml`'s `[[settings]]`, stored in `core.settings`, and read
//! back here through `/internal/modules/calendar/settings` — a module owns its own
//! schema and cannot read the core's tables, and a background worker has no user
//! token for the public config route. The module is named in the URL so the read
//! works whether the instance shares one master secret or a derived one per
//! module.
//!
//! Every field here is read by code that acts on it: a knob that changes nothing
//! is worse than an absent one. The list of the instance's own domain names is
//! carried alongside because the guest policy needs it and the core is the only
//! authority on "is this address ours?" (`/internal/domains`).

use serde_json::Value;

/// How much a public calendar feed discloses.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PublicDetail {
    /// Titles, descriptions and locations, as the owner wrote them.
    Full,
    /// Busy slots only: every entry is anonymised before it leaves the instance.
    BusyOnly,
}

/// Whose busy times a user may cross-reference when looking for a common slot.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FreeBusyVisibility {
    /// Anyone in the instance sees anyone's busy slots (never their details).
    Everyone,
    /// Only the people who actually shared a calendar with the caller.
    SharedOnly,
}

#[derive(Debug, Clone)]
pub struct InstanceConfig {
    /// Timezone stamped on a calendar created without an explicit one.
    pub default_timezone: String,
    /// Whether a user may publish a calendar (public `.ics` feed) at all.
    pub allow_public_calendars: bool,
    /// How much a published feed discloses.
    pub public_calendar_detail: PublicDetail,
    /// Whether a guest whose address is not one of the instance's may be invited.
    pub allow_external_guests: bool,
    /// Whether the composer warns before adding such a guest (when allowed).
    pub warn_external_guests: bool,
    /// Whether the server asks the Mail module to send invitation e-mails when a
    /// meeting with guests is created, updated or cancelled. Off, guests are
    /// still recorded but no mail leaves the instance.
    pub send_email_invitations: bool,
    /// Whose busy times feed the common-slot finder.
    pub internal_free_busy: FreeBusyVisibility,
    /// Ceiling on the number of guests of a single event. `0` = no ceiling, and
    /// that is the shipped value: a limit nobody asked for is an outage, so the
    /// administrator names one or none is applied.
    pub max_event_guests: i64,
    /// Ceiling on the number of calendars one account may own. `0` = no ceiling.
    /// The automatic default calendar is never refused by it.
    pub max_calendars_per_user: i64,
    /// Whether users may mirror a remote `.ics` feed (outbound fetch).
    pub allow_calendar_subscriptions: bool,
    /// Whether users may publish bookable appointment schedules.
    pub allow_appointment_schedules: bool,
    /// Days a finished event is kept before the cleaner purges it. `0` = never.
    pub event_retention_days: i64,
    /// Whether users may set a daily working location on their calendar.
    pub allow_working_location: bool,
    /// The instance's own domain names, lowercase, as declared in the console.
    /// Empty when none is declared yet — the guest policy then falls back to the
    /// directory, never to "everyone is external".
    pub internal_domains: Vec<String>,
}

impl Default for InstanceConfig {
    fn default() -> Self {
        Self {
            default_timezone:            "Europe/Paris".to_string(),
            allow_public_calendars:      true,
            public_calendar_detail:      PublicDetail::Full,
            allow_external_guests:       true,
            warn_external_guests:        true,
            send_email_invitations:      true,
            internal_free_busy:          FreeBusyVisibility::Everyone,
            max_event_guests:            0,
            max_calendars_per_user:      0,
            allow_calendar_subscriptions: true,
            allow_appointment_schedules: true,
            event_retention_days:        0,
            allow_working_location:      true,
            internal_domains:            Vec::new(),
        }
    }
}

impl InstanceConfig {
    /// Maps the core's `{key: value}` object onto the struct. Every read falls
    /// back to the compiled default rather than to a permissive value; an
    /// out-of-range number is treated as a mistake and ignored the same way.
    /// `0` is a MEANINGFUL value for the three ceilings (no ceiling / never), so
    /// it is accepted there rather than floored away.
    pub fn from_settings(settings: &Value) -> Self {
        let d = Self::default();
        let int_in = |key: &str, min: i64, max: i64, fallback: i64| -> i64 {
            settings
                .get(key)
                .and_then(Value::as_i64)
                .filter(|n| (min..=max).contains(n))
                .unwrap_or(fallback)
        };
        let bool_of = |key: &str, fallback: bool| {
            settings.get(key).and_then(Value::as_bool).unwrap_or(fallback)
        };
        let str_of = |key: &str| settings.get(key).and_then(Value::as_str);

        Self {
            default_timezone: str_of("default_timezone")
                .filter(|s| !s.trim().is_empty())
                .map(str::to_string)
                .unwrap_or(d.default_timezone),
            allow_public_calendars: bool_of("allow_public_calendars", d.allow_public_calendars),
            public_calendar_detail: match str_of("public_calendar_detail") {
                Some("busy") => PublicDetail::BusyOnly,
                Some("full") => PublicDetail::Full,
                _            => d.public_calendar_detail,
            },
            allow_external_guests: bool_of("allow_external_guests", d.allow_external_guests),
            warn_external_guests:  bool_of("warn_external_guests",  d.warn_external_guests),
            send_email_invitations: bool_of("send_email_invitations", d.send_email_invitations),
            internal_free_busy: match str_of("internal_free_busy") {
                Some("shared_only") => FreeBusyVisibility::SharedOnly,
                Some("everyone")    => FreeBusyVisibility::Everyone,
                _                   => d.internal_free_busy,
            },
            max_event_guests:       int_in("max_event_guests", 0, 100_000, d.max_event_guests),
            max_calendars_per_user: int_in("max_calendars_per_user", 0, 10_000, d.max_calendars_per_user),
            allow_calendar_subscriptions: bool_of(
                "allow_calendar_subscriptions", d.allow_calendar_subscriptions,
            ),
            allow_appointment_schedules: bool_of(
                "allow_appointment_schedules", d.allow_appointment_schedules,
            ),
            event_retention_days: int_in("event_retention_days", 0, 3650, d.event_retention_days),
            allow_working_location: bool_of("allow_working_location", d.allow_working_location),
            // Filled by `fetch`, not by the settings payload.
            internal_domains: d.internal_domains,
        }
    }

    /// The domain part of an address, lowercased. `None` when the address has no
    /// single `@` — such a string is never treated as one of ours.
    fn domain_of(email: &str) -> Option<String> {
        let mut parts = email.rsplitn(2, '@');
        let domain = parts.next()?.trim().to_ascii_lowercase();
        // `rsplitn` yields the local part second; its absence means there was no
        // '@' at all, and an empty domain is just as unusable.
        parts.next()?;
        if domain.is_empty() { None } else { Some(domain) }
    }

    /// Whether this address belongs to one of the instance's declared domains.
    ///
    /// This is the cheap half of the guest test: it needs no network and answers
    /// for every address of a declared domain, including accounts that do not
    /// exist yet. The directory lookup in [`guest_is_internal`] covers the rest.
    pub fn domain_is_internal(&self, email: &str) -> bool {
        match Self::domain_of(email) {
            Some(domain) => self.internal_domains.contains(&domain),
            None => false,
        }
    }
}

/// Reads the instance settings from the core, then completes them with the
/// instance's declared domains. Any failure yields `None`, so the caller keeps
/// the values it already had rather than reverting to defaults because the core
/// was briefly unreachable.
pub async fn fetch(http: &reqwest::Client, core_url: &str, secret: &str) -> Option<InstanceConfig> {
    let url = format!("{core_url}/internal/modules/calendar/settings");
    let resp = http
        .get(&url)
        .header("X-Internal-Secret", secret)
        .send()
        .await
        .map_err(|e| tracing::warn!(error = %e, "Lecture des réglages d'instance calendar"))
        .ok()?;

    if !resp.status().is_success() {
        tracing::warn!(status = %resp.status(), "Réglages d'instance calendar refusés par le core");
        return None;
    }

    let body: Value = resp
        .json()
        .await
        .map_err(|e| tracing::warn!(error = %e, "Réglages d'instance calendar : réponse illisible"))
        .ok()?;

    let mut config = InstanceConfig::from_settings(body.get("settings")?);
    config.internal_domains = fetch_domains(http, core_url, secret).await;
    Some(config)
}

/// The instance's own domain names, lowercase. An unreachable or unreadable
/// answer yields an empty list: the caller then leans on the directory rather
/// than declaring every address foreign.
async fn fetch_domains(http: &reqwest::Client, core_url: &str, secret: &str) -> Vec<String> {
    let url = format!("{core_url}/internal/domains");
    let Ok(resp) = http
        .get(&url)
        .header("X-Internal-Secret", secret)
        .send()
        .await
        .map_err(|e| tracing::warn!(error = %e, "Lecture des domaines de l'instance"))
    else {
        return Vec::new();
    };

    if !resp.status().is_success() {
        tracing::warn!(status = %resp.status(), "Domaines de l'instance refusés par le core");
        return Vec::new();
    }

    let Ok(body) = resp
        .json::<Value>()
        .await
        .map_err(|e| tracing::warn!(error = %e, "Domaines de l'instance : réponse illisible"))
    else {
        return Vec::new();
    };

    body.get("domains")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|d| d.get("name").and_then(Value::as_str))
                .map(|n| n.trim().to_ascii_lowercase())
                .filter(|n| !n.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

/// Asks the core's directory whether this address belongs to an account.
///
/// Used only when the domain test already said "not ours": a guest on an
/// undeclared domain may still be a colleague on an instance that has not
/// finished declaring its names. `None` means the question could not be
/// answered — the caller decides what to do with an unknown, and the invitation
/// guard refuses rather than guessing.
pub async fn directory_knows_email(
    http: &reqwest::Client,
    core_url: &str,
    secret: &str,
    email: &str,
) -> Option<bool> {
    let url = format!("{core_url}/internal/directory/users");
    let resp = http
        .get(&url)
        .query(&[("q", email), ("limit", "10")])
        .header("X-Internal-Secret", secret)
        .send()
        .await
        .map_err(|e| tracing::warn!(error = %e, "Annuaire : recherche d'une adresse"))
        .ok()?;

    if !resp.status().is_success() {
        tracing::warn!(status = %resp.status(), "Annuaire : recherche refusée par le core");
        return None;
    }

    let body: Value = resp
        .json()
        .await
        .map_err(|e| tracing::warn!(error = %e, "Annuaire : réponse illisible"))
        .ok()?;

    let needle = email.trim().to_ascii_lowercase();
    // The directory matches loosely (ILIKE '%…%'), so the comparison here is the
    // strict one: a substring hit must not pass for the address itself.
    Some(
        body.get("users")
            .and_then(Value::as_array)
            .map(|users| {
                users.iter().any(|u| {
                    u.get("email")
                        .and_then(Value::as_str)
                        .map(|e| e.trim().to_ascii_lowercase() == needle)
                        .unwrap_or(false)
                })
            })
            .unwrap_or(false),
    )
}

/// Resolves an address to the id of the instance account that owns it, exactly.
///
/// Shares the directory endpoint with [`directory_knows_email`], but returns the
/// matching user's `id` so an attendee row can be linked to the account (which is
/// what lets an invited user see the event in their own calendar). `None` when
/// the address belongs to no account, the lookup failed, or the answer was
/// unreadable — the caller then leaves `user_id` NULL (an external guest).
pub async fn directory_user_id(
    http: &reqwest::Client,
    core_url: &str,
    secret: &str,
    email: &str,
) -> Option<uuid::Uuid> {
    let url = format!("{core_url}/internal/directory/users");
    let resp = http
        .get(&url)
        .query(&[("q", email), ("limit", "10")])
        .header("X-Internal-Secret", secret)
        .send()
        .await
        .map_err(|e| tracing::warn!(error = %e, "Annuaire : résolution d'un identifiant"))
        .ok()?;

    if !resp.status().is_success() {
        tracing::warn!(status = %resp.status(), "Annuaire : résolution refusée par le core");
        return None;
    }

    let body: Value = resp
        .json()
        .await
        .map_err(|e| tracing::warn!(error = %e, "Annuaire : réponse illisible"))
        .ok()?;

    let needle = email.trim().to_ascii_lowercase();
    // The directory matches loosely (ILIKE '%…%'); keep only the exact address
    // and read its id back.
    body.get("users").and_then(Value::as_array).and_then(|users| {
        users.iter().find_map(|u| {
            let matches = u
                .get("email")
                .and_then(Value::as_str)
                .map(|e| e.trim().to_ascii_lowercase() == needle)
                .unwrap_or(false);
            if !matches {
                return None;
            }
            u.get("id")
                .and_then(Value::as_str)
                .and_then(|s| uuid::Uuid::parse_str(s).ok())
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn missing_keys_keep_the_compiled_defaults() {
        let c = InstanceConfig::from_settings(&json!({}));
        assert_eq!(c.default_timezone, "Europe/Paris");
        assert!(c.allow_public_calendars);
        // No ceiling unless an administrator names one.
        assert_eq!(c.max_event_guests, 0);
        assert_eq!(c.public_calendar_detail, PublicDetail::Full);
    }

    #[test]
    fn zero_means_no_ceiling() {
        let c = InstanceConfig::from_settings(&json!({ "max_event_guests": 0 }));
        assert_eq!(c.max_event_guests, 0);
        // An administrator who names a ceiling gets exactly that one.
        let c = InstanceConfig::from_settings(&json!({ "max_event_guests": 200 }));
        assert_eq!(c.max_event_guests, 200);
    }

    #[test]
    fn out_of_range_number_falls_back_to_default() {
        let c = InstanceConfig::from_settings(&json!({ "event_retention_days": -1 }));
        assert_eq!(c.event_retention_days, 0);
        let c = InstanceConfig::from_settings(&json!({ "max_calendars_per_user": 99_999_999 }));
        assert_eq!(c.max_calendars_per_user, 0);
    }

    #[test]
    fn unknown_enum_member_falls_back_to_default() {
        let c = InstanceConfig::from_settings(&json!({
            "public_calendar_detail": "whatever",
            "internal_free_busy":     "shared_only",
        }));
        assert_eq!(c.public_calendar_detail, PublicDetail::Full);
        assert_eq!(c.internal_free_busy, FreeBusyVisibility::SharedOnly);
    }

    #[test]
    fn domain_test_is_case_insensitive_and_exact() {
        let c = InstanceConfig {
            internal_domains: vec!["kubuno.local".into()],
            ..InstanceConfig::default()
        };
        assert!(c.domain_is_internal("Admin@Kubuno.Local"));
        assert!(!c.domain_is_internal("admin@notkubuno.local"));
        assert!(!c.domain_is_internal("kubuno.local"));
        assert!(!c.domain_is_internal(""));
    }
}
