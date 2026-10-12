//! The per-view layout math ported from `web/src/calendarUtils.ts` and the views, kept platform-neutral so the
//! desktop paints the same geometry the web lays out in the DOM.
//!
//! The web reads instants in the browser's local zone; here every function takes `offset_minutes`, the viewer
//! zone's offset east of UTC, and converts through [`crate::model::Instant`]. All-day events are offset
//! independent (read in UTC), matching `allDayLocal`.

use crate::date::{each_day_of_interval, end_of_week, start_of_week, Date};
use crate::model::{EventInstance, Instant};

/// Pixels per hour in the Day/Week time grid (`WeekView.PX_PER_HOUR`, `DayView.PX_PER_HOUR`).
pub const PX_PER_HOUR: f32 = 40.0;
/// Height of one all-day banner bar (`MonthView.BANNER_BAR_H`).
pub const BANNER_BAR_H: f32 = 18.0;
/// Vertical step between stacked banner rows (`MonthView.BANNER_ROW_H`).
pub const BANNER_ROW_H: f32 = 20.0;
/// Top offset of the first banner row inside a day cell (`MonthView.BANNER_TOP`).
pub const BANNER_TOP: f32 = 34.0;
/// Most event chips drawn in a month cell before a « +N » summary (desktop).
pub const MONTH_MAX_CHIPS: usize = 4;
/// A very short event still takes this many minutes of column width (`layoutDayEvents.MIN_SPAN`).
pub const MIN_SPAN: i64 = 30;

/// The six-week (or four/five-week) grid of a month (`calendarUtils.calendarGrid`): from the first day of the
/// week containing the 1st to the last day of the week containing the month's end. `week_starts_on` is 0 for
/// Sunday, 1 for Monday (6 for Saturday), as the `week_starts_on` setting resolves.
pub fn month_grid(month: Date, week_starts_on: u32) -> Vec<Date> {
    let start = start_of_week(month.start_of_month(), week_starts_on);
    let end = end_of_week(month.end_of_month(), week_starts_on);
    each_day_of_interval(start, end)
}

/// Is an event a banner (all-day, or a timed event spanning more than one local day)?
/// (`calendarUtils.isBannerEvent`).
pub fn is_banner_event(ev: &EventInstance, offset_minutes: i32) -> bool {
    if ev.all_day {
        return true;
    }
    banner_start_day(ev, offset_minutes) != banner_end_day(ev, offset_minutes)
}

/// The first local day an event covers (`calendarUtils.bannerStartDay`).
pub fn banner_start_day(ev: &EventInstance, offset_minutes: i32) -> Date {
    let start = Instant::parse(&ev.starts_at).unwrap_or(Instant { epoch_seconds: 0 });
    if ev.all_day {
        start.utc_date()
    } else {
        start.local(offset_minutes).date
    }
}

/// The inclusive last local day an event covers (`calendarUtils.bannerEndDay`). A timed event ending exactly at
/// local midnight does not reach into the next day, so it is pulled back one day.
pub fn banner_end_day(ev: &EventInstance, offset_minutes: i32) -> Date {
    let end = Instant::parse(&ev.ends_at).unwrap_or(Instant { epoch_seconds: 0 });
    if ev.all_day {
        return end.utc_date();
    }
    let local = end.local(offset_minutes);
    if local.is_midnight() {
        local.date.add_days(-1)
    } else {
        local.date
    }
}

/// Timed, single-day events whose local start day is `day` — the chips a month cell shows
/// (`MonthView.eventsForDay`: banner events excluded, `isSameDay(starts_at, day)`). Order is preserved.
pub fn timed_events_for_day(events: &[EventInstance], day: Date, offset_minutes: i32) -> Vec<&EventInstance> {
    events
        .iter()
        .filter(|ev| !is_banner_event(ev, offset_minutes))
        .filter(|ev| {
            Instant::parse(&ev.starts_at).map(|i| i.local(offset_minutes).date) == Some(day)
        })
        .collect()
}

