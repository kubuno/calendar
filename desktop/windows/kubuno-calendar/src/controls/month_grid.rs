//! `MonthGrid` - the month view (`web/src/MonthView.tsx`): the weekday header, the 4/5/6-week grid from the
//! core's `month_grid`, the all-day/multi-day banners stacked per week (`layout_banners`) and, under them, up
//! to four timed chips a day (`timed_events_for_day`) then « +N ». The today cell carries the accent circle
//! and a principal moon marker. Geometry and colours match the web exactly. Read-only in this increment;
//! navigation is in the window toolbar.

use kubuno_desktop::prelude::MouseEventArgs;
use kubuno_desktop::ui::graphics::{Brush, Color, Font, FontStyle, Pen, PointF, StringAlignment, StringFormat, StringFormatFlags, StringTrimming};
use kubuno_desktop::ui::{Canvas, Rect, Size};
use kubuno_desktop::views::component::{Component, Control, ControlCore, EventCx, PaintEventCx};
use kubuno_desktop::views::events::Event;

/// A double-click in the month grid: on an event (`event_id` set) or on an empty day (`event_id` empty); the
/// window opens the editor to edit that event, or to create one on `date_iso` (`YYYY-MM-DD`).
#[derive(kubuno_desktop::views::events::EventArgs, Debug, Clone, Default, PartialEq)]
pub struct ActivateArgs {
    pub event_id: String,
    pub date_iso: String,
}

use kubuno_calendar_core::date::{self, DateFormat};
use kubuno_calendar_core::layout::{layout_banners, month_grid, timed_events_for_day, MONTH_MAX_CHIPS};
use kubuno_calendar_core::model::{EventInstance, Instant};
use kubuno_calendar_core::moon::principal_phase_of_day;

use crate::controls::draw::{draw_banner, draw_event_pill, draw_principal_moon};
use crate::controls::model::{Palette, Shared, sample_state};

// Geometry from MonthView.tsx.
const DOW_H: f32 = 32.0; // py-2 (8) + text-xs (16) rounded
const NUM_BOX: f32 = 28.0; // w-7 h-7
const BANNER_TOP: f32 = 34.0; // MonthView.tsx:115
const BANNER_BAR_H: f32 = 18.0;
const BANNER_ROW_H: f32 = 20.0;
const CHIP_H: f32 = 18.0;
const CHIP_STEP: f32 = 20.0; // chip + space-y-0.5 (2)

#[derive(kubuno_desktop::views::component::Component, Default)]
#[kubuno(extends = Control, overrides(Control))]
#[category("Calendar")]
#[toolbox(icon = "calendar")]
#[default_event("Activated")]
pub struct MonthGrid {
    base: ControlCore,
    /// Occurs on a double click on an event or a day.
    #[event]
    #[category("Action")]
    pub activated: Event<ActivateArgs>,
    model: Option<Shared>,
    bounds: Rect,
    /// Hit rectangles (control-relative) of the drawn event chips/banners → event id.
    hits: Vec<(Rect, String)>,
    /// Hit rectangles (control-relative) of the day cells → `YYYY-MM-DD`.
    cells: Vec<(Rect, String)>,
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
        // Only the calendars the sidebar keeps visible.
        let events = m.visible_events();
        let lang = m.view.lang;
        let offset = m.offset_minutes;
        let fmt = |a| StringFormat { alignment: a, line_alignment: StringAlignment::Center, trimming: StringTrimming::EllipsisCharacter, flags: StringFormatFlags::NO_WRAP };
        self.hits.clear();
        self.cells.clear();
        // Control-relative rectangle, for hit-testing on_mouse_down (whose coordinates are control-relative).
        let rel = |r: Rect| Rect::new(r.left - b.left, r.top - b.top, r.right - b.left, r.bottom - b.top);

        let grid = month_grid(m.view.current, m.view.week_starts_on);
        let weeks = (grid.len() / 7).max(1);
        let cw = (b.right - b.left) / 7.0;

        // Weekday header: text-xs (12), UPPERCASE, regular, tertiary.
        let f_dow = Font::with_dip("Segoe UI", 12.0, FontStyle::REGULAR);
        for (k, day) in grid.iter().enumerate().take(7) {
            let x = b.left + k as f32 * cw;
            let label = date::format(*day, DateFormat::WeekdayShort, lang).to_uppercase();
            g.draw_string(&label, &f_dow, Brush::solid(th.text_tertiary), Rect::new(x, b.top, x + cw, b.top + DOW_H), &fmt(StringAlignment::Center));
        }
        g.draw_line(&Pen::new(th.border, 1.0), PointF::new(b.left, b.top + DOW_H - 0.5), PointF::new(b.right, b.top + DOW_H - 0.5));

        let grid_top = b.top + DOW_H;
        let week_h = ((b.bottom - grid_top) / weeks as f32).max(80.0);
        let f_num = Font::with_dip("Segoe UI", 14.0, FontStyle::REGULAR); // text-sm font-medium
        let f_time = Font::with_dip("Segoe UI", 11.0, FontStyle::REGULAR);
        let f_title = Font::with_dip("Segoe UI", 12.0, FontStyle::REGULAR);
        let f_more = Font::with_dip("Segoe UI", 12.0, FontStyle::REGULAR);

