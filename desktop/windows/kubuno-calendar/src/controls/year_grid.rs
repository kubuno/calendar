//! `YearGrid` — the Year view (`web/src/YearView.tsx`): a 4×3 grid of twelve mini-months. Each carries a month
//! header (the name, in the accent colour for the current month, plus its event count), a narrow weekday row,
//! and the days — today a filled accent disc, weekends dimmed, and up to three colour dots per day for the
//! events on it. Clicking a month header opens that Month; clicking a day opens that Day.

use std::collections::BTreeMap;

use kubuno_desktop::prelude::MouseEventArgs;
use kubuno_desktop::ui::graphics::{Brush, Color, Font, FontStyle, StringAlignment, StringFormat, StringFormatFlags, StringTrimming};
use kubuno_desktop::ui::{Canvas, Rect, Size};
use kubuno_desktop::views::component::{Control, ControlCore, EventCx, PaintEventCx};
use kubuno_desktop::views::events::Event;

use kubuno_calendar_core::colors::DEFAULT_EVENT_COLOR;
use kubuno_calendar_core::date::{self, Date, DateFormat, Lang};
use kubuno_calendar_core::layout::month_grid;
use kubuno_calendar_core::model::Instant;

use crate::controls::model::{color_of, Palette, Shared};

/// A navigation request from the Year view: open `date_iso` as a Day (`to_day`) or a Month.
#[derive(kubuno_desktop::views::events::EventArgs, Debug, Clone, Default, PartialEq)]
pub struct YearNavArgs {
    pub date_iso: String,
    pub to_day: bool,
}

const FR_NARROW: [&str; 7] = ["L", "M", "M", "J", "V", "S", "D"];
const EN_NARROW: [&str; 7] = ["M", "T", "W", "T", "F", "S", "S"];
const COLS: usize = 4;
const ROWS: usize = 3;
const GAP: f32 = 16.0;
const HDR_H: f32 = 22.0;
const DOW_H: f32 = 14.0;

#[derive(kubuno_desktop::views::component::Component, Default)]
#[kubuno(extends = Control, overrides(Control))]
#[category("Calendar")]
#[toolbox(icon = "calendar")]
#[default_event("YearNav")]
pub struct YearGrid {
    base: ControlCore,
    #[event]
    #[category("Action")]
    pub year_nav: Event<YearNavArgs>,
    model: Option<Shared>,
    /// Hit rectangles (control-relative): a day → (date, to_day=true), a month header → (first-of-month, false).
    hits: Vec<(Rect, Date, bool)>,
}

impl YearGrid {
    pub fn set_model(&mut self, model: Shared) {
        self.model = Some(model);
        self.invalidate();
    }
}

impl Control for YearGrid {
    fn get_preferred_size(&self, _canvas: &dyn Canvas, proposed: Size) -> Size {
        proposed
    }

