//! `AgendaList` — the Schedule / « Planning » view (`web/src/ScheduleView.tsx`): one row group per day that
//! has events over the visible month, each day a header (weekday + date) and its events underneath (all-day
//! first, then timed by start time). Empty days are skipped. Read-only; the wheel scrolls the list.

use kubuno_desktop::prelude::*;
use kubuno_desktop::ui::graphics::{Brush, Font, FontStyle, Pen, PointF, StringAlignment, StringFormat, StringFormatFlags, StringTrimming};
use kubuno_desktop::ui::{Canvas, Rect, Size};
use kubuno_desktop::views::component::{Component, Control, ControlCore, EventCx, PaintEventCx};

use kubuno_calendar_core::date::{self, Date, DateFormat};
use kubuno_calendar_core::layout::{banner_end_day, banner_start_day, is_banner_event, timed_events_for_day};
use kubuno_calendar_core::model::{EventInstance, Instant};

use crate::controls::model::{color_of, hex, sample_state, Palette, Shared};

const ROW_H: f32 = 30.0;
const DAY_HEADER_H: f32 = 36.0;
const PAD_X: f32 = 24.0;
const DEFAULT_EVENT_COLOR: u32 = 0x1a73e8;

#[derive(kubuno_desktop::views::component::Component, Default)]
#[kubuno(extends = Control, overrides(Control))]
#[category("Calendar")]
#[toolbox(icon = "calendar")]
pub struct AgendaList {
    base: ControlCore,
    model: Option<Shared>,
    bounds: Rect,
    scroll_y: f32,
}

impl AgendaList {
    pub fn set_model(&mut self, model: Shared) {
        self.model = Some(model);
        self.scroll_y = 0.0;
        self.invalidate();
    }
}

/// The events occurring on `day`: all-day / multi-day banners that span it, then timed events, in that order.
fn events_on_day(events: &[EventInstance], day: Date, offset: i32) -> Vec<&EventInstance> {
    let mut out: Vec<&EventInstance> = events
        .iter()
        .filter(|ev| is_banner_event(ev, offset) && banner_start_day(ev, offset) <= day && day <= banner_end_day(ev, offset))
        .collect();
    out.extend(timed_events_for_day(events, day, offset));
    out
}

impl Control for AgendaList {
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

        let f_day = Font::with_dip("Segoe UI", 13.0, FontStyle::BOLD);
        let f_ev = Font::with_dip("Segoe UI", 12.0, FontStyle::REGULAR);
        let f_time = Font::with_dip("Segoe UI", 12.0, FontStyle::BOLD);

        let state = g.save();
        g.intersect_clip(b);
        let mut y = b.top + 8.0 - self.scroll_y;
        // The visible month, day by day.
        let first = m.view.current.start_of_month();
        let last = m.view.current.end_of_month();
        let mut day = first;
        while day <= last {
            let evs = events_on_day(&m.events, day, offset);
            if !evs.is_empty() {
                // Day header.
                if y + DAY_HEADER_H > b.top && y < b.bottom {
                    let is_today = day == m.view.today;
                    let head = format!(
                        "{} {}",
                        capitalize(&date::format(day, DateFormat::WeekdayShort, lang)),
                        date::format(day, DateFormat::Date, lang)
                    );
                    let color = if is_today { th.primary } else { th.text_primary };
                    g.draw_string(&head, &f_day, Brush::solid(color), Rect::new(b.left + PAD_X, y, b.right - PAD_X, y + DAY_HEADER_H), &near(StringAlignment::Near));
                    g.draw_line(&Pen::new(th.border, 1.0), PointF::new(b.left + PAD_X, y + DAY_HEADER_H - 1.0), PointF::new(b.right - PAD_X, y + DAY_HEADER_H - 1.0));
                }
                y += DAY_HEADER_H;
                for ev in &evs {
                    if y + ROW_H > b.top && y < b.bottom {
                        let color = color_of(ev.color.as_deref().unwrap_or("#1a73e8"), hex(DEFAULT_EVENT_COLOR));
                        g.fill_ellipse(Brush::solid(color), Rect::new(b.left + PAD_X + 2.0, y + ROW_H / 2.0 - 4.0, b.left + PAD_X + 10.0, y + ROW_H / 2.0 + 4.0));
                        let when = if ev.all_day { all_day_label(lang) } else { hhmm(ev, offset) };
                        g.draw_string(&when, &f_time, Brush::solid(th.text_secondary), Rect::new(b.left + PAD_X + 20.0, y, b.left + PAD_X + 110.0, y + ROW_H), &near(StringAlignment::Near));
                        g.draw_string(&ev.title, &f_ev, Brush::solid(th.text_primary), Rect::new(b.left + PAD_X + 120.0, y, b.right - PAD_X, y + ROW_H), &near(StringAlignment::Near));
                    }
                    y += ROW_H;
                }
                y += 10.0;
            }
            day = day.add_days(1);
        }
        g.restore(state);
        e.raise(self, "OnPaint");
    }

    fn on_mouse_wheel(&mut self, e: &mut EventCx<'_, MouseEventArgs>) {
        self.scroll_y = (self.scroll_y - e.args().delta * 60.0).max(0.0);
        self.invalidate();
        e.raise(&*self, "OnMouseWheel");
    }
}

fn all_day_label(lang: kubuno_calendar_core::date::Lang) -> String {
    match lang {
        kubuno_calendar_core::date::Lang::Fr => "Journée".to_string(),
        kubuno_calendar_core::date::Lang::En => "All day".to_string(),
    }
}

fn hhmm(ev: &EventInstance, offset: i32) -> String {
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
