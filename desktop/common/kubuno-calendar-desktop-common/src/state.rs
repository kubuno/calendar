//! The calendar view state shared by every front end (the web's `useCalendarStore`): which view, which date,
//! and the display options that drive the layout. Pure navigation logic, unit-tested here so the Win32 window
//! and the later live app agree.

use kubuno_calendar_core::date::{format, Date, DateFormat, Lang};

/// The views the app can show (`store.ViewMode`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ViewMode {
    Day,
    Week,
    Month,
    Year,
    Schedule,
    /// The N-day « custom » view.
    Custom,
}

impl ViewMode {
    /// The view a `default_view` / `--view` string names (`month` is the module default).
    pub fn from_tag(tag: &str) -> ViewMode {
        match tag {
            "day" => ViewMode::Day,
            "week" => ViewMode::Week,
            "year" => ViewMode::Year,
            "schedule" | "agenda" => ViewMode::Schedule,
            "custom" => ViewMode::Custom,
            _ => ViewMode::Month,
        }
    }
}

/// The calendar's current state.
#[derive(Debug, Clone)]
pub struct CalendarView {
    /// The date the current view is anchored on (`currentDate`).
    pub current: Date,
    /// « Today », supplied by the platform clock.
    pub today: Date,
    pub view: ViewMode,
    /// 0 = Sunday, 1 = Monday, 6 = Saturday (`week_starts_on`).
    pub week_starts_on: u32,
    pub show_weekends: bool,
    pub show_week_numbers: bool,
    pub lang: Lang,
}

impl CalendarView {
    pub fn new(today: Date, view: ViewMode, lang: Lang) -> Self {
        Self {
            current: today,
            today,
            view,
            week_starts_on: 1,
            show_weekends: true,
            show_week_numbers: false,
            lang,
        }
    }

    /// « Today »: jump the anchor to the current date.
    pub fn go_today(&mut self) {
        self.current = self.today;
    }

    /// The step of the current view: a day, a week, a month or a year.
    pub fn step(&mut self, forward: bool) {
        let dir = if forward { 1 } else { -1 };
        self.current = match self.view {
            ViewMode::Day => self.current.add_days(dir),
            ViewMode::Week | ViewMode::Custom => self.current.add_days(dir * 7),
            ViewMode::Month => self.current.add_months(dir as i32),
            ViewMode::Year => Date { year: self.current.year + dir as i32, ..self.current },
            // Schedule scrolls a month at a time, like the web's range stepping.
            ViewMode::Schedule => self.current.add_months(dir as i32),
        };
    }

    /// The period title in the toolbar (the web's `CalendarNav` title).
    pub fn title(&self) -> String {
        match self.view {
            ViewMode::Year => self.current.year.to_string(),
            ViewMode::Day => format(self.current, DateFormat::Date, self.lang),
            _ => {
                let t = format(self.current, DateFormat::MonthYear, self.lang);
                capitalize(&t)
            }
        }
    }
}

/// The first letter upper-cased (the web's `capitalize`).
pub fn capitalize(s: &str) -> String {
    let mut c = s.chars();
    match c.next() {
        Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
        None => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(y: i32, m: u32, day: u32) -> Date {
        Date::new(y, m, day).expect("date")
    }

    #[test]
    fn month_stepping_and_title() {
        let mut v = CalendarView::new(d(2026, 10, 12), ViewMode::Month, Lang::Fr);
        assert_eq!(v.title(), "Octobre 2026");
        v.step(true);
        assert_eq!(v.current, d(2026, 11, 12));
        assert_eq!(v.title(), "Novembre 2026");
        v.step(false);
        v.step(false);
        assert_eq!(v.title(), "Septembre 2026");
        v.current = d(2020, 1, 15);
        v.go_today();
        assert_eq!(v.current, v.today);
    }

    #[test]
    fn day_week_year_steps() {
        let mut v = CalendarView::new(d(2026, 12, 30), ViewMode::Day, Lang::En);
        v.step(true);
        assert_eq!(v.current, d(2026, 12, 31));
        v.view = ViewMode::Week;
        v.step(true);
        assert_eq!(v.current, d(2027, 1, 7));
        v.view = ViewMode::Year;
        assert_eq!(v.title(), "2027");
        v.step(false);
        assert_eq!(v.current.year, 2026);
    }

    #[test]
    fn view_from_tag() {
        assert_eq!(ViewMode::from_tag("week"), ViewMode::Week);
        assert_eq!(ViewMode::from_tag("agenda"), ViewMode::Schedule);
        assert_eq!(ViewMode::from_tag("nonsense"), ViewMode::Month);
    }
}
