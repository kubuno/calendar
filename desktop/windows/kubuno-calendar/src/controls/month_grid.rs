//! `MonthGrid` — the month view (`web/src/MonthView.tsx`): the weekday header, the 4/5/6-week grid from the
//! core's `month_grid`, the all-day/multi-day banners stacked per week (`layout_banners`) and, under them, up
//! to four timed chips a day (`timed_events_for_day`) then « +N ». The today cell carries the accent circle
//! and a principal moon marker. Read-only in Increment A; navigation is in the window toolbar.

use kubuno_desktop::ui::graphics::{Brush, Color, Font, FontStyle, Pen, PointF, StringAlignment, StringFormat, StringFormatFlags, StringTrimming};
use kubuno_desktop::ui::{Canvas, Rect, Size};
use kubuno_desktop::views::component::{Component, Control, ControlCore, PaintEventCx};

use kubuno_calendar_core::date::{self, DateFormat};
use kubuno_calendar_core::layout::{layout_banners, month_grid, timed_events_for_day, MONTH_MAX_CHIPS};
use kubuno_calendar_core::model::Instant;
use kubuno_calendar_core::moon::principal_phase_of_day;

use crate::controls::model::{color_of, sample_state, Palette, Shared};

const DOW_H: f32 = 28.0;
const BANNER_H: f32 = 18.0;
const BANNER_STEP: f32 = 20.0;
const CHIP_H: f32 = 17.0;
const CHIP_STEP: f32 = 19.0;
const DEFAULT_EVENT_COLOR: u32 = 0x1a73e8;

#[derive(kubuno_desktop::views::component::Component, Default)]
#[kubuno(extends = Control, overrides(Control))]
#[category("Calendar")]
#[toolbox(icon = "calendar")]
pub struct MonthGrid {
    base: ControlCore,
    model: Option<Shared>,
    bounds: Rect,
}

impl MonthGrid {
    pub fn set_model(&mut self, model: Shared) {
        self.model = Some(model);
        self.invalidate();
    }
}

impl Control for MonthGrid {
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
        let near = |a| StringFormat { alignment: a, line_alignment: StringAlignment::Center, trimming: StringTrimming::EllipsisCharacter, flags: StringFormatFlags::NO_WRAP };

        let grid = month_grid(m.view.current, m.view.week_starts_on);
        let weeks = (grid.len() / 7).max(1);
        let cw = (b.right - b.left) / 7.0;

        // Weekday header.
        let small = Font::with_dip("Segoe UI", 11.0, FontStyle::BOLD);
        for (k, day) in grid.iter().enumerate().take(7) {
            let x = b.left + k as f32 * cw;
            let label = capitalize(&date::format(*day, DateFormat::WeekdayShort, lang));
            g.draw_string(&label, &small, Brush::solid(th.text_tertiary), Rect::new(x, b.top, x + cw, b.top + DOW_H), &near(StringAlignment::Center));
            if k < 6 {
                g.draw_line(&Pen::new(th.border, 1.0), PointF::new(x + cw - 0.5, b.top), PointF::new(x + cw - 0.5, b.top + DOW_H));
            }
        }
        g.draw_line(&Pen::new(th.border, 1.0), PointF::new(b.left, b.top + DOW_H - 0.5), PointF::new(b.right, b.top + DOW_H - 0.5));

        let grid_top = b.top + DOW_H;
        let week_h = ((b.bottom - grid_top) / weeks as f32).max(80.0);
        let f10 = Font::with_dip("Segoe UI", 10.0, FontStyle::REGULAR);
        let f12 = Font::with_dip("Segoe UI", 12.0, FontStyle::REGULAR);

