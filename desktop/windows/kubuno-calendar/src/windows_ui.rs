//! The Windows user interface of desktop/common's app ([`UiHost`]): the splash screen, then
//! `Application::run(CalendarWindow)`.

use kubuno_calendar_desktop_common::app::Options;
use kubuno_calendar_desktop_common::platform::UiHost;

use crate::CalendarWindow;

/// The Win32 window painted with Direct2D.
#[derive(Debug, Default, Clone, Copy)]
pub struct WindowsUi;

impl UiHost for WindowsUi {
    fn run(&self, options: &Options) -> i32 {
        match run_window(options.clone()) {
            Ok(()) => 0,
            Err(e) => {
                kubuno_desktop::tracing::error!("[calendar] {e:?}");
                1
            }
        }
    }
}

fn run_window(options: Options) -> kubuno_desktop::Result {
    kubuno_desktop::ui::diagnostics::set_display_name("Kubuno Calendar");
    if let Some(culture) = &options.culture {
        kubuno_desktop::resources::set_culture(culture);
    }
    if options.dark {
        kubuno_desktop::Application::set_theme(kubuno_desktop::ui::Theme::dark());
    }
    let window = CalendarWindow::new(options);
    kubuno_desktop::Application::run(window)
}
