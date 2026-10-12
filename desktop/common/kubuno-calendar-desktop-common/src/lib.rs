//! # Kubuno Calendar — the portable app (`desktop/common`)
//!
//! The complete Kubuno Calendar desktop app that does not depend on an operating system: the launch options
//! ([`app::Options`]), the calendar view state ([`state::CalendarView`]), the offline sample dataset
//! ([`sample`]) and the platform extension points ([`platform`]). The native window lives in `desktop/windows`;
//! it registers its [`platform::Platform`] and runs this app through [`app::run`].
//!
//! Framework- and OS-free on purpose, so it builds for every target and its logic is unit-tested without a
//! window. The calendar engine is the shared core [`kubuno_calendar_core`].

pub mod app;
pub mod live;
pub mod platform;
pub mod sample;
pub mod state;

pub use app::{run, Options, TextUi, PROGRAM};
pub use platform::{Platform, UiHost};
pub use state::{CalendarView, ViewMode};
