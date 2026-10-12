//! `CalDavList` — the per-calendar CalDAV URLs (`web/src/CalendarCalDavSettings.tsx`, the « URL par calendrier »
//! section): one card per calendar with a colour dot, its name, a « défaut » badge for the default calendar,
//! and the calendar's CalDAV URL (`<origin>/api/v1/calendar/caldav/<username>/<token>/`) in a monospace pill.
//! Display only — the token is read from the already-fetched calendars.

use kubuno_desktop::ui::graphics::{Brush, Font, FontStyle, StringAlignment, StringFormat, StringFormatFlags, StringTrimming};
use kubuno_desktop::ui::{Canvas, Rect, Size};
use kubuno_desktop::views::component::{Control, ControlCore, PaintEventCx};

use crate::controls::model::{color_of, Palette};

const ROW_H: f32 = 64.0;

#[derive(kubuno_desktop::views::component::Component, Default)]
#[kubuno(extends = Control, overrides(Control))]
#[category("Calendar")]
#[toolbox(icon = "calendar")]
pub struct CalDavList {
    base: ControlCore,
    /// `(color_hex, name, url, is_default)`.
    rows: Vec<(String, String, String, bool)>,
    default_label: String,
}

impl CalDavList {
    pub fn set_rows(&mut self, rows: Vec<(String, String, String, bool)>, default_label: &str) {
        self.rows = rows;
        self.default_label = default_label.to_string();
        self.invalidate();
    }
}

impl Control for CalDavList {
    fn get_preferred_size(&self, _canvas: &dyn Canvas, proposed: Size) -> Size {
        let n = self.rows.len().max(1);
        Size { width: proposed.width, height: ROW_H * n as f32 }
    }

    fn on_paint(&mut self, e: &mut PaintEventCx<'_>) {
        let th = Palette::of(kubuno_desktop::Application::theme().mode == kubuno_desktop::ui::ThemeMode::Dark);
        let g = e.graphics;
        let b = e.clip_rectangle;
        g.fill_rectangle(Brush::solid(th.surface0), b);
        let f_name = Font::with_dip("Segoe UI", 12.0, FontStyle::BOLD);
        let f_url = Font::with_dip("Consolas", 11.0, FontStyle::REGULAR);
        let near = StringFormat { alignment: StringAlignment::Near, line_alignment: StringAlignment::Center, trimming: StringTrimming::EllipsisCharacter, flags: StringFormatFlags::NO_WRAP };

        for (i, (color, name, url, is_def)) in self.rows.iter().enumerate() {
            let top = b.top + i as f32 * ROW_H;
            // The card border.
            let card = Rect::new(b.left + 1.0, top + 4.0, b.right - 1.0, top + ROW_H - 6.0);
            g.fill_rounded_rectangle(Brush::solid(th.surface0), card, 8.0);
            g.draw_rounded_rectangle(&kubuno_desktop::ui::graphics::Pen::new(th.border, 1.0), card, 8.0);
            // Colour dot + name.
            let dot = color_of(color, th.primary);
            let dr = Rect::new(card.left + 12.0, top + 16.0, card.left + 22.0, top + 26.0);
            g.fill_ellipse(Brush::solid(dot), dr);
            g.draw_string(name, &f_name, Brush::solid(th.text_primary), Rect::new(card.left + 30.0, top + 10.0, card.right - 70.0, top + 30.0), &near);
            // The default badge.
            if *is_def && !self.default_label.is_empty() {
                let f_badge = Font::with_dip("Segoe UI", 10.0, FontStyle::REGULAR);
                let badge = Rect::new(card.right - 66.0, top + 12.0, card.right - 12.0, top + 28.0);
                g.fill_rounded_rectangle(Brush::solid(th.primary.with_alpha(0.12)), badge, 4.0);
                let center = StringFormat { alignment: StringAlignment::Center, line_alignment: StringAlignment::Center, trimming: StringTrimming::EllipsisCharacter, flags: StringFormatFlags::NO_WRAP };
                g.draw_string(&self.default_label, &f_badge, Brush::solid(th.primary), badge, &center);
            }
            // The CalDAV URL in a filled pill.
            let pill = Rect::new(card.left + 12.0, top + 34.0, card.right - 12.0, top + 52.0);
            g.fill_rounded_rectangle(Brush::solid(th.surface2), pill, 4.0);
            g.draw_string(url, &f_url, Brush::solid(th.text_secondary), Rect::new(pill.left + 8.0, pill.top, pill.right - 8.0, pill.bottom), &near);
        }
        e.raise(self, "OnPaint");
    }
}
