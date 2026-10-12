//! `SearchResults` — the event search results list (`web/src/SearchResultsView.tsx`): the events whose title,
//! description or location match the query, sorted by date, each a row with a colour dot, the title, and the
//! day + time. Clicking a result opens that event's Day. The window fills `model.search_results` from a ±1-year
//! fetch filtered by the query.

use std::collections::BTreeMap;

use kubuno_desktop::prelude::MouseEventArgs;
use kubuno_desktop::ui::graphics::{Brush, Font, FontStyle, StringAlignment, StringFormat, StringFormatFlags, StringTrimming};
use kubuno_desktop::ui::{Canvas, Rect, Size};
use kubuno_desktop::views::component::{Control, ControlCore, EventCx, PaintEventCx};
use kubuno_desktop::views::events::Event;

use kubuno_calendar_core::colors::DEFAULT_EVENT_COLOR;
use kubuno_calendar_core::date::{self, DateFormat};
use kubuno_calendar_core::model::Instant;

use crate::controls::model::{color_of, Palette, Shared};

/// A search result was clicked (the window opens that event's Day).
#[derive(kubuno_desktop::views::events::EventArgs, Debug, Clone, Default, PartialEq)]
pub struct SearchNavArgs {
    pub date_iso: String,
}

const ROW_H: f32 = 56.0;
const HDR_H: f32 = 40.0;

#[derive(kubuno_desktop::views::component::Component, Default)]
#[kubuno(extends = Control, overrides(Control))]
#[category("Calendar")]
#[toolbox(icon = "calendar")]
#[default_event("ResultPicked")]
pub struct SearchResults {
    base: ControlCore,
    #[event]
    #[category("Action")]
    pub result_picked: Event<SearchNavArgs>,
    model: Option<Shared>,
    hits: Vec<(Rect, String)>,
}

impl SearchResults {
    pub fn set_model(&mut self, model: Shared) {
        self.model = Some(model);
        self.invalidate();
    }
}

impl Control for SearchResults {
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
        let offset = m.offset_minutes;
        let lang = m.view.lang;
        let cal_colors: BTreeMap<String, String> = m.calendars.iter().map(|c| (c.id.clone(), c.color.clone())).collect();
        let near = StringFormat { alignment: StringAlignment::Near, line_alignment: StringAlignment::Center, trimming: StringTrimming::EllipsisCharacter, flags: StringFormatFlags::NO_WRAP };
        let rel = |r: Rect| Rect::new(r.left - b.left, r.top - b.top, r.right - b.left, r.bottom - b.top);

        // Header: the count.
        let f_hdr = Font::with_dip("Segoe UI", 13.0, FontStyle::BOLD);
        let f_title = Font::with_dip("Segoe UI", 14.0, FontStyle::BOLD);
        let f_sub = Font::with_dip("Segoe UI", 12.0, FontStyle::REGULAR);
        let n = m.search_results.len();
        let count = if lang == kubuno_calendar_core::date::Lang::Fr {
            format!("{n} résultat{}", if n > 1 { "s" } else { "" })
        } else {
            format!("{n} result{}", if n > 1 { "s" } else { "" })
        };
        g.draw_string(&count, &f_hdr, Brush::solid(th.text_secondary), Rect::new(b.left + 24.0, b.top + 8.0, b.right - 24.0, b.top + HDR_H), &near);

        let mut y = b.top + HDR_H;
        for ev in &m.search_results {
            if y > b.bottom {
                break;
            }
            // Colour dot.
            let hex = ev.color.clone().or_else(|| cal_colors.get(&ev.calendar_id).cloned()).unwrap_or_else(|| DEFAULT_EVENT_COLOR.to_string());
            let dot = Rect::new(b.left + 24.0, y + ROW_H / 2.0 - 5.0, b.left + 34.0, y + ROW_H / 2.0 + 5.0);
            g.fill_ellipse(Brush::solid(color_of(&hex, th.primary)), dot);
            // Title.
            g.draw_string(&ev.title, &f_title, Brush::solid(th.text_primary), Rect::new(b.left + 48.0, y + 8.0, b.right - 24.0, y + 30.0), &near);
            // Day + time.
            let sub = match Instant::parse(&ev.starts_at) {
                Some(i) => {
                    let l = i.local(offset);
                    let d = date::format(l.date, DateFormat::FullDate, lang);
                    if ev.all_day {
                        d
                    } else {
                        format!("{d} · {:02}:{:02}", l.hour, l.minute)
                    }
                }
                None => String::new(),
            };
            g.draw_string(&sub, &f_sub, Brush::solid(th.text_tertiary), Rect::new(b.left + 48.0, y + 30.0, b.right - 24.0, y + 50.0), &near);
            // Separator.
            g.fill_rectangle(Brush::solid(th.border), Rect::new(b.left + 24.0, y + ROW_H - 1.0, b.right - 24.0, y + ROW_H));
            let day_iso = Instant::parse(&ev.starts_at).map(|i| i.local(offset).date.iso()).unwrap_or_default();
            self.hits.push((rel(Rect::new(b.left, y, b.right, y + ROW_H)), day_iso));
            y += ROW_H;
        }
        e.raise(self, "OnPaint");
    }

    fn on_mouse_down(&mut self, e: &mut EventCx<'_, MouseEventArgs>) {
        let (x, y) = (e.args().x, e.args().y);
        if let Some((_, date_iso)) = self.hits.iter().find(|(r, _)| r.contains(x, y)).cloned() {
            self.raise_result_picked(SearchNavArgs { date_iso });
        }
        e.raise(&*self, "OnMouseDown");
    }
}
