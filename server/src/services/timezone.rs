//! Which time zone a calendar is stamped with the day it is created.
//!
//! The rule is: the zone of the person creating it, and the instance's setting
//! only when that person's is unknown. An organisation whose accounts are spread
//! over several countries is the normal case, not the exception, and a calendar
//! born in the head office's zone is wrong for everyone outside it.
//!
//! ## Where the creator's zone comes from
//!
//! Nowhere on the server, today. The core stores no per-account time zone — its
//! own `instance.timezone` setting is declared `global` for exactly that stated
//! reason — and its internal directory projection (`/internal/directory/users`)
//! deliberately carries no personal field. The module's per-user settings hold a
//! SECONDARY zone (a second hour column in the day and week views), never a
//! primary one: every screen of this module already reads the primary zone from
//! the browser (`Intl.DateTimeFormat().resolvedOptions().timeZone`).
//!
//! So the browser is the only holder of that fact, and it hands it over with the
//! creation request rather than a second copy being invented on the server. That
//! makes it client input, which is why nothing here trusts it: it is accepted
//! only if it names a zone of the IANA database this build carries, and it is
//! used for nothing but this one field.

use std::str::FromStr;

/// Used when neither the creator's zone nor the instance's is usable. Universal
/// time is the only answer that is defensible without knowing anything.
const LAST_RESORT: &str = "UTC";

/// The longest string worth even looking at. IANA identifiers are far shorter;
/// this only stops a caller from making the server hash a megabyte.
pub const MAX_TIMEZONE_LEN: usize = 64;

/// Whether `tz` names a zone of the IANA database compiled into this build.
///
/// The comparison is the tz database's own, not a hand-written pattern: a regex
/// over `Region/City` would accept `Europe/Atlantis` and reject `UTC`.
pub fn is_iana_timezone(tz: &str) -> bool {
    chrono_tz::Tz::from_str(tz).is_ok()
}

/// The time zone to stamp on a new calendar.
///
/// `requested` is what the creator's client reported; `instance_default` is the
/// administrator's setting, which acts as a FALLBACK and never as an override.
///
/// An unusable `requested` falls back rather than refusing. The only writer of
/// that field is a browser stating where its user is, and a zone name this
/// build's tz database has not heard of yet (the database gains entries every
/// year) would otherwise cost that user the ability to create a calendar at all
/// — a hard failure for a field they never typed. It is logged, so an operator
/// sees a stale database instead of nothing, and the value never reaches storage
/// unchecked, which was the risk worth guarding against: this string is later
/// read back as a `TZID` and used for date arithmetic.
pub fn resolve_new_calendar_timezone(requested: Option<&str>, instance_default: &str) -> String {
    if let Some(tz) = requested
        .map(str::trim)
        .filter(|s| !s.is_empty() && s.len() <= MAX_TIMEZONE_LEN)
    {
        if is_iana_timezone(tz) {
            return tz.to_string();
        }
        tracing::warn!(
            timezone = %tz,
            "Fuseau horaire inconnu annoncé à la création d'un agenda — repli sur celui de l'instance"
        );
    }

    let fallback = instance_default.trim();
    if is_iana_timezone(fallback) {
        return fallback.to_string();
    }

    tracing::warn!(
        timezone = %fallback,
        "Fuseau horaire d'instance inutilisable — repli sur UTC"
    );
    LAST_RESORT.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_creators_zone_wins_over_the_instances() {
        assert_eq!(
            resolve_new_calendar_timezone(Some("America/New_York"), "Europe/Paris"),
            "America/New_York"
        );
        // Including when the two happen to agree — no special case there.
        assert_eq!(
            resolve_new_calendar_timezone(Some("Europe/Paris"), "Europe/Paris"),
            "Europe/Paris"
        );
    }

    #[test]
    fn surrounding_whitespace_is_not_a_different_zone() {
        assert_eq!(
            resolve_new_calendar_timezone(Some("  Asia/Tokyo  "), "Europe/Paris"),
            "Asia/Tokyo"
        );
    }

    #[test]
    fn without_a_creators_zone_the_instance_setting_applies() {
        assert_eq!(
            resolve_new_calendar_timezone(None, "Africa/Douala"),
            "Africa/Douala"
        );
        // A client that sends the field empty said nothing, not "no zone".
        assert_eq!(resolve_new_calendar_timezone(Some(""), "Africa/Douala"), "Africa/Douala");
        assert_eq!(resolve_new_calendar_timezone(Some("   "), "Africa/Douala"), "Africa/Douala");
    }

    #[test]
    fn a_value_that_is_not_a_zone_falls_back_instead_of_being_stored() {
        // Shapes that a naive check would let through: a plausible-looking pair
        // of segments, an offset, a display name, an injection attempt.
        for bogus in [
            "Europe/Atlantis",
            "GMT+2",
            "Heure d'été d'Europe centrale",
            "'; DROP TABLE calendar.calendars; --",
        ] {
            assert_eq!(
                resolve_new_calendar_timezone(Some(bogus), "Europe/Paris"),
                "Europe/Paris",
                "{bogus} ne doit jamais être retenu"
            );
        }
    }

    #[test]
    fn an_overlong_value_is_ignored_without_being_parsed() {
        let huge = "Europe/".to_string() + &"a".repeat(MAX_TIMEZONE_LEN);
        assert_eq!(resolve_new_calendar_timezone(Some(&huge), "Europe/Paris"), "Europe/Paris");
    }

    #[test]
    fn an_unusable_instance_setting_ends_at_universal_time() {
        assert_eq!(resolve_new_calendar_timezone(None, "Europe/Atlantis"), "UTC");
        assert_eq!(resolve_new_calendar_timezone(None, ""), "UTC");
        // The creator's zone still wins over a broken instance setting.
        assert_eq!(resolve_new_calendar_timezone(Some("Asia/Dubai"), ""), "Asia/Dubai");
    }

    #[test]
    fn utc_is_a_zone_like_any_other() {
        assert!(is_iana_timezone("UTC"));
        assert!(is_iana_timezone("Europe/Paris"));
        assert!(!is_iana_timezone(""));
        assert!(!is_iana_timezone("Local"));
    }
}
