//! `AgendaList` — the Schedule / « Planning » view (`web/src/ScheduleView.tsx`): one row per day that has
//! events over the visible month — a left date badge (weekday + the day number, a filled accent circle when
//! today) and, on the right, the day's events as filled rounded cards (all-day first, then timed by start).
//! Empty days are skipped. Geometry and colours match the web. Read-only; the wheel scrolls the list.

use kubuno_desktop::ui::graphics::{Brush, Color, Font, FontStyle, Pen, PointF, StringAlignment, StringFormat, StringFormatFlags, StringTrimming};
use kubuno_desktop::ui::{Canvas, Rect, Size};
use kubuno_desktop::views::component::{Component, Control, ControlCore, EventCx, PaintEventCx};
use kubuno_desktop::prelude::MouseEventArgs;

use kubuno_calendar_core::date::{self, Date, DateFormat, Lang};
use kubuno_calendar_core::layout::{banner_end_day, banner_start_day, is_banner_event, timed_events_for_day};
use kubuno_calendar_core::model::{EventInstance, Instant};

use crate::controls::draw::DEFAULT_EVENT_COLOR;
use crate::controls::model::{color_of, hex, sample_state, Palette, Shared};

const BADGE_W: f32 = 56.0; // left date column (w-12 + container pad)
const EV_H: f32 = 44.0; // event card height (px-3 py-2, two lines)
const EV_GAP: f32 = 6.0; // space-y-1.5
const LEFT_PAD: f32 = 24.0;
const CARD_RADIUS: f32 = 12.0; // rounded-lg (theme override)

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
        let events = m.visible_events();
        let lang = m.view.lang;
        let offset = m.offset_minutes;
        let fmt = |a| StringFormat { alignment: a, line_alignment: StringAlignment::Center, trimming: StringTrimming::EllipsisCharacter, flags: StringFormatFlags::NO_WRAP };

        let f_wd = Font::with_dip("Segoe UI", 10.0, FontStyle::REGULAR);
        let f_num = Font::with_dip("Segoe UI", 16.0, FontStyle::REGULAR);
        let f_title = Font::with_dip("Segoe UI", 12.0, FontStyle::REGULAR); // font-medium
        let f_sub = Font::with_dip("Segoe UI", 11.0, FontStyle::REGULAR);

        // Content is centred in a max-width column (max-w-3xl ≈ 768px), like the web.
        let content_w = (b.right - b.left - 2.0 * LEFT_PAD).min(768.0);
        let x0 = b.left + ((b.right - b.left) - content_w).max(2.0 * LEFT_PAD) / 2.0;
        let badge_x = x0;
        let ev_x = x0 + BADGE_W + 8.0;
        let ev_right = x0 + content_w;

        let state = g.save();
        g.intersect_clip(b);
        let mut y = b.top + 10.0 - self.scroll_y;
        let first = m.view.current.start_of_month();
        let last = m.view.current.end_of_month();
        let mut day = first;
        while day <= last {
            let evs = events_on_day(&events, day, offset);
            if !evs.is_empty() {
                let row_events_h = evs.len() as f32 * EV_H + (evs.len().saturating_sub(1)) as f32 * EV_GAP;
                let row_h = row_events_h.max(44.0) + 16.0; // py-2 top/bottom
                if y + row_h > b.top && y < b.bottom {
                    let is_today = day == m.view.today;
                    // Date badge: weekday (10, uppercase, tertiary) + day number (32 circle, today filled).
                    g.draw_string(&date::format(day, DateFormat::WeekdayShort, lang).to_uppercase(), &f_wd, Brush::solid(th.text_tertiary), Rect::new(badge_x, y + 6.0, badge_x + BADGE_W, y + 20.0), &fmt(StringAlignment::Center));
                    let cx = badge_x + BADGE_W / 2.0;
                    let circle = Rect::new(cx - 16.0, y + 20.0, cx + 16.0, y + 52.0);
                    if is_today {
                        g.fill_ellipse(Brush::solid(th.primary), circle);
                        g.draw_string(&day.day.to_string(), &f_num, Brush::solid(Color::WHITE), circle, &fmt(StringAlignment::Center));
                    } else {
                        g.draw_string(&day.day.to_string(), &f_num, Brush::solid(th.text_primary), circle, &fmt(StringAlignment::Center));
                    }
                    // Event cards.
                    let mut ey = y + 8.0;
                    for ev in &evs {
                        let color = color_of(ev.color.as_deref().unwrap_or("#1a73e8"), hex(DEFAULT_EVENT_COLOR));
                        let card = Rect::new(ev_x, ey, ev_right, ey + EV_H);
                        g.fill_rounded_rectangle(Brush::solid(color), card, CARD_RADIUS);
                        g.draw_string(&ev.title, &f_title, Brush::solid(Color::WHITE), Rect::new(card.left + 12.0, card.top + 6.0, card.right - 12.0, card.top + 24.0), &fmt(StringAlignment::Near));
                        let sub = subtitle(ev, offset, lang);
                        g.draw_string(&sub, &f_sub, Brush::solid(Color::WHITE.with_alpha(0.85)), Rect::new(card.left + 12.0, card.top + 24.0, card.right - 12.0, card.bottom - 4.0), &fmt(StringAlignment::Near));
                        ey += EV_H + EV_GAP;
                    }
                    // Row divider (border @60%).
                    g.draw_line(&Pen::new(th.border.with_alpha(0.6), 1.0), PointF::new(badge_x, y + row_h - 1.0), PointF::new(ev_right, y + row_h - 1.0));
                }
                y += row_h;
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

/// The card subtitle (`ScheduleView.tsx`): "Toute la journée" for all-day, else "HH:MM – HH:MM".
fn subtitle(ev: &EventInstance, offset: i32, lang: Lang) -> String {
    if ev.all_day {
        return match lang {
            Lang::Fr => "Toute la journée".to_string(),
            Lang::En => "All day".to_string(),
        };
    }
    let s = Instant::parse(&ev.starts_at).map(|i| i.local(offset)).map(|l| format!("{}:{:02}", l.hour, l.minute)).unwrap_or_default();
    let e = Instant::parse(&ev.ends_at).map(|i| i.local(offset)).map(|l| format!("{}:{:02}", l.hour, l.minute)).unwrap_or_default();
    let mut out = format!("{s} – {e}");
    if let Some(loc) = ev.location.as_deref().filter(|s| !s.is_empty()) {
        out = format!("{out} · {loc}");
    }
    out
}