/// A side-by-side column placement for one timed event (`layoutDayEvents`'s `{leftPct, widthPct}`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DayPlacement {
    pub left_pct: f32,
    pub width_pct: f32,
}

struct DayItem {
    idx: usize,
    s: i64,
    e: i64,
}

/// Side-by-side layout of overlapping timed events in a Day/Week column (`calendarUtils.layoutDayEvents`):
/// group transitive overlaps into clusters, give each event the first free column, split the cluster width.
/// Returns, for each input event, its placement in input order.
pub fn layout_day_events(events: &[EventInstance], offset_minutes: i32) -> Vec<DayPlacement> {
    let mut items: Vec<DayItem> = events
        .iter()
        .enumerate()
        .map(|(idx, ev)| {
            let s = Instant::parse(&ev.starts_at).map(|i| minute_of_day(i, offset_minutes)).unwrap_or(0);
            let e_raw = Instant::parse(&ev.ends_at).map(|i| minute_of_day(i, offset_minutes)).unwrap_or(0);
            DayItem { idx, s, e: e_raw.max(s + MIN_SPAN) }
        })
        .collect();
    // Sort by start, then by longer-first (`a.s - b.s || b.e - a.e`). `sort_by` is stable, matching JS.
    items.sort_by(|a, b| a.s.cmp(&b.s).then(b.e.cmp(&a.e)));

    let mut out = vec![DayPlacement { left_pct: 0.0, width_pct: 100.0 }; events.len()];
    let mut cluster: Vec<(usize, i64, i64, usize)> = Vec::new(); // (idx, s, e, col)
    let mut cluster_end = -1i64;

    let flush = |cluster: &mut Vec<(usize, i64, i64, usize)>, out: &mut [DayPlacement]| {
        if cluster.is_empty() {
            return;
        }
        let cols = cluster.iter().map(|c| c.3).max().unwrap_or(0) + 1;
        for &(idx, _, _, col) in cluster.iter() {
            out[idx] = DayPlacement {
                left_pct: (col as f32 / cols as f32) * 100.0,
                width_pct: 100.0 / cols as f32,
            };
        }
        cluster.clear();
    };

    for it in items {
        if !cluster.is_empty() && it.s >= cluster_end {
            flush(&mut cluster, &mut out);
            cluster_end = -1;
        }
        let busy: Vec<usize> = cluster.iter().filter(|c| c.2 > it.s).map(|c| c.3).collect();
        let mut col = 0;
        while busy.contains(&col) {
            col += 1;
        }
        cluster.push((it.idx, it.s, it.e, col));
        cluster_end = cluster_end.max(it.e);
    }
    flush(&mut cluster, &mut out);
    out
}

fn minute_of_day(i: Instant, offset_minutes: i32) -> i64 {
    i.local(offset_minutes).minute_of_day() as i64
}

/// A laid-out banner segment, clipped to the visible `days` and assigned a stacking row
/// (`calendarUtils.BannerSeg`). `event_index` indexes the input `events` slice.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BannerSeg {
    pub event_index: usize,
    /// Inclusive column index into `days`.
    pub start_col: usize,
    /// Inclusive column index into `days`.
    pub end_col: usize,
    pub continues_before: bool,
    pub continues_after: bool,
    /// 0 = top row.
    pub row: usize,
}

/// The result of laying banners over a row of days.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BannerLayout {
    pub segs: Vec<BannerSeg>,
    pub rows: usize,
}

