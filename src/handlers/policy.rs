//! What the instance allows, as the interface needs to know it.
//!
//! The module's own settings route (`/modules/calendar/config`, served by the
//! core) hides instance-scoped settings from anyone without the settings
//! privilege — rightly so, it is the administration console's data. But the
//! composer still has to know that publishing a calendar is closed, or that a
//! guest is a stranger, and it must know it for ORDINARY accounts. So the module
//! publishes the handful of decisions its own screens act on, and nothing else:
//! no value an administrator sets is echoed back beyond what the user is about
//! to be told anyway ("this is disabled", "this address is external").
//!
//! The domain list travels with them because it is the only way the composer can
//! label a guest external without asking the server per keystroke; the core's
//! `/internal/domains` is its source, and those names are already visible to
//! every user in their own address.

use axum::{extract::State, Extension, Json};

use crate::{errors::Result, middleware::CalendarUser, state::AppState};

pub async fn instance_policy(
    State(state): State<AppState>,
    Extension(_user): Extension<CalendarUser>,
) -> Result<Json<serde_json::Value>> {
    let c = state.instance();
    Ok(Json(serde_json::json!({
        "allow_public_calendars":       c.allow_public_calendars,
        "allow_external_guests":        c.allow_external_guests,
        "warn_external_guests":         c.warn_external_guests,
        "allow_calendar_subscriptions": c.allow_calendar_subscriptions,
        "allow_appointment_schedules":  c.allow_appointment_schedules,
        "allow_working_location":       c.allow_working_location,
        "max_event_guests":             c.max_event_guests,
        "internal_domains":             c.internal_domains,
    })))
}
