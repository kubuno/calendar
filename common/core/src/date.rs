//! Civil dates (no time, no zone) and the display language.
//!
//! The web turns a stored instant into a JavaScript `Date` and reads its day in the browser's local zone
//! (`getDay`, `getDate`, the date-fns `startOfWeek`/`endOfMonth`/`eachDayOfInterval` helpers of `@kubuno/sdk`).
//! This module reproduces the pure day arithmetic those helpers do; the local wall-clock conversion of a timed
//! instant lives in [`crate::model`] (it needs the zone offset the platform supplies).
//!
//! The civil-date core (`days_from_civil`/`civil_from_days`) is Howard Hinnant's algorithm, the same one the
//! Kubuno Projects core uses, so the two modules agree day for day.

use std::fmt;

/// A civil date of the proleptic Gregorian calendar.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Date {
    pub year: i32,
    /// 1–12.
    pub month: u32,
    /// 1–31.
    pub day: u32,
}

impl Default for Date {
    /// The Unix epoch (`1970-01-01`) — a valid placeholder, since month/day `0` would be illegal.
    fn default() -> Self {
        Date { year: 1970, month: 1, day: 1 }
    }
}

/// Days from 1970-01-01 to the given civil date (Howard Hinnant's `days_from_civil`).
fn days_from_civil(y: i32, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y as i64 - 1 } else { y as i64 };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let m = m as i64;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// The civil date `z` days after 1970-01-01 (`civil_from_days`).
fn civil_from_days(z: i64) -> (i32, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    ((if m <= 2 { y + 1 } else { y }) as i32, m, d)
}

fn days_in_month(year: i32, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        _ if (year % 4 == 0 && year % 100 != 0) || year % 400 == 0 => 29,
        _ => 28,
    }
}

impl Date {
    /// A valid date, or `None`.
    pub fn new(year: i32, month: u32, day: u32) -> Option<Self> {
        if !(1..=12).contains(&month) || day == 0 || day > days_in_month(year, month) {
            return None;
        }
        Some(Self { year, month, day })
    }

    /// Reads `"YYYY-MM-DD"` (a longer ISO string is cut at the date: `"2026-10-07T00:00:00Z"`).
    pub fn parse(s: &str) -> Option<Self> {
        let s = s.trim();
        let s = s.get(..10).unwrap_or(s);
        let mut it = s.split('-');
        let y = it.next()?.parse::<i32>().ok()?;
        let m = it.next()?.parse::<u32>().ok()?;
        let d = it.next()?.parse::<u32>().ok()?;
        if it.next().is_some() {
            return None;
        }
        Self::new(y, m, d)
    }

    /// Days since 1970-01-01.
    pub fn to_days(self) -> i64 {
        days_from_civil(self.year, self.month, self.day)
    }

    pub fn from_days(days: i64) -> Self {
        let (year, month, day) = civil_from_days(days);
        Self { year, month, day }
    }

    /// `addDays`.
    pub fn add_days(self, n: i64) -> Self {
        Self::from_days(self.to_days() + n)
    }

    /// `differenceInDays(self, other)`: whole days from `other` to `self`.
    pub fn days_since(self, other: Date) -> i64 {
        self.to_days() - other.to_days()
    }

    /// Monday = 0 … Sunday = 6.
    pub fn weekday_mon0(self) -> u32 {
        // 1970-01-01 was a Thursday (3).
        (self.to_days() + 3).rem_euclid(7) as u32
    }

    /// JavaScript's `getDay()`: Sunday = 0 … Saturday = 6.
    pub fn js_day(self) -> u32 {
        (self.weekday_mon0() + 1) % 7
    }

    /// Saturday or Sunday (`calendarUtils.isWeekend`).
    pub fn is_weekend(self) -> bool {
        let d = self.js_day();
        d == 0 || d == 6
    }

    /// The ISO 8601 week number.
    pub fn iso_week(self) -> u32 {
        let thursday = self.add_days(3 - self.weekday_mon0() as i64);
        let jan1 = Date { year: thursday.year, month: 1, day: 1 };
        (thursday.days_since(jan1) / 7 + 1) as u32
    }

    /// `"YYYY-MM-DD"` (`toISODate`).
    pub fn iso(self) -> String {
        format!("{:04}-{:02}-{:02}", self.year, self.month, self.day)
    }

