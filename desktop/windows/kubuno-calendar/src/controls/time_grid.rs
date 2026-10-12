//! `TimeGrid` — the Day and Week time grids (`web/src/DayView.tsx`, `WeekView.tsx`): a left hour gutter, a day
//! header, an all-day banner row and a scrollable 24-hour grid (`PX_PER_HOUR` = 40) where timed events are
//! positioned by their local minutes and laid side by side when they overlap (the core's `layout_day`). The
//! « now » line is drawn in red on today's column. Read-only in this increment; the wheel scrolls the grid.

use kubuno_desktop::prelude::*;
use kubuno_desktop::ui::graphics::{Brush, Color, Font, FontStyle, Pen, PointF, StringAlignment, StringFormat, StringFormatFlags, StringTrimming};
use kubuno_desktop::ui::{Canvas, Rect, Size};
use kubuno_desktop::views::component::{Component, Control, ControlCore, EventCx, PaintEventCx};

use kubuno_calendar_core::date::{self, DateFormat, Date};
use kubuno_calendar_core::layout::{layout_banners, layout_day, timed_events_for_day, week_days, PX_PER_HOUR};
use kubuno_calendar_core::model::Instant;
use kubuno_calendar_desktop_common::state::ViewMode;

use crate::controls::model::{color_of, hex, sample_state, Palette, Shared};

const GUTTER: f32 = 56.0;
const HEADER_H: f32 = 56.0;
const BANNER_H: f32 = 18.0;
const BANNER_STEP: f32 = 20.0;
const DEFAULT_EVENT_COLOR: u32 = 0x1a73e8;

#[derive(kubuno_desktop::views::component::Component, Default)]
#[kubuno(extends = Control, overrides(Control))]
#[category("Calendar")]
#[toolbox(icon = "calendar")]
pub struct TimeGrid {
    base: ControlCore,
    model: Option<Shared>,
    bounds: Rect,
    scroll_y: f32,
    scrolled_init: bool,
}

impl TimeGrid {
    pub fn set_model(&mut self, model: Shared) {
        self.model = Some(model);
        self.scrolled_init = false;
        self.invalidate();
    }

    fn days(&self, view: ViewMode, anchor: Date, week_starts_on: u32, show_weekends: bool) -> Vec<Date> {
        match view {
            ViewMode::Day => vec![anchor],
            _ => {
                let all = week_days(anchor, week_starts_on, 7);
                if show_weekends {
                    all
                } else {
                    all.into_iter().filter(|d| !d.is_weekend()).collect()
                }
            }
        }
    }
}

impl Control for TimeGrid {
    fn get_preferred_size(&self, _canvas: &dyn Canvas, proposed: Size) -> Size {
        proposed
    }

