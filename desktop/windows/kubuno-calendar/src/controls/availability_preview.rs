//! `AvailabilityPreview` - the appointment-schedule editor's right pane (`AppointmentScheduleEditor.tsx`,
//! `AvailabilityPreview`): a live 7-day week grid (07:00–20:00) showing the weekly availability ranges as
//! tinted blocks, so the host sees their bookable windows while they edit. Display only.

use kubuno_desktop::ui::graphics::{Brush, Color, Font, FontStyle, Pen, StringAlignment, StringFormat, StringFormatFlags, StringTrimming};
use kubuno_desktop::ui::{Canvas, Rect, Size};
use kubuno_desktop::views::component::{Control, ControlCore, PaintEventCx};

use crate::controls::model::{color_of, Palette};

const START_H: i32 = 7;
const END_H: i32 = 20;
const GUTTER: f32 = 44.0;
const HDR_H: f32 = 40.0;
const PX_PER_MIN: f32 = 0.9;

#[derive(kubuno_desktop::views::component::Component, Default)]
#[kubuno(extends = Control, overrides(Control))]
#[category("Calendar")]
#[toolbox(icon = "calendar")]
pub struct AvailabilityPreview {
    base: ControlCore,
    /// 7 entries (Mon..Sun), each a list of `(start_minute, end_minute)` ranges.
    weekly: Vec<Vec<(i32, i32)>>,
    color_hex: String,
    lang_fr: bool,
}

impl AvailabilityPreview {
    pub fn set_weekly(&mut self, weekly: Vec<Vec<(i32, i32)>>, color_hex: &str, lang_fr: bool) {
        self.weekly = weekly;
        self.color_hex = color_hex.to_string();
        self.lang_fr = lang_fr;
        self.invalidate();
    }

    fn weekday_labels(&self) -> [&'static str; 7] {
        if self.lang_fr {
            ["Lun.", "Mar.", "Mer.", "Jeu.", "Ven.", "Sam.", "Dim."]
        } else {
            ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
        }
    }
}

fn hm(min: i32) -> String {
    format!("{:02}:{:02}", min / 60, min % 60)
}

impl Control for AvailabilityPreview {
    fn get_preferred_size(&self, _canvas: &dyn Canvas, proposed: Size) -> Size {
        proposed
    }

    fn on_paint(&mut self, e: &mut PaintEventCx<'_>) {
        let th = Palette::of(kubuno_desktop::Application::theme().mode == kubuno_desktop::ui::ThemeMode::Dark);
        let g = e.graphics;
        let b = e.clip_rectangle;
        g.fill_rectangle(Brush::solid(th.surface0), b);
        let accent = color_of(&self.color_hex, th.primary);

        let f_hdr = Font::with_dip("Segoe UI", 11.0, FontStyle::REGULAR);
        let f_num = Font::with_dip("Segoe UI", 12.0, FontStyle::REGULAR);
        let f_gutter = Font::with_dip("Consolas", 10.0, FontStyle::REGULAR);
        let f_range = Font::with_dip("Consolas", 10.0, FontStyle::REGULAR);
        let center = StringFormat { alignment: StringAlignment::Center, line_alignment: StringAlignment::Center, trimming: StringTrimming::EllipsisCharacter, flags: StringFormatFlags::NO_WRAP };
        let near = StringFormat { alignment: StringAlignment::Near, line_alignment: StringAlignment::Near, trimming: StringTrimming::EllipsisCharacter, flags: StringFormatFlags::NO_WRAP };

        let col_w = (b.right - b.left - GUTTER) / 7.0;
        let labels = self.weekday_labels();

        // Day headers.
        for (d, label) in labels.iter().enumerate() {
            let x = b.left + GUTTER + d as f32 * col_w;
            g.draw_line(&Pen::new(th.border, 1.0), kubuno_desktop::ui::graphics::PointF::new(x, b.top), kubuno_desktop::ui::graphics::PointF::new(x, b.bottom));
            g.draw_string(label, &f_hdr, Brush::solid(th.text_tertiary), Rect::new(x, b.top + 4.0, x + col_w, b.top + 20.0), &center);
            // The week's numbers aren't shown (no injected clock); the weekday label carries the preview.
            let _ = &f_num;
        }
        g.draw_line(&Pen::new(th.border, 1.0), kubuno_desktop::ui::graphics::PointF::new(b.left, b.top + HDR_H), kubuno_desktop::ui::graphics::PointF::new(b.right, b.top + HDR_H));

        let top_of = |min: i32| b.top + HDR_H + (min - START_H * 60) as f32 * PX_PER_MIN;

        // Hour lines + gutter labels.
        for h in START_H..=END_H {
            let y = top_of(h * 60);
            g.draw_line(&Pen::new(th.border.with_alpha(0.5), 1.0), kubuno_desktop::ui::graphics::PointF::new(b.left + GUTTER, y), kubuno_desktop::ui::graphics::PointF::new(b.right, y));
            g.draw_string(&format!("{h:02}:00"), &f_gutter, Brush::solid(th.text_tertiary), Rect::new(b.left, y - 7.0, b.left + GUTTER - 4.0, y + 7.0), &StringFormat { alignment: StringAlignment::Far, line_alignment: StringAlignment::Center, trimming: StringTrimming::EllipsisCharacter, flags: StringFormatFlags::NO_WRAP });
        }

        // Range blocks.
        let tint = Color { r: accent.r, g: accent.g, b: accent.b, a: 0.14 };
        for (d, ranges) in self.weekly.iter().enumerate().take(7) {
            let x = b.left + GUTTER + d as f32 * col_w;
            for (s, en) in ranges {
                let y0 = top_of(*s).max(b.top + HDR_H);
                let y1 = top_of(*en).min(b.bottom);
                if y1 <= y0 {
                    continue;
                }
                let r = Rect::new(x + 3.0, y0, x + col_w - 3.0, y1.max(y0 + 16.0));
                g.fill_rounded_rectangle(Brush::solid(tint), r, 5.0);
                g.draw_rounded_rectangle(&Pen::new(accent.with_alpha(0.4), 1.0), r, 5.0);
                g.draw_string(&format!("{} – {}", hm(*s), hm(*en)), &f_range, Brush::solid(accent), Rect::new(r.left + 4.0, r.top + 2.0, r.right - 2.0, r.top + 16.0), &near);
            }
        }
        e.raise(self, "OnPaint");
    }
}