        for wk in 0..weeks {
            let week_top = grid_top + wk as f32 * week_h;
            let week_days = &grid[wk * 7..wk * 7 + 7];
            // Day cells.
            for (col, &day) in week_days.iter().enumerate() {
                let r = Rect::new(b.left + col as f32 * cw, week_top, b.left + (col + 1) as f32 * cw, week_top + week_h);
                self.cells.push((rel(r), day.iso()));
                let in_month = day.month == m.view.current.month;
                if !in_month {
                    g.fill_rectangle(Brush::solid(th.surface2), r);
                } else if day.is_weekend() {
                    g.fill_rectangle(Brush::solid(th.surface1), r);
                }
                g.draw_line(&Pen::new(th.border, 1.0), PointF::new(r.right - 0.5, r.top), PointF::new(r.right - 0.5, r.bottom));
                g.draw_line(&Pen::new(th.border, 1.0), PointF::new(r.left, r.bottom - 0.5), PointF::new(r.right, r.bottom - 0.5));
                // Day number in a 28px round box (filled accent circle when today).
                let bx = Rect::new(r.left + 4.0, r.top + 4.0, r.left + 4.0 + NUM_BOX, r.top + 4.0 + NUM_BOX);
                if day == m.view.today {
                    g.fill_ellipse(Brush::solid(th.primary), bx);
                    g.draw_string(&day.day.to_string(), &f_num, Brush::solid(Color::WHITE), bx, &fmt(StringAlignment::Center));
                } else {
                    let ink = if in_month { th.text_primary } else { th.text_tertiary.with_alpha(0.55) };
                    let ink = if in_month && day.is_weekend() { th.text_tertiary } else { ink };
                    g.draw_string(&day.day.to_string(), &f_num, Brush::solid(ink), bx, &fmt(StringAlignment::Center));
                }
                // Principal moon marker, top-right.
                if in_month {
                    if let Some(ph) = principal_phase_of_day(day, offset) {
                        draw_principal_moon(g, r.right - 13.0, r.top + 13.0, 6.5, ph, th.surface3, th.border_strong);
                    }
                }
            }

            // Banners spanning columns. Arrow tips only where the run leaves the visible MONTH.
            let banners = layout_banners(&events, week_days, offset);
            for seg in &banners.segs {
                let ev = &events[seg.event_index];
                let x0 = b.left + seg.start_col as f32 * cw;
                let x1 = b.left + (seg.end_col + 1) as f32 * cw;
                let y = week_top + BANNER_TOP + seg.row as f32 * BANNER_ROW_H;
                self.hits.push((rel(Rect::new(x0, y, x1, y + BANNER_BAR_H)), ev.event_id.clone()));
                draw_banner(
                    g, x0, x1, y, BANNER_BAR_H,
                    ev.color.as_deref().unwrap_or("#1a73e8"),
                    wk == 0 && seg.continues_before,
                    wk == weeks - 1 && seg.continues_after,
                    !seg.continues_after,
                    &ev.title, &f_title,
                );
            }

            // Timed chips under the banner band.
            let chips_top = week_top + BANNER_TOP + banners.rows as f32 * BANNER_ROW_H + 2.0;
            for (col, &day) in week_days.iter().enumerate() {
                let x = b.left + col as f32 * cw;
                let chips = timed_events_for_day(&events, day, offset);
                let mut y = chips_top;
                for ev in chips.iter().take(MONTH_MAX_CHIPS) {
                    let rect = Rect::new(x + 4.0, y, x + cw - 4.0, y + CHIP_H);
                    self.hits.push((rel(rect), ev.event_id.clone()));
                    draw_event_pill(g, rect, ev.color.as_deref().unwrap_or("#1a73e8"), Some(&hhmm(ev, offset)), &ev.title, &f_time, &f_title, false, false);
                    y += CHIP_STEP;
                }
                if chips.len() > MONTH_MAX_CHIPS {
                    g.draw_string(&format!("+{}", chips.len() - MONTH_MAX_CHIPS), &f_more, Brush::solid(th.text_tertiary), Rect::new(x + 8.0, y, x + cw, y + 14.0), &fmt(StringAlignment::Near));
                }
            }
        }
        e.raise(self, "OnPaint");
    }

    fn on_mouse_down(&mut self, e: &mut EventCx<'_, MouseEventArgs>) {
        if e.args().clicks == 2 {
            let (x, y) = (e.args().x, e.args().y);
            if let Some((_, id)) = self.hits.iter().find(|(r, _)| r.contains(x, y)).cloned() {
                self.raise_activated(ActivateArgs { event_id: id, date_iso: String::new() });
            } else if let Some((_, iso)) = self.cells.iter().find(|(r, _)| r.contains(x, y)).cloned() {
                self.raise_activated(ActivateArgs { event_id: String::new(), date_iso: iso });
            }
        }
        e.raise(&*self, "OnMouseDown");
    }
}

/// « H:MM » of the event's local start time.
fn hhmm(ev: &EventInstance, offset: i32) -> String {
    match Instant::parse(&ev.starts_at) {
        Some(i) => {
            let l = i.local(offset);
            format!("{}:{:02}", l.hour, l.minute)
        }
        None => String::new(),
    }
}