    /// The first day of this date's month (`startOfMonth`).
    pub fn start_of_month(self) -> Self {
        Self { day: 1, ..self }
    }

    /// The last day of this date's month (`endOfMonth`).
    pub fn end_of_month(self) -> Self {
        Self { day: days_in_month(self.year, self.month), ..self }
    }

    pub fn days_in_month(self) -> u32 {
        days_in_month(self.year, self.month)
    }

    /// The first day of the next month.
    pub fn next_month(self) -> Self {
        if self.month == 12 {
            Self { year: self.year + 1, month: 1, day: 1 }
        } else {
            Self { year: self.year, month: self.month + 1, day: 1 }
        }
    }

    /// The month `n` calendar months away, clamping the day to the target month's length (e.g. Jan 31 + 1
    /// month = Feb 28/29). This is the `addMonths` behaviour the month navigation relies on.
    pub fn add_months(self, n: i32) -> Self {
        let total = (self.year * 12 + self.month as i32 - 1) + n;
        let year = total.div_euclid(12);
        let month = (total.rem_euclid(12) + 1) as u32;
        let day = self.day.min(days_in_month(year, month));
        Self { year, month, day }
    }
}

/// First day of the week a `WeekStart` makes (`date-fns startOfWeek`, `weekStartsOn` 0 = Sunday, 1 = Monday).
/// Returns the most recent `week_start` weekday on or before `date`.
pub fn start_of_week(date: Date, week_starts_on: u32) -> Date {
    let diff = (date.js_day() as i64 - week_starts_on as i64).rem_euclid(7);
    date.add_days(-diff)
}

/// Last day of the week (`endOfWeek`): six days after [`start_of_week`].
pub fn end_of_week(date: Date, week_starts_on: u32) -> Date {
    start_of_week(date, week_starts_on).add_days(6)
}

/// Every day from `start` to `end` inclusive (`eachDayOfInterval`). `end` before `start` yields an empty
/// vector, matching the web helper's guard.
pub fn each_day_of_interval(start: Date, end: Date) -> Vec<Date> {
    let (a, b) = (start.to_days(), end.to_days());
    if b < a {
        return Vec::new();
    }
    (a..=b).map(Date::from_days).collect()
}

impl fmt::Display for Date {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.iso())
    }
}

/// The display language of the dates (`i18n.language`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Lang {
    #[default]
    Fr,
    En,
}

impl Lang {
    /// `"fr"`, `"fr-FR"` → French; anything else English.
    pub fn from_tag(tag: &str) -> Self {
        if tag.to_ascii_lowercase().starts_with("fr") {
            Lang::Fr
        } else {
            Lang::En
        }
    }
}

const FR_LONG: [&str; 12] = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
const FR_SHORT: [&str; 12] = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];
const EN_LONG: [&str; 12] = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const EN_SHORT: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const FR_WEEKDAY_SHORT: [&str; 7] = ["lun.", "mar.", "mer.", "jeu.", "ven.", "sam.", "dim."];
const EN_WEEKDAY_SHORT: [&str; 7] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const FR_WEEKDAY_LONG: [&str; 7] = ["lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"];
const EN_WEEKDAY_LONG: [&str; 7] = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

/// The `Intl.DateTimeFormat` shapes the calendar views use.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DateFormat {
    /// « octobre 2026 » / « October 2026 » (the toolbar title).
    MonthYear,
    /// « 7 oct. » / « Oct 7 ».
    DayMonth,
    /// « 7 oct. 2026 » / « Oct 7, 2026 ».
    Date,
    /// « octobre » / « October ».
    Month,
    /// « lun. » / « Mon ».
    WeekdayShort,
    /// `dateLong` — « 12 octobre 2026 » / « October 12, 2026 » (the week-of title).
    DateLong,
    /// « mercredi 14 octobre 2026 » / « Wednesday, October 14, 2026 » (the Day view title).
    FullDate,
}

