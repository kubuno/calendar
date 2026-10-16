//! `MiniMonth` - the sidebar's mini-month navigator (`web/src/CalendarSidebarBody.tsx` MiniCalendar): a
//! month/year header with ‹ › arrows that walk the displayed month on their own, a narrow weekday row, and a
//! grid of round day cells. Today is a filled accent circle, the main view's date a light accent disc with an
//! accent ring, other-month days are dimmed, weekends are tertiary. Clicking a day moves the MAIN view's date.

use kubuno_desktop::prelude::MouseEventArgs;
use kubuno_desktop::ui::graphics::{Brush, Color, Font, FontStyle, Pen, StringAlignment, StringFormat, StringFormatFlags, StringTrimming};
use kubuno_desktop::ui::{Canvas, Rect, Size};
use kubuno_desktop::views::component::{Control, ControlCore, EventCx, PaintEventCx};
use kubuno_desktop::views::events::Event;

use kubuno_calendar_core::date::{self, Date, DateFormat, Lang};
use kubuno_calendar_core::layout::month_grid;

use crate::controls::model::{Palette, Shared};

/// A day was picked in the mini-month (the window moves the main view there).
#[derive(kubuno_desktop::views::events::EventArgs, Debug, Clone, Default, PartialEq)]
pub struct MiniDateArgs {
    pub date_iso: String,
}

const HDR_H: f32 = 28.0;
const DOW_H: f32 = 22.0;
const CELL: f32 = 28.0; // the round day disc (w-7 h-7)
const FR_NARROW: [&str; 7] = ["L", "M", "M", "J", "V", "S", "D"];
const EN_NARROW: [&str; 7] = ["M", "T", "W", "T", "F", "S", "S"];

#[derive(kubuno_desktop::views::component::Component, Default)]
#[kubuno(extends = Control, overrides(Control))]
#[category("Calendar")]
#[toolbox(icon = "calendar")]
#[default_event("DatePicked")]
pub struct MiniMonth {
    base: ControlCore,
    #[event]
    #[category("Action")]
    pub date_picked: Event<MiniDateArgs>,
    model: Option<Shared>,
    /// The month the mini-calendar currently displays (walked by the ‹ › arrows, independent of the main view).
    anchor: Date,
    inited: bool,
    /// Hit rectangles (control-relative): day cells → the day, and the two arrows (-1 / +1 month).
    day_hits: Vec<(Rect, Date)>,
    prev_hit: Rect,
    next_hit: Rect,
}

impl MiniMonth {
    pub fn set_model(&mut self, model: Shared) {
        self.model = Some(model);
        self.invalidate();
    }

    /// Re-centre the mini-month on the main view's current month (called when the main view navigates).
    pub fn sync_to(&mut self, month: Date) {
        self.anchor = month;
        self.inited = true;
        self.invalidate();
    }
}

impl Control for MiniMonth {
    fn get_preferred_size(&self, _canvas: &dyn Canvas, proposed: Size) -> Size {
        Size { width: proposed.width, height: HDR_H + DOW_H + CELL * 6.0 + 8.0 }
    }

