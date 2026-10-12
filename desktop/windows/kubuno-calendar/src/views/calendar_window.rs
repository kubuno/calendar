//! Code-behind of Kubuno Calendar's window (`calendar_window.kbview`) — Windows Forms' `Form1.cs`.
//!
//! The window owns the shared model (the calendars, the events and the view state, `controls::model`) that the
//! views paint, and turns the toolbar's navigation (Today, ‹ ›) and the view switcher into moves of that view
//! state — the web app's `CalendarNav` / `CalendarViewSwitcher` (`CalendarApp.tsx`). This increment renders the
//! Month grid, the Day/Week time grid and the Schedule (agenda) list from the offline sample; the server-coupled
//! editing is a later increment.

use kubuno_desktop::prelude::*;
use kubuno_desktop::views::component::Control as _;

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
    day_variant: String,
    #[bind]
    week_variant: String,
    #[bind]
    month_variant: String,
    #[bind]
    agenda_variant: String,
    model: Shared,
}

impl CalendarWindow {
    pub fn new(options: Options) -> Self {
        let (calendars, events) = options.dataset();
        let offset = kubuno_calendar_desktop_common::platform::current().clock.utc_offset_minutes();
        let mut view = options.initial_state();
        view.today = kubuno_calendar_desktop_common::platform::current().clock.today();
        let state = State { calendars, events, view, offset_minutes: offset };
        let model = shared(state);
        let mut window = Self {
            window_title: Resources::app_title().to_string(),
            model,
            ..Self::default()
        };
        window.sync_bindings();
        window.initialize_component();
        window
    }

    fn calendar_window_load(&mut self) {
        let m = self.model.clone();
        self.month.with(|v| v.set_model(m.clone()));
        self.time_grid.with(|v| v.set_model(m.clone()));
        self.agenda.with(|v| v.set_model(m.clone()));
        self.refresh();
    }

    // ── Navigation ──────────────────────────────────────────────────────────

    fn today_click(&mut self) {
        self.model.borrow_mut().view.go_today();
        self.refresh();
    }

    fn prev_click(&mut self) {
        self.model.borrow_mut().view.step(false);
        self.refresh();
    }

    fn next_click(&mut self) {
        self.model.borrow_mut().view.step(true);
        self.refresh();
    }

    // ── View switcher ─────────────────────────────────────────────────────────

    fn day_click(&mut self) {
        self.set_view(ViewMode::Day);
    }

    fn week_click(&mut self) {
        self.set_view(ViewMode::Week);
    }

    fn month_click(&mut self) {
        self.set_view(ViewMode::Month);
    }

    fn agenda_click(&mut self) {
        self.set_view(ViewMode::Schedule);
    }

    fn set_view(&mut self, view: ViewMode) {
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
        let pick = |active: bool| if active { "Primary".to_string() } else { "Secondary".to_string() };
        self.day_variant = pick(view == ViewMode::Day);
        self.week_variant = pick(view == ViewMode::Week || view == ViewMode::Custom);
        self.month_variant = pick(view == ViewMode::Month);
        self.agenda_variant = pick(view == ViewMode::Schedule);
    }

    /// Push the bound fields and repaint the visible view.
    fn refresh(&mut self) {
        self.sync_bindings();
        self.month.with(|v| v.invalidate());
        self.time_grid.with(|v| v.invalidate());
        self.agenda.with(|v| v.invalidate());
    }
}
