//! Starting the app: what every OS entry point does, in one place.
//!
//! An entry point (`desktop/windows/kubuno-calendar`, later `desktop/linux/…`, `desktop/macos/…`) is a few
//! lines: it builds its [`Platform`](crate::platform::Platform) and its [`UiHost`](crate::platform::UiHost) and
//! calls [`run`].
//!
//! `kubuno-calendar [--dark] [--culture fr|en] [--view month|week|day|year|schedule] [--date yyyy-mm-dd]
//!  [--sample | --live]`
//!
//! The live-server path (`--live`, the shell's token broker, `listEvents` over the window) is a later
//! increment; for now the app renders the offline sample dataset (`crate::sample`).

use kubuno_calendar_core::date::{Date, Lang};
use kubuno_calendar_core::model::{Calendar, EventInstance};

use crate::platform::{self, Platform, UiHost};
use crate::state::{CalendarView, ViewMode};

/// The program's name, as the shell's token broker and the logs know it.
pub const PROGRAM: &str = "kubuno-calendar";

/// How the app starts (its command line).
#[derive(Debug, Clone, Default)]
pub struct Options {
    /// `--dark`: the dark theme.
    pub dark: bool,
    /// `--culture fr|en`: the UI language (else French).
    pub culture: Option<String>,
    /// `--view month|week|day|year|schedule|custom`: the view to open.
    pub view: Option<String>,
    /// `--date yyyy-mm-dd`: the date to anchor on (else today).
    pub date: Option<String>,
    /// Render the offline sample dataset (the default until the live path lands).
    pub sample: bool,
}

impl Options {
    /// The options of this process, read with the registered platform's rules.
    pub fn from_args() -> Self {
        let args: Vec<String> = std::env::args().collect();
        Self { sample: platform::current().launch.sample_requested(&args), ..Self::parse(args.into_iter().skip(1)) }
    }

    /// Parses the arguments, program name excluded. Unknown `--options` are ignored.
    pub fn parse(args: impl IntoIterator<Item = String>) -> Self {
        let mut options = Options::default();
        let mut args = args.into_iter();
        while let Some(a) = args.next() {
            match a.as_str() {
                "--dark" => options.dark = true,
                "--culture" => options.culture = args.next(),
                "--view" => options.view = args.next(),
                "--date" => options.date = args.next(),
                "--sample" => options.sample = true,
                _ => {}
            }
        }
        options
    }

    /// The UI language.
    pub fn lang(&self) -> Lang {
        Lang::from_tag(self.culture.as_deref().unwrap_or("fr"))
    }

    /// The view to open (`month` by default).
    pub fn view_mode(&self) -> ViewMode {
        self.view.as_deref().map(ViewMode::from_tag).unwrap_or(ViewMode::Month)
    }

    /// The initial calendar state (anchored on `--date` or today).
    pub fn initial_state(&self) -> CalendarView {
        let today = platform::current().clock.today();
        let mut v = CalendarView::new(today, self.view_mode(), self.lang());
        if let Some(d) = self.date.as_deref().and_then(Date::parse) {
            v.current = d;
        }
        v
    }

    /// The dataset to show. Live loading is a later increment, so this is the sample for now.
    pub fn dataset(&self) -> (Vec<Calendar>, Vec<EventInstance>) {
        (crate::sample::calendars(), crate::sample::events())
    }
}

/// Registers `platform`, reads the command line, and runs `ui` until it closes; returns the exit code.
pub fn run(platform: Platform, ui: &dyn UiHost) -> i32 {
    let name = platform.name;
    if !platform::install(platform) {
        tracing::warn!("[calendar] a platform was already registered; `{name}` is ignored");
    }
    let options = Options::from_args();
    ui.run(&options)
}

/// The portable user interface: the current view as text. What the app shows on a system without a native
/// window yet, and what tests run.
#[derive(Debug, Default, Clone, Copy)]
pub struct TextUi;

impl TextUi {
    /// A plain-text month grid driven by the shared core — proof the core lays the view out without a window.
    pub fn render_month(state: &CalendarView, events: &[EventInstance], offset_minutes: i32) -> Vec<String> {
        use kubuno_calendar_core::layout::{layout_banners, month_grid, timed_events_for_day};
        let mut lines = vec![format!("Kubuno Calendar — {}", state.title())];
        let grid = month_grid(state.current, state.week_starts_on);
        for week in grid.chunks(7) {
            let banners = layout_banners(events, week, offset_minutes);
            let mut cells = Vec::new();
            for &day in week {
                let chips = timed_events_for_day(events, day, offset_minutes);
                let mark = if day == state.today { "*" } else { " " };
                cells.push(format!("{}{:>2}({})", mark, day.day, chips.len()));
            }
            lines.push(cells.join(" | "));
            if banners.rows > 0 {
                lines.push(format!("    banners: {} in {} row(s)", banners.segs.len(), banners.rows));
            }
        }
        lines
    }
}

impl UiHost for TextUi {
    fn run(&self, options: &Options) -> i32 {
        let state = options.initial_state();
        let (_calendars, events) = options.dataset();
        let offset = platform::current().clock.utc_offset_minutes();
        for line in TextUi::render_month(&state, &events, offset) {
            println!("{line}");
        }
        0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_line() {
        let o = Options::parse(["--dark", "--culture", "en", "--view", "week", "--date", "2026-10-12"].map(String::from));
        assert!(o.dark);
        assert_eq!(o.lang(), Lang::En);
        assert_eq!(o.view_mode(), ViewMode::Week);
        assert_eq!(o.initial_state().current, Date::new(2026, 10, 12).expect("d"));
    }

    #[test]
    fn text_month_uses_the_core() {
        let state = CalendarView::new(Date::new(2026, 10, 12).expect("d"), ViewMode::Month, Lang::Fr);
        let lines = TextUi::render_month(&state, &crate::sample::events(), 0);
        assert!(lines[0].contains("Octobre 2026"));
        // The multi-day Conference banner spans a week boundary → a banner line appears in more than one week.
        assert!(lines.iter().filter(|l| l.contains("banners:")).count() >= 2);
        // Today (the 12th) is marked.
        assert!(lines.iter().any(|l| l.contains("*12(")));
    }
}
