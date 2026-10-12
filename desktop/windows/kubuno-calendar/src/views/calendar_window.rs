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
    #[bind]
    is_live: bool,
    #[bind]
    can_delete: bool,
    model: Shared,
    /// `--doc <calendar-id>`: when set, the events are loaded live from the server for each visible window.
    doc: Option<String>,
    /// The id of the last event this window created, so the « Delete » button can remove it.
    last_created: Option<String>,
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

    /// When opened live (`--doc`), (re)load the events of the visible month window from the server on a
    /// background thread so the UI never blocks on the network; the result is posted back to the UI thread.
    fn reload_live(&mut self) {
        let Some(doc) = self.doc.clone() else { return };
        let (anchor, wso) = {
            let m = self.model.borrow();
            (m.view.current, m.view.week_starts_on)
        };
        match self.dispatcher() {
            // The usual path: fetch on a background thread, post the result back to the UI thread.
            Some(disp) => {
                std::thread::spawn(move || {
                    let result = kubuno_calendar_desktop_common::live::fetch_month(&doc, anchor, wso);
                    drop(disp.begin_invoke(move |w: &mut CalendarWindow| w.on_loaded(result)));
                });
            }
            // No dispatcher yet (the very first load, before the form is fully live): fetch inline so the
            // window opens already populated. A one-off localhost GET; navigation and CRUD are always async.
            None => {
                let result = kubuno_calendar_desktop_common::live::fetch_month(&doc, anchor, wso);
                self.on_loaded(result);
            }
        }
    }

    /// Back on the UI thread with the loaded events.
    fn on_loaded(&mut self, result: Result<Vec<kubuno_calendar_core::model::EventInstance>, String>) {
        match result {
            Ok(events) => {
                self.model.borrow_mut().events = events;
                self.refresh();
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

    // ── Live CRUD (demonstration) ─────────────────────────────────────────────

    /// Create a one-hour demo event on the 15th of the visible month (`POST /calendar/events`) on a background
    /// thread, then reload. (The full event editor replaces this stub in a later increment.)
    fn new_click(&mut self) {
        let Some(doc) = self.doc.clone() else { return };
        let Some(disp) = self.dispatcher() else { return };
        let anchor = self.model.borrow().view.current;
        // 10:00–11:00 local (the dev data is GMT+2, so 08:00–09:00 UTC); a fixed day keeps the demo visible.
        let starts = format!("{:04}-{:02}-15T08:00:00Z", anchor.year, anchor.month);
        let ends = format!("{:04}-{:02}-15T09:00:00Z", anchor.year, anchor.month);
        std::thread::spawn(move || {
            let result = kubuno_calendar_desktop_common::live::create_event(&doc, "Créé au bureau", &starts, &ends, false);
            drop(disp.begin_invoke(move |w: &mut CalendarWindow| w.on_created(result)));
        });
    }

    fn on_created(&mut self, result: Result<String, String>) {
        match result {
            Ok(id) => {
                self.last_created = Some(id);
                self.reload_live();
            }
            Err(e) => kubuno_desktop::tracing::error!("[calendar] create failed: {e}"),
        }
        self.refresh();
    }

    /// Delete the event this window last created (`DELETE /calendar/events/:id`) on a background thread.
    fn del_click(&mut self) {
        let Some(id) = self.last_created.take() else { return };
        let Some(disp) = self.dispatcher() else {
            self.last_created = Some(id);
            return;
        };
        std::thread::spawn(move || {
            let result = kubuno_calendar_desktop_common::live::delete_event(&id, None, None);
            drop(disp.begin_invoke(move |w: &mut CalendarWindow| w.on_deleted(id, result)));
        });
    }

    fn on_deleted(&mut self, id: String, result: Result<(), String>) {
        match result {
            Ok(()) => self.reload_live(),
            Err(e) => {
                kubuno_desktop::tracing::error!("[calendar] delete failed: {e}");
                self.last_created = Some(id);
            }
        }
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
        drop(m);
        self.is_live = self.doc.is_some();
        self.can_delete = self.last_created.is_some();
    }

    /// Push the bound fields and repaint the visible view.
    fn refresh(&mut self) {
        self.sync_bindings();
        self.month.with(|v| v.invalidate());
        self.time_grid.with(|v| v.invalidate());
        self.agenda.with(|v| v.invalidate());
    }
}
