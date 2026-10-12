//! `ScheduleList` — the sidebar's « Pages de réservation » list (`web/src/CalendarSidebarBody.tsx`): one row per
//! bookable appointment schedule with its title and duration. Clicking a row raises `OnPicked` with the
//! schedule id; the window opens the editor for it.

use kubuno_desktop::prelude::MouseEventArgs;
use kubuno_desktop::ui::graphics::{Brush, Font, FontStyle, StringAlignment, StringFormat, StringFormatFlags, StringTrimming};
use kubuno_desktop::ui::{Canvas, Rect, Size};
use kubuno_desktop::views::component::{Control, ControlCore, EventCx, PaintEventCx};
use kubuno_desktop::views::events::Event;

use crate::controls::model::Palette;

/// A schedule row was clicked: the schedule to edit.
#[derive(kubuno_desktop::views::events::EventArgs, Debug, Clone, Default, PartialEq)]
pub struct SchedulePickArgs {
    pub id: String,
}

const ROW_H: f32 = 38.0;

#[derive(kubuno_desktop::views::component::Component, Default)]
#[kubuno(extends = Control, overrides(Control))]
#[category("Calendar")]
#[toolbox(icon = "calendar")]
#[default_event("Picked")]
pub struct ScheduleList {
    base: ControlCore,
    #[event]
    #[category("Action")]
    pub picked: Event<SchedulePickArgs>,
    /// `(id, title, duration_minutes)`.
    rows: Vec<(String, String, i32)>,
    lang_fr: bool,
    hits: Vec<(Rect, String)>,
}

impl ScheduleList {
    pub fn set_rows(&mut self, rows: Vec<(String, String, i32)>, lang_fr: bool) {
        self.rows = rows;
        self.lang_fr = lang_fr;
        self.invalidate();
    }
}

impl Control for ScheduleList {
    fn get_preferred_size(&self, _canvas: &dyn Canvas, proposed: Size) -> Size {
        let n = self.rows.len().max(1);
        Size { width: proposed.width, height: ROW_H * n as f32 }
    }

    fn on_paint(&mut self, e: &mut PaintEventCx<'_>) {
        let th = Palette::of(kubuno_desktop::Application::theme().mode == kubuno_desktop::ui::ThemeMode::Dark);
        let g = e.graphics;
        let b = e.clip_rectangle;
        g.fill_rectangle(Brush::solid(th.surface0), b);
        self.hits.clear();
        let near = StringFormat { alignment: StringAlignment::Near, line_alignment: StringAlignment::Center, trimming: StringTrimming::EllipsisCharacter, flags: StringFormatFlags::NO_WRAP };
        let rel = |r: Rect| Rect::new(r.left - b.left, r.top - b.top, r.right - b.left, r.bottom - b.top);

        if self.rows.is_empty() {
            let f = Font::with_dip("Segoe UI", 12.0, FontStyle::REGULAR);
            let msg = if self.lang_fr { "Aucun planning" } else { "No schedules" };
            g.draw_string(msg, &f, Brush::solid(th.text_tertiary), Rect::new(b.left + 8.0, b.top, b.right - 8.0, b.top + ROW_H), &near);
            e.raise(self, "OnPaint");
            return;
        }

        let f_title = Font::with_dip("Segoe UI", 12.0, FontStyle::REGULAR);
        let f_sub = Font::with_dip("Segoe UI", 11.0, FontStyle::REGULAR);
        for (i, (id, title, dur)) in self.rows.iter().enumerate() {
            let top = b.top + i as f32 * ROW_H;
            g.draw_string(title, &f_title, Brush::solid(th.text_primary), Rect::new(b.left + 8.0, top + 3.0, b.right - 8.0, top + 20.0), &near);
            let sub = format!("{dur} min");
            g.draw_string(&sub, &f_sub, Brush::solid(th.text_tertiary), Rect::new(b.left + 8.0, top + 19.0, b.right - 8.0, top + ROW_H), &near);
            self.hits.push((rel(Rect::new(b.left, top, b.right, top + ROW_H)), id.clone()));
        }
        e.raise(self, "OnPaint");
    }

    fn on_mouse_down(&mut self, e: &mut EventCx<'_, MouseEventArgs>) {
        let (x, y) = (e.args().x, e.args().y);
        if let Some((_, id)) = self.hits.iter().find(|(r, _)| r.contains(x, y)).cloned() {
            self.raise_picked(SchedulePickArgs { id });
        }
        e.raise(&*self, "OnMouseDown");
    }
}
