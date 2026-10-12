//! Code-behind of Kubuno Calendar's window (`calendar_window.kbview`) — Windows Forms' `Form1.cs`.
//!
//! The window owns the shared model (the calendars, the events and the view state, `controls::model`) that the
//! views paint, and turns the toolbar's navigation (Today, ‹ ›) and the view switcher (a dropdown, like the web
//! `CalendarViewSwitcher`) into moves of that view state — the web app's `CalendarNav` (`CalendarApp.tsx`).
//! This increment renders the Month grid, the Day/Week time grid and the Schedule (agenda) list from the
//! offline sample; the server-coupled editing is a later increment.

use kubuno_desktop::prelude::*;
use kubuno_desktop::views::component::Control as _;
use kubuno_desktop::{Row, Rows, Value as BValue};

use kubuno_calendar_desktop_common::app::Options;
use kubuno_calendar_desktop_common::state::{capitalize, ViewMode};

use crate::controls::agenda_list::AgendaList;
use crate::controls::model::{shared, Shared, State};
use crate::controls::month_grid::MonthGrid;
use crate::controls::time_grid::TimeGrid;
use crate::Resources;

/// Kubuno Calendar's main window.
#[kubuno_desktop::view("calendar_window.kbview")]
pub struct CalendarWindow {
    #[control]
    month: Custom<MonthGrid>,
    #[control]
    time_grid: Custom<TimeGrid>,
    #[control]
    agenda: Custom<AgendaList>,
    #[bind]
    window_title: String,
    #[bind]
    period_title: String,
    #[bind]
    is_month: bool,
    #[bind]
    is_time_grid: bool,
    #[bind]
    is_agenda: bool,
    #[bind]
    view_value: String,
    #[bind]
    view_items: Rows,
    model: Shared,
    /// `--doc <calendar-id>`: when set, the events are loaded live from the server for each visible window.
    doc: Option<String>,
}

/// The views offered in the switcher (the Year view is a later increment, so it is not listed yet).
fn view_id(view: ViewMode) -> &'static str {
    match view {
        ViewMode::Day => "day",
        ViewMode::Week => "week",
        ViewMode::Month => "month",
        ViewMode::Schedule => "schedule",
        ViewMode::Custom => "custom",
        ViewMode::Year => "year",
    }
}

impl CalendarWindow {
    pub fn new(options: Options) -> Self {
        // `--doc` opens the calendar live from the server: start empty, the first load fetches the window.
        let (calendars, events) = if options.doc.is_some() { (Vec::new(), Vec::new()) } else { options.dataset() };
        let offset = kubuno_calendar_desktop_common::platform::current().clock.utc_offset_minutes();
        let mut view = options.initial_state();
        view.today = kubuno_calendar_desktop_common::platform::current().clock.today();
        let state = State { calendars, events, view, offset_minutes: offset };
        let model = shared(state);
        let mut window = Self {
            window_title: Resources::app_title().to_string(),
            model,
            doc: options.doc.clone(),
            ..Self::default()
        };
        window.view_items = Rows::from(
            [
                ("day", Resources::view_day()),
                ("week", Resources::view_week()),
                ("month", Resources::view_month()),
                ("schedule", Resources::view_agenda()),
            ]
            .into_iter()
            .map(|(v, l)| Row::new().with("Value", BValue::Str(v.to_string())).with("Label", BValue::Str(l.to_string())))
            .collect::<Vec<_>>(),
        );
        window.sync_bindings();
        window.initialize_component();
        window
    }

    fn calendar_window_load(&mut self) {
        let m = self.model.clone();
        self.month.with(|v| v.set_model(m.clone()));
        self.time_grid.with(|v| v.set_model(m.clone()));
        self.agenda.with(|v| v.set_model(m.clone()));
        self.reload_live();
        self.refresh();
    }

    /// When opened live (`--doc`), (re)load the events of the visible month window from the server.
    fn reload_live(&mut self) {
        let Some(doc) = self.doc.clone() else { return };
        let (anchor, wso) = {
            let m = self.model.borrow();
            (m.view.current, m.view.week_starts_on)
        };
        match kubuno_calendar_desktop_common::live::fetch_month(&doc, anchor, wso) {
            Ok(events) => {
                self.model.borrow_mut().events = events;
            }
            Err(e) => kubuno_desktop::tracing::error!("[calendar] live load failed: {e}"),
        }
    }

    // ── Navigation ──────────────────────────────────────────────────────────

    fn today_click(&mut self) {
        self.model.borrow_mut().view.go_today();
        self.reload_live();
        self.refresh();
    }

    fn prev_click(&mut self) {
        self.model.borrow_mut().view.step(false);
        self.reload_live();
        self.refresh();
    }

    fn next_click(&mut self) {
        self.model.borrow_mut().view.step(true);
        self.reload_live();
        self.refresh();
    }

    /// The view switcher changed: map the selected id to a view mode.
    fn view_changed(&mut self) {
        let view = match self.view_value.as_str() {
            "day" => ViewMode::Day,
            "week" => ViewMode::Week,
            "schedule" => ViewMode::Schedule,
            _ => ViewMode::Month,
        };
        self.model.borrow_mut().view.view = view;
        self.refresh();
    }

    /// Compute the bound fields from the current view state (no control access — safe before load).
    fn sync_bindings(&mut self) {
        let m = self.model.borrow();
        self.period_title = capitalize(&m.view.title());
        let view = m.view.view;
        self.is_month = view == ViewMode::Month;
        self.is_time_grid = matches!(view, ViewMode::Day | ViewMode::Week | ViewMode::Custom);
        self.is_agenda = view == ViewMode::Schedule;
        self.view_value = view_id(view).to_string();
    }

    /// Push the bound fields and repaint the visible view.
    fn refresh(&mut self) {
        self.sync_bindings();
        self.month.with(|v| v.invalidate());
        self.time_grid.with(|v| v.invalidate());
        self.agenda.with(|v| v.invalidate());
    }
}
