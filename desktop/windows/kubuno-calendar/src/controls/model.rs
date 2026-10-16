//! What the window and the month grid share: the calendars, the events, the calendar view state and the
//! viewer's zone offset, behind one `Rc<RefCell<…>>` so the toolbar and the grid see the same thing. The
//! palette is the web's theme tokens, light and dark (`calendar/web/src/theme.css` +
//! `core/web/themes/kubuno-dark/theme.json`), vendored here as every Office desktop app vendors them.

use std::cell::RefCell;
use std::rc::Rc;

use kubuno_desktop::ui::graphics::Color;
use kubuno_calendar_core::model::{Calendar, EventInstance};
use kubuno_calendar_desktop_common::state::{CalendarView, ViewMode};
use kubuno_calendar_desktop_common::sample;

/// The calendars, events and view state the window and the grid share.
pub struct State {
    pub calendars: Vec<Calendar>,
    pub events: Vec<EventInstance>,
    pub view: CalendarView,
    /// Minutes east of UTC of the viewer's zone (the web reads instants in the browser's zone).
    pub offset_minutes: i32,
    /// Calendar ids whose events the sidebar has hidden (`hiddenCalendarIds` in the web store).
    pub hidden_calendars: Vec<String>,
    /// The events matching the current search query (shown by the search results list).
    pub search_results: Vec<EventInstance>,
}

impl State {
    /// Is this calendar currently hidden in the sidebar?
    pub fn is_hidden(&self, calendar_id: &str) -> bool {
        self.hidden_calendars.iter().any(|c| c == calendar_id)
    }

    /// Toggle a calendar's visibility (the sidebar checkbox).
    pub fn toggle_calendar(&mut self, calendar_id: &str) {
        if let Some(pos) = self.hidden_calendars.iter().position(|c| c == calendar_id) {
            self.hidden_calendars.remove(pos);
        } else {
            self.hidden_calendars.push(calendar_id.to_string());
        }
    }

    /// The events the visible views should draw (those of calendars that are not hidden).
    pub fn visible_events(&self) -> Vec<EventInstance> {
        if self.hidden_calendars.is_empty() {
            return self.events.clone();
        }
        self.events.iter().filter(|e| !self.is_hidden(&e.calendar_id)).cloned().collect()
    }
}

impl Default for State {
    fn default() -> Self {
        use kubuno_calendar_core::date::{Date, Lang};
        let today = Date::new(2026, 10, 12).unwrap_or(Date { year: 2026, month: 10, day: 12 });
        State {
            calendars: Vec::new(),
            events: Vec::new(),
            view: CalendarView::new(today, ViewMode::Month, Lang::Fr),
            offset_minutes: 0,
            hidden_calendars: Vec::new(),
            search_results: Vec::new(),
        }
    }
}

/// The shared model.
pub type Shared = Rc<RefCell<State>>;

pub fn shared(state: State) -> Shared {
    Rc::new(RefCell::new(state))
}

/// A model with the offline sample dataset (the designer, `--sample`).
pub fn sample_state() -> State {
    use kubuno_calendar_core::date::{Date, Lang};
    let today = Date::new(2026, 10, 12).unwrap_or(Date { year: 2026, month: 10, day: 12 });
    State {
        calendars: sample::calendars(),
        events: sample::events(),
        view: CalendarView::new(today, ViewMode::Month, Lang::Fr),
        offset_minutes: 0,
            hidden_calendars: Vec::new(),
            search_results: Vec::new(),
        }
}

/// `#rrggbb` literal → colour.
pub const fn hex(v: u32) -> Color {
    Color::rgb(((v >> 16) & 0xff) as u8, ((v >> 8) & 0xff) as u8, (v & 0xff) as u8)
}

/// Parse a `#rgb` / `#rrggbb` event colour, falling back to `fallback` on anything else.
pub fn color_of(s: &str, fallback: Color) -> Color {
    let h = s.trim_start_matches('#');
    let h = match h.len() {
        3 => h.chars().flat_map(|c| [c, c]).collect::<String>(),
        6 => h.to_string(),
        _ => return fallback,
    };
    match u32::from_str_radix(&h, 16) {
        Ok(n) => hex(n),
        Err(_) => fallback,
    }
}

/// The theme tokens the month grid paints with - the web's, light and dark.
#[derive(Debug, Clone, Copy)]
pub struct Palette {
    pub dark: bool,
    pub surface0: Color,
    pub surface1: Color,
    pub surface2: Color,
    pub surface3: Color,
    pub border: Color,
    /// `--color-border-strong` (#bdc1c6) - used for the moon-marker outline.
    pub border_strong: Color,
    pub primary: Color,
    pub text_primary: Color,
    pub text_secondary: Color,
    pub text_tertiary: Color,
    /// `--color-danger` - the destructive accent (« Retirer », delete).
    pub danger: Color,
}

impl Palette {
    pub fn light() -> Self {
        Self {
            dark: false,
            surface0: hex(0xffffff),
            surface1: hex(0xf8f9fa),
            surface2: hex(0xf1f3f4),
            surface3: hex(0xe8eaed),
            border: hex(0xe0e0e0),
            border_strong: hex(0xbdc1c6),
            primary: hex(0x1a73e8),
            text_primary: hex(0x444444),
            text_secondary: hex(0x5f6368),
            text_tertiary: hex(0x80868b),
            danger: hex(0xd93025),
        }
    }

    pub fn dark() -> Self {
        Self {
            dark: true,
            surface0: hex(0x202124),
            surface1: hex(0x292a2d),
            surface2: hex(0x35363a),
            surface3: hex(0x444746),
            border: hex(0x5f6368),
            border_strong: hex(0x9aa0a6),
            primary: hex(0x8ab4f8),
            text_primary: hex(0xe8eaed),
            text_secondary: hex(0x9aa0a6),
            text_tertiary: hex(0x80868b),
            danger: hex(0xf28b82),
        }
    }

    pub fn of(dark: bool) -> Self {
        if dark {
            Self::dark()
        } else {
            Self::light()
        }
    }
}