    fn on_paint(&mut self, e: &mut PaintEventCx<'_>) {
        let th = Palette::of(kubuno_desktop::Application::theme().mode == kubuno_desktop::ui::ThemeMode::Dark);
        let g = e.graphics;
        let b = e.clip_rectangle;
        g.fill_rectangle(Brush::solid(th.surface0), b);
        self.hits.clear();
        let Some(model) = self.model.clone() else { return };
        let m = model.borrow();
        let events = m.visible_events();
        let lang = m.view.lang;
        let wso = m.view.week_starts_on;
        let today = m.view.today;
        let year = m.view.current.year;
        let offset = m.offset_minutes;
        // Calendar colours, for resolving an event's dot colour.
        let cal_colors: BTreeMap<String, String> = m.calendars.iter().map(|c| (c.id.clone(), c.color.clone())).collect();
        // Event colours per local start day of this year.
        let mut dots_by_day: BTreeMap<String, Vec<Color>> = BTreeMap::new();
        let mut count_by_month: [u32; 12] = [0; 12];
        for ev in &events {
            if let Some(i) = Instant::parse(&ev.starts_at) {
                let d = i.local(offset).date;
                if d.year != year {
                    continue;
                }
                let hex = ev.color.clone().or_else(|| cal_colors.get(&ev.calendar_id).cloned()).unwrap_or_else(|| DEFAULT_EVENT_COLOR.to_string());
                let col = color_of(&hex, th.primary);
                let entry = dots_by_day.entry(d.iso()).or_default();
                if !entry.contains(&col) {
                    entry.push(col);
                }
                count_by_month[(d.month - 1) as usize] += 1;
            }
        }

        let rel = |r: Rect| Rect::new(r.left - b.left, r.top - b.top, r.right - b.left, r.bottom - b.top);
        let cell_w = (b.right - b.left - GAP * (COLS as f32 + 1.0)) / COLS as f32;
        let cell_h = (b.bottom - b.top - GAP * (ROWS as f32 + 1.0)) / ROWS as f32;
        let narrow = if lang == Lang::Fr { FR_NARROW } else { EN_NARROW };
        let center = StringFormat { alignment: StringAlignment::Center, line_alignment: StringAlignment::Center, trimming: StringTrimming::None, flags: StringFormatFlags::NO_WRAP };
        let near = StringFormat { alignment: StringAlignment::Near, line_alignment: StringAlignment::Center, trimming: StringTrimming::EllipsisCharacter, flags: StringFormatFlags::NO_WRAP };
        let f_hdr = Font::with_dip("Segoe UI", 14.0, FontStyle::BOLD);
        let f_dow = Font::with_dip("Segoe UI", 10.0, FontStyle::REGULAR);
        let f_day = Font::with_dip("Segoe UI", 11.0, FontStyle::REGULAR);
        let f_day_b = Font::with_dip("Segoe UI", 11.0, FontStyle::BOLD);

        for (mi, &cnt) in count_by_month.iter().enumerate() {
            let col = mi % COLS;
            let row = mi / COLS;
            let mx = b.left + GAP + col as f32 * (cell_w + GAP);
            let my = b.top + GAP + row as f32 * (cell_h + GAP);
            let month = Date { year, month: (mi + 1) as u32, day: 1 };
            // Month header: name (accent for the current month) + count badge.
            let is_current = month.month == today.month && year == today.year;
            let name = capitalize(&date::format(month, DateFormat::Month, lang));
            g.draw_string(&name, &f_hdr, Brush::solid(if is_current { th.primary } else { th.text_primary }), Rect::new(mx, my, mx + cell_w - 36.0, my + HDR_H), &near);
            if cnt > 0 {
                g.draw_string(&cnt.to_string(), &f_dow, Brush::solid(th.text_secondary), Rect::new(mx + cell_w - 34.0, my, mx + cell_w, my + HDR_H), &center);
            }
            self.hits.push((rel(Rect::new(mx, my, mx + cell_w, my + HDR_H)), month, false));

            // Weekday row.
            let grid = month_grid(month, wso);
            let dw = cell_w / 7.0;
            for (c, day) in grid.iter().take(7).enumerate() {
                let x = mx + c as f32 * dw;
                g.draw_string(narrow[day.weekday_mon0() as usize], &f_dow, Brush::solid(th.text_tertiary), Rect::new(x, my + HDR_H, x + dw, my + HDR_H + DOW_H), &center);
            }

            // Day grid.
            let weeks = (grid.len() / 7).max(1);
            let grid_top = my + HDR_H + DOW_H;
            let grid_bottom = my + cell_h;
            let rh = (grid_bottom - grid_top) / weeks as f32;
            let disc = (dw.min(rh) - 2.0).clamp(14.0, 20.0);
            for (i, &day) in grid.iter().enumerate() {
                let dc = i % 7;
                let dr = i / 7;
                if dr >= weeks {
                    break;
                }
                if day.month != month.month {
                    continue; // other-month cells are blank in the web
                }
                let cxp = mx + dc as f32 * dw + dw / 2.0;
                let cyp = grid_top + dr as f32 * rh + rh * 0.42;
                let dd = Rect::new(cxp - disc / 2.0, cyp - disc / 2.0, cxp + disc / 2.0, cyp + disc / 2.0);
                let is_today = day == today;
                let (ink, font) = if is_today {
                    g.fill_ellipse(Brush::solid(th.primary), dd);
                    (Color::WHITE, &f_day_b)
                } else if day.is_weekend() {
                    (th.text_tertiary, &f_day)
                } else {
                    (th.text_primary, &f_day)
                };
                g.draw_string(&day.day.to_string(), font, Brush::solid(ink), dd, &center);
                // Up to three event dots under the number.
                if let Some(cols) = dots_by_day.get(&day.iso()) {
                    let n = cols.len().min(3);
                    let dot = 3.0;
                    let total = n as f32 * dot + (n.saturating_sub(1)) as f32 * 2.0;
                    let mut dx = cxp - total / 2.0;
                    let dy = cyp + disc / 2.0 + 1.0;
                    for col_c in cols.iter().take(3) {
                        g.fill_ellipse(Brush::solid(*col_c), Rect::new(dx, dy, dx + dot, dy + dot));
                        dx += dot + 2.0;
                    }
                }
                let cell = Rect::new(mx + dc as f32 * dw, grid_top + dr as f32 * rh, mx + (dc + 1) as f32 * dw, grid_top + (dr + 1) as f32 * rh);
                self.hits.push((rel(cell), day, true));
            }
        }
        e.raise(self, "OnPaint");
    }

    fn on_mouse_down(&mut self, e: &mut EventCx<'_, MouseEventArgs>) {
        let (x, y) = (e.args().x, e.args().y);
        if let Some((_, day, to_day)) = self.hits.iter().find(|(r, _, _)| r.contains(x, y)).copied() {
            self.raise_year_nav(YearNavArgs { date_iso: day.iso(), to_day });
        }
        e.raise(&*self, "OnMouseDown");
    }
}

fn capitalize(s: &str) -> String {
    let mut c = s.chars();
    match c.next() {
        Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
        None => String::new(),
    }
}