/// Lay all-day / multi-day banner events over a contiguous-or-gapped `days` array
/// (`calendarUtils.layoutBanners`): clip each to the visible range, then greedily stack overlapping bars into
/// rows so no two on a row touch. Longer, earlier events take the top rows.
pub fn layout_banners(events: &[EventInstance], days: &[Date], offset_minutes: i32) -> BannerLayout {
    if days.is_empty() {
        return BannerLayout::default();
    }
    let day_days: Vec<i64> = days.iter().map(|d| d.to_days()).collect();
    let first = day_days[0];
    let last = day_days[day_days.len() - 1];

    let mut items: Vec<(usize, i64, i64)> = events
        .iter()
        .enumerate()
        .filter(|(_, ev)| is_banner_event(ev, offset_minutes))
        .map(|(idx, ev)| {
            (idx, banner_start_day(ev, offset_minutes).to_days(), banner_end_day(ev, offset_minutes).to_days())
        })
        .filter(|&(_, s, e)| e >= first && s <= last)
        .collect();
    // Longer, earlier first (`a.s - b.s || b.e - a.e`); stable.
    items.sort_by(|a, b| a.1.cmp(&b.1).then(b.2.cmp(&a.2)));

    let mut rows_end: Vec<i64> = Vec::new(); // last end-col occupied on each row
    let mut segs = Vec::new();
    for (idx, s, e) in items {
        let continues_before = s < first;
        let continues_after = e > last;
        let start_col: isize = if continues_before {
            0
        } else {
            day_days.iter().position(|&t| t >= s).map(|p| p as isize).unwrap_or(-1)
        };
        let end_col: isize = if continues_after {
            days.len() as isize - 1
        } else {
            let mut idx_e = -1isize;
            for (i, &t) in day_days.iter().enumerate() {
                if t <= e {
                    idx_e = i as isize;
                }
            }
            idx_e
        };
        if start_col < 0 || end_col < 0 || start_col > end_col {
            continue;
        }
        let (start_col, end_col) = (start_col as usize, end_col as usize);
        let mut row = 0;
        while row < rows_end.len() && rows_end[row] >= start_col as i64 {
            row += 1;
        }
        if row < rows_end.len() {
            rows_end[row] = end_col as i64;
        } else {
            rows_end.push(end_col as i64);
        }
        segs.push(BannerSeg { event_index: idx, start_col, end_col, continues_before, continues_after, row });
    }
    BannerLayout { rows: rows_end.len(), segs }
}

