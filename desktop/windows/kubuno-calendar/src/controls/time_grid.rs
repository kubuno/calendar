//! `TimeGrid` — the Day and Week time grids (`web/src/DayView.tsx`, `WeekView.tsx`): a left hour gutter, a day
//! header, an all-day banner row and a scrollable 24-hour grid (`PX_PER_HOUR` = 40) where timed events are
//! positioned by their local minutes and laid side by side when they overlap (the core's `layout_day`). The
//! « now » line is drawn in red on today's column. Geometry and colours match the web. Read-only in this
//! increment; the wheel scrolls the grid.

use kubuno_desktop::ui::graphics::{Brush, Color, Font, FontStyle, Pen, PointF, StringAlignment, StringFormat, StringFormatFlags, StringTrimming};
use kubuno_desktop::ui::{Canvas, Rect, Size};
use kubuno_desktop::views::component::{Component, Control, ControlCore, EventCx, PaintEventCx};
use kubuno_desktop::prelude::MouseEventArgs;

use kubuno_calendar_core::date::{self, Date, DateFormat};
use kubuno_calendar_core::layout::{layout_banners, layout_day, timed_events_for_day, week_days, PX_PER_HOUR};
use kubuno_calendar_core::model::Instant;
use kubuno_calendar_desktop_common::state::ViewMode;

use crate::controls::draw::{draw_banner, draw_timed_block};
use crate::controls::model::{hex, sample_state, Palette, Shared};

