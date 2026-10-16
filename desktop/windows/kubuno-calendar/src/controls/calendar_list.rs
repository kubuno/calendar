//! `CalendarList` - the sidebar's « Mes agendas » list (`web/src/CalendarSidebarBody.tsx`): one row per
//! calendar, a checkbox tinted with the calendar's colour (filled with a tick when the calendar is visible,
//! an outline when hidden) and the calendar name. Clicking a row toggles that calendar's events across the
//! Month / Week / Day views (`State::toggle_calendar` → `hidden_calendars`).

use kubuno_desktop::prelude::MouseEventArgs;
use kubuno_desktop::ui::graphics::{Brush, Color, Font, FontStyle, Pen, PointF, StringAlignment, StringFormat, StringFormatFlags, StringTrimming};
use kubuno_desktop::ui::{Canvas, Rect, Size};
use kubuno_desktop::views::component::{Control, ControlCore, EventCx, PaintEventCx};
use kubuno_desktop::views::events::Event;

use crate::controls::model::{color_of, Palette, Shared};

/// A calendar's visibility was toggled (the window repaints the views).
#[derive(kubuno_desktop::views::events::EventArgs, Debug, Clone, Default, PartialEq)]
pub struct VisibilityArgs;

const ROW_H: f32 = 30.0;
const BOX: f32 = 16.0;

#[derive(kubuno_desktop::views::component::Component, Default)]
#[kubuno(extends = Control, overrides(Control))]
#[category("Calendar")]
#[toolbox(icon = "calendar")]
#[default_event("VisibilityChanged")]
pub struct CalendarList {
    base: ControlCore,
    #[event]
    #[category("Action")]
    pub visibility_changed: Event<VisibilityArgs>,
    model: Option<Shared>,
    /// Hit rectangles (control-relative) of each row → calendar id.
    hits: Vec<(Rect, String)>,
}

impl CalendarList {
    pub fn set_model(&mut self, model: Shared) {
        self.model = Some(model);
        self.invalidate();
    }
}

impl Control for CalendarList {
    fn get_preferred_size(&self, _canvas: &dyn Canvas, proposed: Size) -> Size {
        let n = self.model.as_ref().map(|m| m.borrow().calendars.len()).unwrap_or(1).max(1);
        Size { width: proposed.width, height: ROW_H * n as f32 }
    }

    fn on_paint(&mut self, e: &mut PaintEventCx<'_>) {
        let th = Palette::of(kubuno_desktop::Application::theme().mode == kubuno_desktop::ui::ThemeMode::Dark);
        let g = e.graphics;
        let b = e.clip_rectangle;
        g.fill_rectangle(Brush::solid(th.surface0), b);
        self.hits.clear();
        let Some(model) = self.model.clone() else { return };
        let m = model.borrow();
        let f = Font::with_dip("Segoe UI", 12.0, FontStyle::REGULAR);
        let near = StringFormat { alignment: StringAlignment::Near, line_alignment: StringAlignment::Center, trimming: StringTrimming::EllipsisCharacter, flags: StringFormatFlags::NO_WRAP };
        let rel = |r: Rect| Rect::new(r.left - b.left, r.top - b.top, r.right - b.left, r.bottom - b.top);

        for (i, cal) in m.calendars.iter().enumerate() {
            let top = b.top + i as f32 * ROW_H;
            let visible = !m.is_hidden(&cal.id);
            let color = color_of(&cal.color, th.primary);
            // The checkbox, tinted with the calendar colour.
            let bx = Rect::new(b.left + 8.0, top + (ROW_H - BOX) / 2.0, b.left + 8.0 + BOX, top + (ROW_H - BOX) / 2.0 + BOX);
            if visible {
                g.fill_rounded_rectangle(Brush::solid(color), bx, 4.0);
                // A white tick.
                let pen = Pen::new(Color::WHITE, 2.0);
                g.draw_line(&pen, PointF::new(bx.left + 3.5, bx.top + 8.0), PointF::new(bx.left + 6.5, bx.top + 11.5));
                g.draw_line(&pen, PointF::new(bx.left + 6.5, bx.top + 11.5), PointF::new(bx.left + 12.5, bx.top + 4.5));
            } else {
                g.draw_rounded_rectangle(&Pen::new(th.border_strong, 1.5), bx, 4.0);
            }
            // The name.
            let ink = if visible { th.text_primary } else { th.text_tertiary };
            g.draw_string(&cal.name, &f, Brush::solid(ink), Rect::new(b.left + 34.0, top, b.right - 8.0, top + ROW_H), &near);
            self.hits.push((rel(Rect::new(b.left, top, b.right, top + ROW_H)), cal.id.clone()));
        }
        e.raise(self, "OnPaint");
    }

    fn on_mouse_down(&mut self, e: &mut EventCx<'_, MouseEventArgs>) {
        let (x, y) = (e.args().x, e.args().y);
        if let Some((_, id)) = self.hits.iter().find(|(r, _)| r.contains(x, y)).cloned() {
            if let Some(model) = self.model.clone() {
                model.borrow_mut().toggle_calendar(&id);
            }
            self.invalidate();
            self.raise_visibility_changed(VisibilityArgs);
        }
        e.raise(&*self, "OnMouseDown");
    }
}
