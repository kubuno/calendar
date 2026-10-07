use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct Attendee {
    pub id:              Uuid,
    pub event_id:        Uuid,
    pub user_id:         Option<Uuid>,
    /// The room this attendee IS, when it is a room rather than a person
    /// (migration `000010`). Points at `core.resources`, which the core
    /// publishes read-only on `/internal/directory/resources` — no foreign key,
    /// because the directory belongs to another component. A room carries no
    /// address, so exactly one of `email` and `resource_id` is set.
    pub resource_id:     Option<Uuid>,
    pub email:           Option<String>,
    pub display_name:    Option<String>,
    pub status:          String,
    pub is_organizer:    bool,
    pub rsvp_token:      Option<String>,
    pub rsvp_expires_at: Option<DateTime<Utc>>,
    pub invited_at:      DateTime<Utc>,
    pub responded_at:    Option<DateTime<Utc>>,
    pub comment:         Option<String>,
    /// When this room was given back automatically because the meeting emptied
    /// out (migration `000011`). `NULL` for a room that refused a clash, and for
    /// every person — a person is not released, they decline.
    pub released_at:     Option<DateTime<Utc>>,
    /// Welcome, not required (migration `000012`). Distinct from a refusal: an
    /// optional guest who stays away has declined nothing, and the organiser
    /// reading the replies should not have to guess which absences matter.
    #[serde(default)]
    pub optional:        bool,
    /// Event `SEQUENCE` at which this attendee was last notified (the invitation
    /// the Mail module sent). Used to reject RSVP replies that answer a
    /// superseded invitation. `None` until a first invitation is sent.
    pub last_notified_sequence: Option<i32>,
}

#[derive(Debug, Deserialize, validator::Validate)]
pub struct InviteAttendeeDto {
    /// The address, when the caller knows one. Empty when the guest was picked
    /// from the directory: see `user_id`.
    #[serde(default)]
    pub email:        String,
    /// An ACCOUNT of this instance, picked from the people list. The server
    /// resolves it to an address over the internal channel — a directory that
    /// keeps addresses private must still be usable to invite someone.
    pub user_id:      Option<uuid::Uuid>,
    pub display_name: Option<String>,
    /// Welcome, not required. Absent means required, which is what an
    /// invitation means unless it says otherwise.
    #[serde(default)]
    pub optional:     bool,
}

/// One guest supplied inline when an event is created (see `CreateEventDto`).
/// The organizer never appears here — the server adds their own attendee row.
#[derive(Debug, Clone, Deserialize, validator::Validate)]
pub struct AttendeeInputDto {
    #[serde(default)]
    pub email:        String,
    /// Same as `InviteAttendeeDto::user_id`: a guest chosen by account.
    pub user_id:      Option<uuid::Uuid>,
    pub display_name: Option<String>,
    #[serde(default)]
    pub optional:     bool,
}

#[derive(Debug, Deserialize)]
pub struct RsvpDto {
    #[serde(default)]
    pub status:  String,
    pub comment: Option<String>,
    /// Set by the HOST to mark this guest welcome-but-not-required. Present
    /// alone: it is not an answer, so it does not carry a status with it.
    pub optional: Option<bool>,
}

/// `Toto <toto@toto.com>` → `("toto@toto.com", Some("Toto"))`.
///
/// The form people actually paste: it is what every mail client copies, what an
/// address book exports, and what a colleague sends you in a message. Stored
/// verbatim it becomes an address nobody can write to and a name nobody can
/// read — so it is understood HERE, where the address lands, rather than in each
/// form. An import, a script or another client gets the same treatment as the
/// guest field.
///
/// Anything that is not that shape comes back untouched: a bare address, or
/// something malformed the caller should see refused rather than mangled.
pub fn parse_address(raw: &str) -> (String, Option<String>) {
    let s = raw.trim();
    let Some(open) = s.rfind('<') else { return (s.to_string(), None) };
    if !s.ends_with('>') {
        return (s.to_string(), None);
    }
    let email = s[open + 1..s.len() - 1].trim();
    if !email.contains('@') {
        return (s.to_string(), None);
    }
    // The display part, unquoted: `"Toto" <…>` is as common as `Toto <…>`.
    let name = s[..open].trim().trim_matches('"').trim();
    (
        email.to_string(),
        if name.is_empty() { None } else { Some(name.to_string()) },
    )
}

#[cfg(test)]
mod address_tests {
    use super::parse_address;

    #[test]
    fn splits_the_common_forms() {
        assert_eq!(parse_address("Toto <toto@toto.com>"),
                   ("toto@toto.com".into(), Some("Toto".into())));
        assert_eq!(parse_address("  \"Irène T.\"  <i@ex.org>  "),
                   ("i@ex.org".into(), Some("Irène T.".into())));
        assert_eq!(parse_address("<seul@ex.org>"), ("seul@ex.org".into(), None));
    }

    #[test]
    fn leaves_everything_else_alone() {
        // A bare address is already the answer.
        assert_eq!(parse_address("nu@ex.org"), ("nu@ex.org".into(), None));
        // Malformed: refused later by the address check, not mangled here.
        assert_eq!(parse_address("Toto <pas-une-adresse>"),
                   ("Toto <pas-une-adresse>".into(), None));
        assert_eq!(parse_address("Toto <toto@ex.org"), ("Toto <toto@ex.org".into(), None));
        // A name that happens to contain '<' must not confuse the split.
        assert_eq!(parse_address("a<b <c@ex.org>"), ("c@ex.org".into(), Some("a<b".into())));
    }
}