const GUTTER: f32 = 60.0; // single-timezone hour gutter (WeekView.tsx:146)
const HEADER_H: f32 = 62.0; // weekday label + 32px date circle
const BANNER_H: f32 = 22.0; // EventBanners.tsx:9
const BANNER_STEP: f32 = 24.0; // 22 + rowGap 2
const DANGER: u32 = 0xd93025;

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
        let day_view = m.view.view == ViewMode::Day;
        let days = self.days(m.view.view, m.view.current, m.view.week_starts_on, m.view.show_weekends);
        if days.is_empty() {
            return;
        }
        let fmt = |a| StringFormat { alignment: a, line_alignment: StringAlignment::Center, trimming: StringTrimming::EllipsisCharacter, flags: StringFormatFlags::NO_WRAP };

        let n = days.len();
        let day_w = (b.right - b.left - GUTTER) / n as f32;

        let banners = layout_banners(&m.events, &days, offset);
        let allday_h = if banners.rows > 0 { banners.rows as f32 * BANNER_STEP + 8.0 } else { 0.0 };
        let grid_top = b.top + HEADER_H + allday_h;

        if !self.scrolled_init {
            self.scroll_y = 6.0 * PX_PER_HOUR; // open on the morning
            self.scrolled_init = true;
        }
        let content_h = 24.0 * PX_PER_HOUR;
        let visible_h = (b.bottom - grid_top).max(0.0);
        let max_scroll = (content_h - visible_h).max(0.0);
        let scroll = self.scroll_y.clamp(0.0, max_scroll);

        // Fonts.
        let f_dow = Font::with_dip("Segoe UI", 12.0, FontStyle::REGULAR);
        let f_num = Font::with_dip("Segoe UI", 14.0, FontStyle::REGULAR);
        let f_hour = Font::with_dip("Segoe UI", 11.0, FontStyle::REGULAR);
        let f_title = Font::with_dip("Segoe UI", 12.0, FontStyle::BOLD); // font-semibold
        let f_time = Font::with_dip("Segoe UI", if day_view { 12.0 } else { 10.0 }, FontStyle::REGULAR);

        // Column headers.
        for (k, &day) in days.iter().enumerate() {
            let x = b.left + GUTTER + k as f32 * day_w;
            if day.is_weekend() {
                g.fill_rectangle(Brush::solid(th.surface1), Rect::new(x, b.top, x + day_w, b.top + HEADER_H));
            }
            let wd_color = if day.is_weekend() { th.text_tertiary } else { th.text_secondary };
            g.draw_string(&date::format(day, DateFormat::WeekdayShort, lang).to_uppercase(), &f_dow, Brush::solid(wd_color), Rect::new(x, b.top + 6.0, x + day_w, b.top + 24.0), &fmt(StringAlignment::Center));
            let cx = x + day_w / 2.0;
            let bx = Rect::new(cx - 16.0, b.top + 24.0, cx + 16.0, b.top + 56.0); // 32px circle
            if day == m.view.today {
                g.fill_ellipse(Brush::solid(th.primary), bx);
                g.draw_string(&day.day.to_string(), &f_num, Brush::solid(Color::WHITE), bx, &fmt(StringAlignment::Center));
            } else {
                let ink = if day.is_weekend() { th.text_tertiary } else { th.text_primary };
                g.draw_string(&day.day.to_string(), &f_num, Brush::solid(ink), bx, &fmt(StringAlignment::Center));
            }
            if k > 0 {
                g.draw_line(&Pen::new(th.border, 1.0), PointF::new(x - 0.5, b.top), PointF::new(x - 0.5, b.bottom));
            }
        }

        // All-day banner row (bg + bottom border), bars via the shared helper.
        if banners.rows > 0 {
            g.draw_line(&Pen::new(th.border, 1.0), PointF::new(b.left, grid_top - 0.5), PointF::new(b.right, grid_top - 0.5));
        }
        for seg in &banners.segs {
            let ev = &m.events[seg.event_index];
            let x0 = b.left + GUTTER + seg.start_col as f32 * day_w;
            let x1 = b.left + GUTTER + (seg.end_col + 1) as f32 * day_w;
            let y = b.top + HEADER_H + 4.0 + seg.row as f32 * BANNER_STEP;
            draw_banner(g, x0, x1, y, BANNER_H, ev.color.as_deref().unwrap_or("#1a73e8"), seg.continues_before, seg.continues_after, !seg.continues_after, &ev.title, &f_title);
        }

        // Scrollable grid: clip to the grid region.
        let state = g.save();
        g.intersect_clip(Rect::new(b.left, grid_top, b.right, b.bottom));
        for h in 0..=24 {
            let y = grid_top + h as f32 * PX_PER_HOUR - scroll;
            if y >= grid_top - 1.0 && y <= b.bottom + 1.0 {
                // Solid hour line (border @60%).
                g.draw_line(&Pen::new(th.border.with_alpha(0.6), 1.0), PointF::new(b.left + GUTTER, y), PointF::new(b.right, y));
                if h < 24 && h > 0 {
                    g.draw_string(&format!("{h:02}:00"), &f_hour, Brush::solid(th.text_tertiary), Rect::new(b.left, y - 8.0, b.left + GUTTER - 8.0, y + 8.0), &fmt(StringAlignment::Far));
                }
            }
            // Half-hour guide (border @40%).
            let yh = y + PX_PER_HOUR / 2.0;
            if h < 24 && yh >= grid_top - 1.0 && yh <= b.bottom + 1.0 {
                g.draw_line(&Pen::new(th.border.with_alpha(0.4), 1.0), PointF::new(b.left + GUTTER, yh), PointF::new(b.right, yh));
            }
        }
        // Timed events per column.
        for (k, &day) in days.iter().enumerate() {
            let col_x = b.left + GUTTER + k as f32 * day_w;
            let refs = timed_events_for_day(&m.events, day, offset);
            for blk in layout_day(&refs, offset) {
                let ev = refs[blk.index];
                let top = grid_top + blk.top_min as f32 / 60.0 * PX_PER_HOUR - scroll;
                let height = ((blk.end_min - blk.top_min) as f32 / 60.0 * PX_PER_HOUR).max(20.0);
                let x = col_x + day_w * blk.left_pct / 100.0 + 2.0;
                let w = day_w * blk.width_pct / 100.0 - 4.0;
                let mut sub = time_range(ev, offset);
                if let Some(loc) = ev.location.as_deref().filter(|s| !s.is_empty()) {
                    sub = format!("{sub} · {loc}");
                }
                draw_timed_block(g, Rect::new(x, top, x + w, top + height), ev.color.as_deref().unwrap_or("#1a73e8"), &ev.title, &sub, &f_title, &f_time);
            }
        }
        // The « now » line + gutter pill.
        let platform = kubuno_calendar_desktop_common::platform::current();
        let today = platform.clock.today();
        if let Some(col) = days.iter().position(|&d| d == today) {
            let now_min = ((platform.clock.now_ms() / 1000 + offset as i64 * 60).rem_euclid(86_400)) as f32 / 60.0;
            let y = grid_top + now_min / 60.0 * PX_PER_HOUR - scroll;
            if y >= grid_top && y <= b.bottom {
                // The leading round dot was removed on request; the line and the gutter time pill remain.
                let x0 = b.left + GUTTER + col as f32 * day_w;
                g.draw_line(&Pen::new(hex(DANGER), 2.0), PointF::new(x0, y), PointF::new(x0 + day_w, y));
                // Gutter pill with the current time.
                let pill = Rect::new(b.left + GUTTER - 46.0, y - 9.0, b.left + GUTTER - 4.0, y + 9.0);
                g.fill_rounded_rectangle(Brush::solid(hex(DANGER)), pill, 8.0);
                let hm = format!("{:02}:{:02}", (now_min as i32) / 60, (now_min as i32) % 60);
                g.draw_string(&hm, &Font::with_dip("Segoe UI", 10.0, FontStyle::BOLD), Brush::solid(Color::WHITE), pill, &fmt(StringAlignment::Center));
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

/// « HH:MM – HH:MM » in the viewer's zone (the web day/week block subtitle).
fn time_range(ev: &kubuno_calendar_core::model::EventInstance, offset: i32) -> String {
    let hm = |iso: &str| Instant::parse(iso).map(|i| i.local(offset)).map(|l| format!("{}:{:02}", l.hour, l.minute)).unwrap_or_default();
    format!("{} – {}", hm(&ev.starts_at), hm(&ev.ends_at))
}