/// Darken a `#rgb` / `#rrggbb` colour by `factor` in [0, 1] (`calendarUtils.shade`) — the darker continuation
/// tip of a banner that runs off the visible range.
pub fn shade(hex: &str, factor: f32) -> String {
    let h = hex.trim_start_matches('#');
    let h = match h.len() {
        3 => h.chars().flat_map(|c| [c, c]).collect::<String>(),
        6 => h.to_string(),
        _ => return hex.to_string(),
    };
    let Ok(n) = u32::from_str_radix(&h, 16) else {
        return hex.to_string();
    };
    let clamp = |v: f32| v.round().clamp(0.0, 255.0) as u32;
    let r = clamp(((n >> 16) & 0xff) as f32 * factor);
    let g = clamp(((n >> 8) & 0xff) as f32 * factor);
    let b = clamp((n & 0xff) as f32 * factor);
    format!("#{:06x}", (r << 16) | (g << 8) | b)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    fn ev(id: &str, start: &str, end: &str, all_day: bool) -> EventInstance {
        EventInstance {
            id: id.into(),
            event_id: id.into(),
            calendar_id: "c".into(),
            owner_id: "u".into(),
            title: id.into(),
            description: None,
            location: None,
            url: None,
            starts_at: start.into(),
            ends_at: end.into(),
            all_day,
            is_recurring: false,
            rrule: None,
            status: "confirmed".into(),
            visibility: "public".into(),
            busy: Some(true),
            timezone: None,
            ical_uid: id.into(),
            etag: String::new(),
            color: None,
            reminders: vec![],
            my_status: None,
            guests_can_modify: None,
            guests_can_invite: None,
            guests_can_see_guests: None,
            extra: BTreeMap::new(),
        }
    }

    #[test]
    fn month_grid_october_2026_monday_start() {
        // October 2026: 1st is Thursday. Monday-start grid begins Mon 2026-09-28, ends to fill whole weeks.
        let grid = month_grid(Date::new(2026, 10, 15).expect("d"), 1);
        assert_eq!(grid.len() % 7, 0);
        assert_eq!(grid[0], Date::new(2026, 9, 28).expect("d"));
        assert_eq!(grid[0].weekday_mon0(), 0);
        assert!(grid.contains(&Date::new(2026, 10, 1).expect("d")));
        assert!(grid.contains(&Date::new(2026, 10, 31).expect("d")));
    }

    #[test]
    fn overlap_splits_into_columns() {
        // 09:00–10:00, 09:30–10:30, 11:00–12:00 at UTC (offset 0).
        let evs = vec![
            ev("a", "2026-10-12T09:00:00Z", "2026-10-12T10:00:00Z", false),
            ev("b", "2026-10-12T09:30:00Z", "2026-10-12T10:30:00Z", false),
            ev("c", "2026-10-12T11:00:00Z", "2026-10-12T12:00:00Z", false),
        ];
        let p = layout_day_events(&evs, 0);
        // a and b overlap → two columns at 50% each.
        assert!((p[0].width_pct - 50.0).abs() < 0.01);
        assert!((p[1].width_pct - 50.0).abs() < 0.01);
        assert!((p[0].left_pct - 0.0).abs() < 0.01);
        assert!((p[1].left_pct - 50.0).abs() < 0.01);
        // c is alone → full width.
        assert!((p[2].width_pct - 100.0).abs() < 0.01);
    }

    #[test]
    fn banner_end_pulled_back_at_midnight() {
        let e = ev("a", "2026-10-12T00:00:00Z", "2026-10-13T00:00:00Z", false);
        // Ends exactly at local midnight → still a single day (the 12th).
        assert_eq!(banner_end_day(&e, 0), Date::new(2026, 10, 12).expect("d"));
        assert!(!is_banner_event(&e, 0));
    }

    #[test]
    fn all_day_banner_is_offset_independent() {
        let e = ev("a", "2026-10-12T00:00:00Z", "2026-10-14T23:59:59Z", true);
        assert!(is_banner_event(&e, 0));
        assert_eq!(banner_start_day(&e, 600), Date::new(2026, 10, 12).expect("d"));
        assert_eq!(banner_end_day(&e, 600), Date::new(2026, 10, 14).expect("d"));
    }

    #[test]
    fn banners_stack_into_rows() {
        let days: Vec<Date> = (12..=18).map(|d| Date::new(2026, 10, d).expect("d")).collect();
        let evs = vec![
            ev("x", "2026-10-12T00:00:00Z", "2026-10-15T23:59:59Z", true), // Mon–Thu
            ev("y", "2026-10-13T00:00:00Z", "2026-10-14T23:59:59Z", true), // Tue–Wed (overlaps x)
            ev("z", "2026-10-16T00:00:00Z", "2026-10-17T23:59:59Z", true), // Fri–Sat (free, row 0)
        ];
        let layout = layout_banners(&evs, &days, 0);
        assert_eq!(layout.rows, 2);
        let x = layout.segs.iter().find(|s| s.event_index == 0).expect("x");
        let y = layout.segs.iter().find(|s| s.event_index == 1).expect("y");
        let z = layout.segs.iter().find(|s| s.event_index == 2).expect("z");
        assert_eq!((x.start_col, x.end_col, x.row), (0, 3, 0));
        assert_eq!(y.row, 1);
        assert_eq!((z.start_col, z.end_col, z.row), (4, 5, 0));
    }

    #[test]
    fn banner_continues_flags_clip_to_window() {
        let days: Vec<Date> = (12..=18).map(|d| Date::new(2026, 10, d).expect("d")).collect();
        let evs = vec![ev("w", "2026-10-10T00:00:00Z", "2026-10-20T23:59:59Z", true)];
        let layout = layout_banners(&evs, &days, 0);
        let s = layout.segs[0];
        assert!(s.continues_before && s.continues_after);
        assert_eq!((s.start_col, s.end_col), (0, 6));
    }

    #[test]
    fn shade_darkens() {
        assert_eq!(shade("#1a73e8", 0.8), "#155cba");
        assert_eq!(shade("#fff", 0.5), "#808080");
        assert_eq!(shade("not-a-color", 0.5), "not-a-color");
    }
}
