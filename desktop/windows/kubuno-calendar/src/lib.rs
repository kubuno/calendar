//! Kubuno Calendar for Windows — the Win32 window of the Calendar module's desktop app, written like a Windows
//! Forms application, over the portable app of desktop/common (`kubuno-calendar-desktop-common`: the launch
//! options, the view state, the sample data) and the shared engine (`kubuno-calendar-core`, common/core: the
//! model, the month grid and the layout math).
//!
//! The library holds everything the Visual Studio designer links to render the views:
//!
//! - `views/` — the main form [`CalendarWindow`] with its navigation toolbar;
//! - `controls/` — the custom-drawn control [`MonthGrid`] and the model it shares with the window;
//! - `platform/` — the Windows overrides of the common extension points (the local clock and zone offset).

pub mod controls;
pub mod platform;
pub mod views;
mod windows_ui;

pub use controls::agenda_list::AgendaList;
pub use controls::month_grid::MonthGrid;
pub use controls::time_grid::TimeGrid;
pub use views::calendar_window::CalendarWindow;
pub use windows_ui::WindowsUi;

// `Resources::app_title()`… — the strings of `resources/resources.kbres` (neutral English) and
// `resources/resources.fr.kbres`, in the current UI culture; `{Res key}` in the views.
kubuno_desktop::resources!(pub Resources, "resources/resources.kbres");