/// `formatDate(date, shape)` in `lang`.
pub fn format(d: Date, shape: DateFormat, lang: Lang) -> String {
    let mi = (d.month - 1) as usize;
    match (shape, lang) {
        (DateFormat::MonthYear, Lang::Fr) => format!("{} {}", FR_LONG[mi], d.year),
        (DateFormat::MonthYear, Lang::En) => format!("{} {}", EN_LONG[mi], d.year),
        (DateFormat::DayMonth, Lang::Fr) => format!("{} {}", d.day, FR_SHORT[mi]),
        (DateFormat::DayMonth, Lang::En) => format!("{} {}", EN_SHORT[mi], d.day),
        (DateFormat::Date, Lang::Fr) => format!("{} {} {}", d.day, FR_SHORT[mi], d.year),
        (DateFormat::Date, Lang::En) => format!("{} {}, {}", EN_SHORT[mi], d.day, d.year),
        (DateFormat::Month, Lang::Fr) => FR_LONG[mi].to_string(),
        (DateFormat::Month, Lang::En) => EN_LONG[mi].to_string(),
        (DateFormat::WeekdayShort, Lang::Fr) => FR_WEEKDAY_SHORT[d.weekday_mon0() as usize].to_string(),
        (DateFormat::WeekdayShort, Lang::En) => EN_WEEKDAY_SHORT[d.weekday_mon0() as usize].to_string(),
        (DateFormat::DateLong, Lang::Fr) => format!("{} {} {}", d.day, FR_LONG[mi], d.year),
        (DateFormat::DateLong, Lang::En) => format!("{} {}, {}", EN_LONG[mi], d.day, d.year),
        (DateFormat::FullDate, Lang::Fr) => format!("{} {} {} {}", FR_WEEKDAY_LONG[d.weekday_mon0() as usize], d.day, FR_LONG[mi], d.year),
        (DateFormat::FullDate, Lang::En) => format!("{}, {} {}, {}", EN_WEEKDAY_LONG[d.weekday_mon0() as usize], EN_LONG[mi], d.day, d.year),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_days() {
        for z in [-800_000i64, -1, 0, 1, 20_000, 20_733, 2_000_000] {
            assert_eq!(Date::from_days(z).to_days(), z);
        }
        assert_eq!(Date::parse("1970-01-01").map(Date::to_days), Some(0));
        assert_eq!(Date::parse("2026-10-07T00:00:00Z").map(|d| d.iso()), Some("2026-10-07".into()));
        assert!(Date::parse("2026-02-30").is_none());
    }

    #[test]
    fn weekdays() {
        let mon = Date::new(2026, 10, 12).expect("date"); // 2026-10-12 is a Monday
        assert_eq!(mon.weekday_mon0(), 0);
        assert_eq!(mon.js_day(), 1);
        assert!(!mon.is_weekend());
        assert!(mon.add_days(5).is_weekend()); // Saturday
        assert!(mon.add_days(6).is_weekend()); // Sunday
    }

    #[test]
    fn week_boundaries() {
        // 2026-10-14 (Wednesday). Monday-start → 2026-10-12 … 2026-10-18.
        let w = Date::new(2026, 10, 14).expect("d");
        assert_eq!(start_of_week(w, 1), Date::new(2026, 10, 12).expect("d"));
        assert_eq!(end_of_week(w, 1), Date::new(2026, 10, 18).expect("d"));
        // Sunday-start → 2026-10-11 … 2026-10-17.
        assert_eq!(start_of_week(w, 0), Date::new(2026, 10, 11).expect("d"));
    }

    #[test]
    fn each_day() {
        let days = each_day_of_interval(Date::new(2026, 10, 12).expect("d"), Date::new(2026, 10, 18).expect("d"));
        assert_eq!(days.len(), 7);
        assert_eq!(days[0].day, 12);
        assert_eq!(days[6].day, 18);
        assert!(each_day_of_interval(Date::new(2026, 10, 18).expect("d"), Date::new(2026, 10, 12).expect("d")).is_empty());
    }

    #[test]
    fn add_months_clamps() {
        assert_eq!(Date::new(2026, 1, 31).expect("d").add_months(1), Date::new(2026, 2, 28).expect("d"));
        assert_eq!(Date::new(2024, 1, 31).expect("d").add_months(1), Date::new(2024, 2, 29).expect("d"));
        assert_eq!(Date::new(2026, 12, 15).expect("d").add_months(1), Date::new(2027, 1, 15).expect("d"));
        assert_eq!(Date::new(2026, 1, 15).expect("d").add_months(-1), Date::new(2025, 12, 15).expect("d"));
    }

    #[test]
    fn formats() {
        let d = Date::new(2026, 10, 7).expect("date");
        assert_eq!(format(d, DateFormat::MonthYear, Lang::Fr), "octobre 2026");
        assert_eq!(format(d, DateFormat::Date, Lang::En), "Oct 7, 2026");
    }
}
