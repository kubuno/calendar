//! # Kubuno Calendar — shared core (sans-IO)
//!
//! The platform-neutral calendar model and the pure algorithms ported from the web app
//! (`Z:\src\calendar\web\src`), so the desktop app, the mobile app and the server-held web client all compute
//! the same results. There is **no occurrence expansion** here: the Kubuno Calendar server expands recurring
//! series over the requested window (the `rrule` crate, `server/src/services/recurrence_service.rs`) and
//! returns ready [`model::EventInstance`]s — web, desktop and mobile all receive expanded instances, so this
//! crate ports only the recurrence logic the web itself has (parse / build / humanize an RRULE).
//!
//! Modules:
//! - [`date`] — civil dates, the week/month boundaries and the `Intl`-shaped display formats.
//! - [`model`] — the `Calendar` / `EventInstance` data model and the local wall-clock reading of an instant.
//! - [`rrule`] — RRULE presets, the custom-recurrence round trip and the French humanizer.
//! - [`layout`] — the month grid, the day/week overlap columns and the all-day banner stacking.
//! - [`moon`] — the synodic moon-phase computation.
//! - [`colors`] — the fixed calendar / event colour tokens.
//!
//! Sans-IO: no network, database, file system, clock, async runtime, UI or C library. Every function takes its
//! inputs (including the viewer's time-zone offset and « today ») from the caller.

pub mod colors;
pub mod date;
pub mod layout;
pub mod model;
pub mod moon;
pub mod rrule;

pub use date::{Date, Lang};
pub use model::{Calendar, EventInstance, EventReminder, Instant, LocalDateTime};