    fn on_paint(&mut self, e: &mut PaintEventCx<'_>) {
        let th = Palette::of(kubuno_desktop::Application::theme().mode == kubuno_desktop::ui::ThemeMode::Dark);
        let g = e.graphics;
        let b = e.clip_rectangle;
        g.fill_rectangle(Brush::solid(th.surface0), b);
        self.day_hits.clear();
        let Some(model) = self.model.clone() else { return };
        let m = model.borrow();
        let lang = m.view.lang;
        let wso = m.view.week_starts_on;
        let today = m.view.today;
        let selected = m.view.current;
        if !self.inited {
            self.anchor = selected;
            self.inited = true;
        }
        let rel = |r: Rect| Rect::new(r.left - b.left, r.top - b.top, r.right - b.left, r.bottom - b.top);

        // Header: month/year, then the two arrows on the right.
        let f_hdr = Font::with_dip("Segoe UI", 13.0, FontStyle::BOLD);
        let near = StringFormat { alignment: StringAlignment::Near, line_alignment: StringAlignment::Center, trimming: StringTrimming::EllipsisCharacter, flags: StringFormatFlags::NO_WRAP };
        let center = StringFormat { alignment: StringAlignment::Center, line_alignment: StringAlignment::Center, trimming: StringTrimming::None, flags: StringFormatFlags::NO_WRAP };
        let title = capitalize(&date::format(self.anchor, DateFormat::MonthYear, lang));
        g.draw_string(&title, &f_hdr, Brush::solid(th.text_secondary), Rect::new(b.left + 8.0, b.top, b.right - 56.0, b.top + HDR_H), &near);
        let f_arrow = Font::with_dip("Segoe UI", 14.0, FontStyle::REGULAR);
        let prev = Rect::new(b.right - 48.0, b.top + 2.0, b.right - 28.0, b.top + 22.0);
        let next = Rect::new(b.right - 24.0, b.top + 2.0, b.right - 4.0, b.top + 22.0);
        g.draw_string("‹", &f_arrow, Brush::solid(th.text_tertiary), prev, &center);
        g.draw_string("›", &f_arrow, Brush::solid(th.text_tertiary), next, &center);
        self.prev_hit = rel(prev);
        self.next_hit = rel(next);

        let grid = month_grid(self.anchor, wso);
        let weeks = (grid.len() / 7).max(1);
        let cw = (b.right - b.left) / 7.0;
        let grid_left = b.left;

        // Weekday row (narrow, one letter per column, from each column's actual weekday).
        let f_dow = Font::with_dip("Segoe UI", 11.0, FontStyle::BOLD);
        let narrow = if lang == Lang::Fr { FR_NARROW } else { EN_NARROW };
        for (col, day) in grid.iter().take(7).enumerate() {
            let x = grid_left + col as f32 * cw;
            let label = narrow[day.weekday_mon0() as usize];
            g.draw_string(label, &f_dow, Brush::solid(th.text_tertiary), Rect::new(x, b.top + HDR_H, x + cw, b.top + HDR_H + DOW_H), &center);
        }

        // Day grid.
        let f_day = Font::with_dip("Segoe UI", 12.0, FontStyle::REGULAR);
        let f_day_b = Font::with_dip("Segoe UI", 12.0, FontStyle::BOLD);
        let grid_top = b.top + HDR_H + DOW_H;
        let row_h = CELL;
        for (i, &day) in grid.iter().enumerate() {
            let col = i % 7;
            let row = i / 7;
            if row >= weeks {
                break;
            }
            let cx = grid_left + col as f32 * cw + cw / 2.0;
            let cy = grid_top + row as f32 * row_h + row_h / 2.0;
            let disc = Rect::new(cx - CELL / 2.0, cy - CELL / 2.0, cx + CELL / 2.0, cy + CELL / 2.0);
            let is_today = day == today;
            let is_selected = day == selected && !is_today;
            let other_month = day.month != self.anchor.month;
            let (ink, font) = if is_today {
                g.fill_ellipse(Brush::solid(th.primary), disc);
                (Color::WHITE, &f_day_b)
            } else if is_selected {
                g.fill_ellipse(Brush::solid(th.primary.with_alpha(0.15)), disc);
                g.draw_ellipse(&Pen::new(th.primary, 1.0), disc);
                (th.primary, &f_day_b)
            } else if other_month {
                (th.text_tertiary.with_alpha(0.4), &f_day)
            } else if day.is_weekend() {
                (th.text_tertiary, &f_day)
            } else {
                (th.text_primary, &f_day)
            };
            g.draw_string(&day.day.to_string(), font, Brush::solid(ink), disc, &center);
            // Hit the whole column cell, not just the disc, like the web button.
            let cell = Rect::new(grid_left + col as f32 * cw, grid_top + row as f32 * row_h, grid_left + (col + 1) as f32 * cw, grid_top + (row + 1) as f32 * row_h);
            self.day_hits.push((rel(cell), day));
        }
        e.raise(self, "OnPaint");
    }

    fn on_mouse_down(&mut self, e: &mut EventCx<'_, MouseEventArgs>) {
        let (x, y) = (e.args().x, e.args().y);
        if self.prev_hit.contains(x, y) {
            self.anchor = self.anchor.add_months(-1);
            self.invalidate();
        } else if self.next_hit.contains(x, y) {
            self.anchor = self.anchor.add_months(1);
            self.invalidate();
        } else if let Some((_, day)) = self.day_hits.iter().find(|(r, _)| r.contains(x, y)).copied() {
            self.raise_date_picked(MiniDateArgs { date_iso: day.iso() });
        }
        e.raise(&*self, "OnMouseDown");
    }
}

/// Upper-case the first character (the web's `capitalize` for « octobre 2026 »).
fn capitalize(s: &str) -> String {
    let mut c = s.chars();
    match c.next() {
        Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
        None => String::new(),
    }
}
