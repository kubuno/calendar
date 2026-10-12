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

use kubuno_calendar_core::date::Date;
use kubuno_calendar_desktop_common::live::EventWrite;

use crate::controls::agenda_list::AgendaList;
use crate::controls::calendar_list::CalendarList;
use crate::controls::mini_month::{MiniDateArgs, MiniMonth};
use crate::controls::moon_widget::MoonWidget;
use crate::controls::model::{shared, Shared, State};
use crate::controls::month_grid::{ActivateArgs, MonthGrid};
use crate::controls::search_results::{SearchNavArgs, SearchResults};
use crate::controls::time_grid::TimeGrid;
use crate::controls::year_grid::{YearGrid, YearNavArgs};
use crate::views::event_editor::EventEditor;
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
    #[control]
    mini: Custom<MiniMonth>,
    #[control]
    cal_list: Custom<CalendarList>,
    #[control]
    moon: Custom<MoonWidget>,
    #[control]
    year: Custom<YearGrid>,
    #[control]
    search_view: Custom<SearchResults>,
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
    is_year: bool,
    #[bind]
    is_search: bool,
    #[bind]
    search_query: String,
    #[bind]
    view_value: String,
    #[bind]
    view_items: Rows,
    #[bind]
    is_live: bool,
    model: Shared,
    /// `--doc <calendar-id>`: when set, the events are loaded live from the server for each visible window.
    doc: Option<String>,
    /// The ±1-year event pool fetched once when a search begins, filtered client-side on each keystroke.
    search_pool: Vec<kubuno_calendar_core::model::EventInstance>,
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
        let state = State { calendars, events, view, offset_minutes: offset, hidden_calendars: Vec::new(), search_results: Vec::new() };
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
                ("year", Resources::view_year()),
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
        self.mini.with(|v| v.set_model(m.clone()));
        self.cal_list.with(|v| v.set_model(m.clone()));
        self.moon.with(|v| v.set_model(m.clone()));
        self.year.with(|v| v.set_model(m.clone()));
        self.search_view.with(|v| v.set_model(m.clone()));
        // Load the calendars once (for the editor's calendar picker and colours) — a one-off localhost GET.
        if self.doc.is_some() {
            if let Ok(cals) = kubuno_calendar_desktop_common::live::fetch_calendars() {
                self.model.borrow_mut().calendars = cals;
            }
        }
        self.reload_live();
        self.refresh();
    }

    /// The writable calendars the editor offers in its picker.
    fn writable_calendars(&self) -> Vec<kubuno_calendar_core::model::Calendar> {
        self.model.borrow().calendars.iter().filter(|c| c.is_writable()).cloned().collect()
    }

    /// The default calendar id for a new event (the writable default, else the first writable one).
    fn default_calendar(&self) -> String {
        let m = self.model.borrow();
        m.calendars
            .iter()
            .find(|c| c.is_writable() && c.is_default)
            .or_else(|| m.calendars.iter().find(|c| c.is_writable()))
            .map(|c| c.id.clone())
            .unwrap_or_default()
    }

    /// When opened live (`--doc`), (re)load the events of the visible month window from the server on a
    /// background thread so the UI never blocks on the network; the result is posted back to the UI thread.
    fn reload_live(&mut self) {
        let Some(doc) = self.doc.clone() else { return };
        let (anchor, wso, is_year) = {
            let m = self.model.borrow();
            (m.view.current, m.view.week_starts_on, m.view.view == ViewMode::Year)
        };
        // The Year view needs the whole year's events (for the density dots); the others, the month window.
        let fetch = move || {
            if is_year {
                kubuno_calendar_desktop_common::live::fetch_year(&doc, anchor)
            } else {
                kubuno_calendar_desktop_common::live::fetch_month(&doc, anchor, wso)
            }
        };
        match self.dispatcher() {
            // The usual path: fetch on a background thread, post the result back to the UI thread.
            Some(disp) => {
                std::thread::spawn(move || {
                    let result = fetch();
                    drop(disp.begin_invoke(move |w: &mut CalendarWindow| w.on_loaded(result)));
                });
            }
            // No dispatcher yet (the very first load, before the form is fully live): fetch inline so the
            // window opens already populated. A one-off localhost GET; navigation and CRUD are always async.
            None => {
                let result = fetch();
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
            "year" => ViewMode::Year,
            "schedule" => ViewMode::Schedule,
            _ => ViewMode::Month,
        };
        self.model.borrow_mut().view.view = view;
        self.reload_live();
        self.refresh();
    }

    /// « S'abonner à un agenda »: ask for a name and an .ics URL, then create the subscription on the server.
    fn subscribe_click(&mut self) {
        if let Some((name, url)) = crate::views::subscribe_dialog::SubscribeDialog::new().run(self) {
            match kubuno_calendar_desktop_common::live::subscribe_calendar(&name, &url, "#0b8043") {
                Ok(_) => self.reload_calendars(),
                Err(e) => kubuno_desktop::tracing::error!("[calendar] subscribe failed: {e}"),
            }
        }
    }

    /// Re-fetch the calendars list (after a management action) and repaint the sidebar.
    fn reload_calendars(&mut self) {
        if self.doc.is_some() {
            if let Ok(cals) = kubuno_calendar_desktop_common::live::fetch_calendars() {
                self.model.borrow_mut().calendars = cals;
            }
        }
        self.reload_live();
        self.refresh();
    }

    /// The toolbar search field changed: filter the ±1-year event pool by the query (title / description /
    /// location) and show the results list, like the web's `SearchResultsView`.
    fn search_changed(&mut self) {
        let q = self.search_query.trim().to_lowercase();
        self.is_search = !q.is_empty();
        if self.is_search {
            if self.doc.is_some() && self.search_pool.is_empty() {
                let (doc, today) = { let m = self.model.borrow(); (self.doc.clone().unwrap_or_default(), m.view.today) };
                self.search_pool = kubuno_calendar_desktop_common::live::fetch_search_range(&doc, today).unwrap_or_default();
            }
            let hidden: Vec<String> = self.model.borrow().hidden_calendars.clone();
            let mut results: Vec<_> = self
                .search_pool
                .iter()
                .filter(|ev| !hidden.contains(&ev.calendar_id))
                .filter(|ev| {
                    ev.title.to_lowercase().contains(&q)
                        || ev.description.as_deref().unwrap_or("").to_lowercase().contains(&q)
                        || ev.location.as_deref().unwrap_or("").to_lowercase().contains(&q)
                })
                .cloned()
                .collect();
            results.sort_by(|a, b| a.starts_at.cmp(&b.starts_at));
            self.model.borrow_mut().search_results = results;
        } else {
            self.model.borrow_mut().search_results.clear();
        }
        self.refresh();
    }

    /// A search result was clicked: open that event's Day.
    fn search_picked(&mut self, args: &SearchNavArgs) {
        if let Some(d) = Date::parse(&args.date_iso) {
            self.search_query = String::new();
            self.is_search = false;
            {
                let mut m = self.model.borrow_mut();
                m.view.current = d;
                m.view.view = ViewMode::Day;
                m.search_results.clear();
            }
            self.reload_live();
            self.refresh();
        }
    }

    /// Navigation from the Year view: open the clicked day as a Day view, or the clicked month as a Month view.
    fn year_nav(&mut self, args: &YearNavArgs) {
        if let Some(d) = Date::parse(&args.date_iso) {
            {
                let mut m = self.model.borrow_mut();
                m.view.current = d;
                m.view.view = if args.to_day { ViewMode::Day } else { ViewMode::Month };
            }
            self.reload_live();
            self.refresh();
        }
    }

    // ── Event editor (create / edit) ─────────────────────────────────────────

    /// The toolbar « New event » button: open the editor to create an event on the anchor date.
    fn new_click(&mut self) {
        let (date, offset, lang) = {
            let m = self.model.borrow();
            (m.view.current, m.offset_minutes, m.view.lang)
        };
        self.open_editor(EventEditor::for_create(date, offset, lang, &self.writable_calendars(), &self.default_calendar()));
    }

    /// A double-click in a view: edit the event, or create one on the day that was double-clicked.
    fn event_activated(&mut self, args: &ActivateArgs) {
        let (offset, lang) = {
            let m = self.model.borrow();
            (m.offset_minutes, m.view.lang)
        };
        if !args.event_id.is_empty() {
            // Edit the event whose first occurrence we have loaded.
            let found = self.model.borrow().events.iter().find(|ev| ev.event_id == args.event_id).cloned();
            if let Some(ev) = found {
                // Load the event's current guests (a one-off localhost GET) so the editor shows them.
                let guests = kubuno_calendar_desktop_common::live::fetch_guest_emails(&ev.event_id);
                self.open_editor(EventEditor::for_edit(&ev, offset, lang, &self.writable_calendars(), &guests));
            }
        } else if let Some(date) = Date::parse(&args.date_iso) {
            self.open_editor(EventEditor::for_create(date, offset, lang, &self.writable_calendars(), &self.default_calendar()));
        }
    }

    /// Show the editor modally; on Save, write to the server off the UI thread and reload.
    fn open_editor(&mut self, editor: EventEditor) {
        if let Some(write) = editor.run(self) {
            self.save_form(write);
        }
    }

    fn save_form(&mut self, write: EventWrite) {
        let Some(doc) = self.doc.clone() else { return };
        let Some(disp) = self.dispatcher() else { return };
        std::thread::spawn(move || {
            let result = kubuno_calendar_desktop_common::live::save_event(&doc, &write);
            drop(disp.begin_invoke(move |w: &mut CalendarWindow| w.on_saved(result)));
        });
    }

    fn on_saved(&mut self, result: Result<(), String>) {
        if let Err(e) = result {
            kubuno_desktop::tracing::error!("[calendar] save failed: {e}");
        }
        self.reload_live();
        self.refresh();
    }

    /// Compute the bound fields from the current view state (no control access — safe before load).
    fn sync_bindings(&mut self) {
        let m = self.model.borrow();
        self.period_title = capitalize(&m.view.title());
        let view = m.view.view;
        // While a search is active, the results list replaces the normal views.
        let searching = self.is_search;
        self.is_month = view == ViewMode::Month && !searching;
        self.is_time_grid = matches!(view, ViewMode::Day | ViewMode::Week | ViewMode::Custom) && !searching;
        self.is_agenda = view == ViewMode::Schedule && !searching;
        self.is_year = view == ViewMode::Year && !searching;
        self.view_value = view_id(view).to_string();
        drop(m);
        self.is_live = self.doc.is_some();
    }

    /// Push the bound fields and repaint the visible view and the sidebar.
    fn refresh(&mut self) {
        self.sync_bindings();
        self.month.with(|v| v.invalidate());
        self.time_grid.with(|v| v.invalidate());
        self.agenda.with(|v| v.invalidate());
        self.mini.with(|v| v.invalidate());
        self.cal_list.with(|v| v.invalidate());
        self.year.with(|v| v.invalidate());
        self.search_view.with(|v| v.invalidate());
    }

    /// A day was clicked in the sidebar mini-month: move the main view's date there.
    fn mini_date_picked(&mut self, args: &MiniDateArgs) {
        if let Some(d) = Date::parse(&args.date_iso) {
            self.model.borrow_mut().view.current = d;
            self.reload_live();
            self.refresh();
        }
    }

    /// A calendar's visibility was toggled in the sidebar: re-filter and repaint the views.
    fn cal_visibility_changed(&mut self) {
        self.refresh();
    }
}
