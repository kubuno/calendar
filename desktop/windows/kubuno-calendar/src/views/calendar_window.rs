//! Code-behind of Kubuno Calendar's window (`calendar_window.kbview`) — Windows Forms' `Form1.cs`.
//!
//! The window owns the shared model (the calendars, the events and the view state, `controls::model`) that the
//! month grid paints, and turns the toolbar's navigation (Today, ‹ ›) into moves of that view state — the web
//! app's `CalendarNav` (`CalendarApp.tsx`). Increment A is read-only on the Month view from the offline
//! sample; the live-server path and the other views are later increments.

use kubuno_desktop::prelude::*;
use kubuno_desktop::views::component::Control as _;

use kubuno_calendar_desktop_common::app::Options;
use kubuno_calendar_desktop_common::state::capitalize;

use crate::controls::model::{shared, State, Shared};
use crate::controls::month_grid::MonthGrid;
use crate::Resources;

/// Kubuno Calendar's main window.
#[kubuno_desktop::view("calendar_window.kbview")]
pub struct CalendarWindow {
    #[control]
    month: Custom<MonthGrid>,
    #[bind]
    window_title: String,
    #[bind]
    period_title: String,
    model: Shared,
}

impl CalendarWindow {
    pub fn new(options: Options) -> Self {
        let (calendars, events) = options.dataset();
        let offset = kubuno_calendar_desktop_common::platform::current().clock.utc_offset_minutes();
        let mut view = options.initial_state();
        view.today = kubuno_calendar_desktop_common::platform::current().clock.today();
        let state = State { calendars, events, view, offset_minutes: offset };
        let period = state.view.title();
        let model = shared(state);
        let mut window = Self {
            window_title: Resources::app_title().to_string(),
            period_title: period,
            model,
            ..Self::default()
        };
        window.initialize_component();
        window
    }

    fn calendar_window_load(&mut self) {
        self.month.with(|v| v.set_model(self.model.clone()));
        self.refresh();
    }

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

    /// Push the period title to the toolbar and repaint the grid.
    fn refresh(&mut self) {
        self.period_title = capitalize(&self.model.borrow().view.title());
        self.month.with(|v| v.invalidate());
    }
}
