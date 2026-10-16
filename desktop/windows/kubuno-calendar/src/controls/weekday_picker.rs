//! `WeekdayPicker` - the « Répéter le » weekday toggles of the custom-recurrence dialog
//! (`web/src/RecurrenceCustomDialog.tsx`: a row of seven 32px round buttons, Monday first - L M M J V S D).
//! An active day is filled with the primary colour and white text; an inactive one is `surface-2` with
//! secondary text. At least one day stays selected, exactly as the web keeps `byday` non-empty.

use kubuno_desktop::prelude::MouseEventArgs;
use kubuno_desktop::ui::graphics::{Brush, Color, Font, FontStyle, StringAlignment, StringFormat, StringFormatFlags, StringTrimming};
use kubuno_desktop::ui::{Canvas, Rect, Size};
use kubuno_desktop::views::component::{Control, ControlCore, EventCx, PaintEventCx};
use kubuno_desktop::views::events::Event;

use crate::controls::model::Palette;

/// The weekday selection changed (the dialog recomputes its RRULE summary).
#[derive(kubuno_desktop::views::events::EventArgs, Debug, Clone, Default, PartialEq)]
pub struct DaysChangedArgs;

/// iCal weekday codes, Monday first (matches the web's Monday-first `BYDAY` order).
const CODES: [&str; 7] = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];
/// The single-letter labels, Monday first (`L M M J V S D`).
const LETTERS: [&str; 7] = ["L", "M", "M", "J", "V", "S", "D"];
const BTN: f32 = 32.0; // w-8 h-8
const GAP: f32 = 4.0; // gap-1

#[derive(kubuno_desktop::views::component::Component, Default)]
#[kubuno(extends = Control, overrides(Control))]
#[category("Calendar")]
#[toolbox(icon = "calendar")]
#[default_event("DaysChanged")]
pub struct WeekdayPicker {
    base: ControlCore,
    /// Occurs when a day is toggled on or off.
    #[event]
    #[category("Action")]
    pub days_changed: Event<DaysChangedArgs>,
    /// The selected iCal codes (a subset of `CODES`).
    days: Vec<String>,
    hits: Vec<(Rect, usize)>,
}

impl WeekdayPicker {
    /// Replace the selection (used when the dialog opens on an existing rule).
    pub fn set_days(&mut self, days: Vec<String>) {
        self.days = days;
        self.invalidate();
    }

    /// The selected iCal codes, Monday first.
    pub fn days(&self) -> Vec<String> {
        CODES.iter().filter(|c| self.days.iter().any(|d| d == *c)).map(|c| c.to_string()).collect()
    }
}

impl Control for WeekdayPicker {
    fn get_preferred_size(&self, _canvas: &dyn Canvas, _proposed: Size) -> Size {
        Size { width: BTN * 7.0 + GAP * 6.0, height: BTN }
    }

    fn on_paint(&mut self, e: &mut PaintEventCx<'_>) {
        let th = Palette::of(kubuno_desktop::Application::theme().mode == kubuno_desktop::ui::ThemeMode::Dark);
        let g = e.graphics;
        let b = e.clip_rectangle;
        g.fill_rectangle(Brush::solid(th.surface0), b);
        self.hits.clear();
        let font = Font::with_dip("Segoe UI", 12.0, FontStyle::BOLD);
        let center = StringFormat {
            alignment: StringAlignment::Center,
            line_alignment: StringAlignment::Center,
            trimming: StringTrimming::None,
            flags: StringFormatFlags::NO_WRAP,
        };
        for (i, letter) in LETTERS.iter().enumerate() {
            let x = b.left + i as f32 * (BTN + GAP);
            let rect = Rect::new(x, b.top, x + BTN, b.top + BTN);
            let active = self.days.iter().any(|d| d == CODES[i]);
            let (fill, ink) = if active { (th.primary, Color::WHITE) } else { (th.surface2, th.text_secondary) };
            g.fill_rounded_rectangle(Brush::solid(fill), rect, BTN / 2.0);
            g.draw_string(letter, &font, Brush::solid(ink), rect, &center);
            self.hits.push((Rect::new(x - b.left, 0.0, x + BTN - b.left, BTN), i));
        }
        e.raise(self, "OnPaint");
    }

    fn on_mouse_down(&mut self, e: &mut EventCx<'_, MouseEventArgs>) {
        let (x, y) = (e.args().x, e.args().y);
        if let Some((_, i)) = self.hits.iter().find(|(r, _)| r.contains(x, y)).cloned() {
            let code = CODES[i].to_string();
            if let Some(pos) = self.days.iter().position(|d| *d == code) {
                // Keep at least one day selected, like the web.
                if self.days.len() > 1 {
                    self.days.remove(pos);
                }
            } else {
                self.days.push(code);
            }
            self.invalidate();
            self.raise_days_changed(DaysChangedArgs);
        }
        e.raise(&*self, "OnMouseDown");
    }
}