    fn on_paint(&mut self, e: &mut PaintEventCx<'_>) {
        self.bounds = e.clip_rectangle;
        if self.model.is_none() && self.design_mode() {
            self.model = Some(std::rc::Rc::new(std::cell::RefCell::new(sample_state())));
        }
        let th = Palette::of(kubuno_desktop::Application::theme().mode == kubuno_desktop::ui::ThemeMode::Dark);
        let g = e.graphics;
        let b = self.bounds;
        g.fill_rectangle(Brush::solid(th.surface0), b);
        let Some(model) = self.model.clone() else { return };
        let m = model.borrow();
        let lang = m.view.lang;
        let offset = m.offset_minutes;
        let days = self.days(m.view.view, m.view.current, m.view.week_starts_on, m.view.show_weekends);
        if days.is_empty() {
            return;
        }
        let near = |a| StringFormat { alignment: a, line_alignment: StringAlignment::Center, trimming: StringTrimming::EllipsisCharacter, flags: StringFormatFlags::NO_WRAP };

        let n = days.len();
        let day_w = (b.right - b.left - GUTTER) / n as f32;

        // All-day banner row.
        let banners = layout_banners(&m.events, &days, offset);
        let allday_h = if banners.rows > 0 { banners.rows as f32 * BANNER_STEP + 6.0 } else { 0.0 };
        let grid_top = b.top + HEADER_H + allday_h;

        // First paint of a view: scroll so the morning (06:00) is in view.
        if !self.scrolled_init {
            self.scroll_y = 6.0 * PX_PER_HOUR;
            self.scrolled_init = true;
        }
        let content_h = 24.0 * PX_PER_HOUR;
        let visible_h = (b.bottom - grid_top).max(0.0);
        let max_scroll = (content_h - visible_h).max(0.0);
        let scroll = self.scroll_y.clamp(0.0, max_scroll);

        // Header: weekday + day number per column.
        let f11 = Font::with_dip("Segoe UI", 11.0, FontStyle::BOLD);
        let f20 = Font::with_dip("Segoe UI", 20.0, FontStyle::REGULAR);
        let f10 = Font::with_dip("Segoe UI", 10.0, FontStyle::REGULAR);
        for (k, &day) in days.iter().enumerate() {
            let x = b.left + GUTTER + k as f32 * day_w;
            let label = capitalize(&date::format(day, DateFormat::WeekdayShort, lang));
            g.draw_string(&label, &f11, Brush::solid(th.text_tertiary), Rect::new(x, b.top + 6.0, x + day_w, b.top + 24.0), &near(StringAlignment::Center));
            let num = Rect::new(x, b.top + 22.0, x + day_w, b.top + 52.0);
            if day == m.view.today {
                let c = Rect::new(x + day_w / 2.0 - 16.0, num.top, x + day_w / 2.0 + 16.0, num.top + 32.0);
                g.fill_ellipse(Brush::solid(th.primary), c);
                g.draw_string(&day.day.to_string(), &f20, Brush::solid(Color::WHITE), c, &near(StringAlignment::Center));
            } else {
                g.draw_string(&day.day.to_string(), &f20, Brush::solid(th.text_primary), num, &near(StringAlignment::Center));
            }
            if k > 0 {
                g.draw_line(&Pen::new(th.border, 1.0), PointF::new(x - 0.5, b.top), PointF::new(x - 0.5, b.bottom));
            }
        }

        // All-day banners spanning columns.
        for seg in &banners.segs {
            let ev = &m.events[seg.event_index];
            let x0 = b.left + GUTTER + seg.start_col as f32 * day_w + 3.0;
            let x1 = b.left + GUTTER + (seg.end_col + 1) as f32 * day_w - 3.0;
            let y = b.top + HEADER_H + seg.row as f32 * BANNER_STEP;
            let bar = Rect::new(x0, y, x1, y + BANNER_H);
            let color = color_of(ev.color.as_deref().unwrap_or("#1a73e8"), hex(DEFAULT_EVENT_COLOR));
            g.fill_rounded_rectangle(Brush::solid(color), bar, 4.0);
            g.draw_string(&ev.title, &f10, Brush::solid(Color::WHITE), Rect::new(bar.left + 6.0, bar.top, bar.right - 4.0, bar.bottom), &near(StringAlignment::Near));
        }
        g.draw_line(&Pen::new(th.border, 1.0), PointF::new(b.left, grid_top - 0.5), PointF::new(b.right, grid_top - 0.5));

        // The scrollable grid: clip to the grid region.
        let state = g.save();
        g.intersect_clip(Rect::new(b.left, grid_top, b.right, b.bottom));
        // Hour lines + gutter labels.
        for h in 0..=24 {
            let y = grid_top + h as f32 * PX_PER_HOUR - scroll;
            if y < grid_top - 1.0 || y > b.bottom + 1.0 {
                continue;
            }
            g.draw_line(&Pen::new(th.surface2, 1.0), PointF::new(b.left + GUTTER, y), PointF::new(b.right, y));
            if h < 24 {
                g.draw_string(&format!("{h:02}:00"), &f10, Brush::solid(th.text_tertiary), Rect::new(b.left + 6.0, y + 2.0, b.left + GUTTER - 6.0, y + 18.0), &near(StringAlignment::Near));
            }
        }
        // Timed events per column.
        for (k, &day) in days.iter().enumerate() {
            let col_x = b.left + GUTTER + k as f32 * day_w;
            let refs = timed_events_for_day(&m.events, day, offset);
            for blk in layout_day(&refs, offset) {
                let ev = refs[blk.index];
                let top = grid_top + blk.top_min as f32 / 60.0 * PX_PER_HOUR - scroll;
                let height = ((blk.end_min - blk.top_min) as f32 / 60.0 * PX_PER_HOUR).max(18.0);
                let x = col_x + day_w * blk.left_pct / 100.0 + 1.0;
                let w = day_w * blk.width_pct / 100.0 - 2.0;
                let rect = Rect::new(x, top, x + w, top + height);
                let color = color_of(ev.color.as_deref().unwrap_or("#1a73e8"), hex(DEFAULT_EVENT_COLOR));
                g.fill_rounded_rectangle(Brush::solid(color), rect, 4.0);
                let label = format!("{} {}", hhmm(ev, offset), ev.title);
                g.draw_string(&label, &f10, Brush::solid(Color::WHITE), Rect::new(rect.left + 5.0, rect.top + 2.0, rect.right - 3.0, rect.bottom), &near(StringAlignment::Near));
            }
        }
        // The « now » line.
        let platform = kubuno_calendar_desktop_common::platform::current();
        let today = platform.clock.today();
        if let Some(col) = days.iter().position(|&d| d == today) {
            let now_min = ((platform.clock.now_ms() / 1000 + offset as i64 * 60).rem_euclid(86_400)) as f32 / 60.0;
            let y = grid_top + now_min / 60.0 * PX_PER_HOUR - scroll;
            if y >= grid_top && y <= b.bottom {
                let x0 = b.left + GUTTER + col as f32 * day_w;
                g.fill_ellipse(Brush::solid(hex(0xd93025)), Rect::new(x0 - 4.0, y - 4.0, x0 + 4.0, y + 4.0));
                g.draw_line(&Pen::new(hex(0xd93025), 2.0), PointF::new(x0, y), PointF::new(x0 + day_w, y));
            }
        }
        g.restore(state);
        e.raise(self, "OnPaint");
    }

    fn on_mouse_wheel(&mut self, e: &mut EventCx<'_, MouseEventArgs>) {
        self.scroll_y = (self.scroll_y - e.args().delta * 60.0).max(0.0);
        self.scrolled_init = true;
        self.invalidate();
        e.raise(&*self, "OnMouseWheel");
    }
}

fn hhmm(ev: &kubuno_calendar_core::model::EventInstance, offset: i32) -> String {
    match Instant::parse(&ev.starts_at) {
        Some(i) => {
            let l = i.local(offset);
            format!("{}:{:02}", l.hour, l.minute)
        }
        None => String::new(),
    }
}

fn capitalize(s: &str) -> String {
    let mut c = s.chars();
    match c.next() {
        Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
        None => String::new(),
    }
}