        for wk in 0..weeks {
            let week_top = grid_top + wk as f32 * week_h;
            let week_days = &grid[wk * 7..wk * 7 + 7];
            // Day cells: background, borders, day number, today accent, moon marker.
            for (col, &day) in week_days.iter().enumerate() {
                let r = Rect::new(b.left + col as f32 * cw, week_top, b.left + (col + 1) as f32 * cw, week_top + week_h);
                if day.month != m.view.current.month {
                    g.fill_rectangle(Brush::solid(th.surface1), r);
                }
                g.draw_line(&Pen::new(th.border, 1.0), PointF::new(r.right - 0.5, r.top), PointF::new(r.right - 0.5, r.bottom));
                g.draw_line(&Pen::new(th.border, 1.0), PointF::new(r.left, r.bottom - 0.5), PointF::new(r.right, r.bottom - 0.5));
                let num = Rect::new(r.left + 6.0, r.top + 4.0, r.left + 24.0, r.top + 22.0);
                if day == m.view.today {
                    g.fill_ellipse(Brush::solid(th.primary), Rect::new(num.left, num.top, num.left + 20.0, num.top + 20.0));
                    g.draw_string(&day.day.to_string(), &f12, Brush::solid(Color::WHITE), Rect::new(num.left, num.top, num.left + 20.0, num.top + 20.0), &near(StringAlignment::Center));
                } else {
                    let ink = if day.month == m.view.current.month { th.text_secondary } else { th.text_tertiary };
                    g.draw_string(&day.day.to_string(), &f12, Brush::solid(ink), num, &near(StringAlignment::Center));
                }
                // Principal moon phase marker (top-right of the cell).
                if principal_phase_of_day(day, offset).is_some() {
                    let mr = Rect::new(r.right - 18.0, r.top + 6.0, r.right - 6.0, r.top + 18.0);
                    g.fill_ellipse(Brush::solid(th.surface3), mr);
                    g.draw_ellipse(&Pen::new(th.text_tertiary, 1.0), mr);
                }
            }

            // Banners spanning columns (all-day / multi-day).
            let banners = layout_banners(&m.events, week_days, offset);
            let banner_base = week_top + 26.0;
            for seg in &banners.segs {
                let ev = &m.events[seg.event_index];
                let x0 = b.left + seg.start_col as f32 * cw + 3.0;
                let x1 = b.left + (seg.end_col + 1) as f32 * cw - 3.0;
                let y = banner_base + seg.row as f32 * BANNER_STEP;
                let bar = Rect::new(x0, y, x1, y + BANNER_H);
                let color = color_of(ev.color.as_deref().unwrap_or("#1a73e8"), crate::controls::model::hex(DEFAULT_EVENT_COLOR));
                g.fill_rounded_rectangle(Brush::solid(color), bar, 4.0);
                g.draw_string(&ev.title, &f10, Brush::solid(Color::WHITE), Rect::new(bar.left + 6.0, bar.top, bar.right - 4.0, bar.bottom), &near(StringAlignment::Near));
            }

            // Timed chips under the banners, per day.
            let chips_top = banner_base + banners.rows as f32 * BANNER_STEP + 2.0;
            for (col, &day) in week_days.iter().enumerate() {
                let x = b.left + col as f32 * cw;
                let chips = timed_events_for_day(&m.events, day, offset);
                let mut y = chips_top;
                for ev in chips.iter().take(MONTH_MAX_CHIPS) {
                    let color = color_of(ev.color.as_deref().unwrap_or("#1a73e8"), crate::controls::model::hex(DEFAULT_EVENT_COLOR));
                    let chip = Rect::new(x + 4.0, y, x + cw - 4.0, y + CHIP_H);
                    g.fill_ellipse(Brush::solid(color), Rect::new(chip.left, chip.top + 5.0, chip.left + 7.0, chip.top + 12.0));
                    let label = format!("{} {}", hhmm(ev, offset), ev.title);
                    g.draw_string(&label, &f10, Brush::solid(th.text_primary), Rect::new(chip.left + 12.0, chip.top, chip.right, chip.bottom), &near(StringAlignment::Near));
                    y += CHIP_STEP;
                }
                if chips.len() > MONTH_MAX_CHIPS {
                    g.draw_string(&format!("+{}", chips.len() - MONTH_MAX_CHIPS), &f10, Brush::solid(th.text_tertiary), Rect::new(x + 8.0, y, x + cw, y + 14.0), &near(StringAlignment::Near));
                }
            }
        }
        e.raise(self, "OnPaint");
    }
}

/// « H:MM » of the event's local start time.
fn hhmm(ev: &kubuno_calendar_core::model::EventInstance, offset: i32) -> String {
    match Instant::parse(&ev.starts_at) {
        Some(i) => {
            let l = i.local(offset);
            format!("{}:{:02}", l.hour, l.minute)
        }
        None => String::new(),
    }
}

/// The first letter upper-cased (the web's `capitalize`).
fn capitalize(s: &str) -> String {
    let mut c = s.chars();
    match c.next() {
        Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
        None => String::new(),
    }
}
