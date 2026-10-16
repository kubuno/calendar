//! `WeatherList` - the sidebar's « Météo » forecast rows (`web/src/CalendarSidebarBody.tsx`, the weather
//! section): one row per saved location with its name, today's condition and the high/low temperatures (and the
//! precipitation probability when notable). Display only; adding a location is done from the « Ajouter un lieu »
//! button next to it.

use kubuno_desktop::ui::graphics::{Brush, Font, FontStyle, StringAlignment, StringFormat, StringFormatFlags, StringTrimming};
use kubuno_desktop::ui::{Canvas, Rect, Size};
use kubuno_desktop::views::component::{Control, ControlCore, PaintEventCx};

use crate::controls::model::Palette;

const ROW_H: f32 = 22.0;

/// A WMO weather code → a short condition label (web `wmoInfo` / `wmoKey`).
pub fn wmo_label(code: i32, fr: bool) -> &'static str {
    match code {
        0 => if fr { "Ciel dégagé" } else { "Clear" },
        1 => if fr { "Généralement dégagé" } else { "Mainly clear" },
        2 => if fr { "Partiellement nuageux" } else { "Partly cloudy" },
        3 => if fr { "Couvert" } else { "Overcast" },
        4..=49 => if fr { "Brouillard" } else { "Fog" },
        50..=57 => if fr { "Bruine" } else { "Drizzle" },
        58..=67 => if fr { "Pluie" } else { "Rain" },
        68..=77 => if fr { "Neige" } else { "Snow" },
        78..=82 => if fr { "Averses" } else { "Showers" },
        83..=86 => if fr { "Averses de neige" } else { "Snow showers" },
        87..=99 => if fr { "Orage" } else { "Thunderstorm" },
        _ => "-",
    }
}

#[derive(kubuno_desktop::views::component::Component, Default)]
#[kubuno(extends = Control, overrides(Control))]
#[category("Calendar")]
#[toolbox(icon = "calendar")]
pub struct WeatherList {
    base: ControlCore,
    /// `(name, weather_code, temp_max, temp_min, precip_prob)`.
    rows: Vec<(String, i32, f64, f64, i32)>,
    lang_fr: bool,
}

impl WeatherList {
    pub fn set_rows(&mut self, rows: Vec<(String, i32, f64, f64, i32)>, lang_fr: bool) {
        self.rows = rows;
        self.lang_fr = lang_fr;
        self.invalidate();
    }
}

impl Control for WeatherList {
    fn get_preferred_size(&self, _canvas: &dyn Canvas, proposed: Size) -> Size {
        let n = self.rows.len();
        Size { width: proposed.width, height: ROW_H * n as f32 }
    }

    fn on_paint(&mut self, e: &mut PaintEventCx<'_>) {
        let th = Palette::of(kubuno_desktop::Application::theme().mode == kubuno_desktop::ui::ThemeMode::Dark);
        let g = e.graphics;
        let b = e.clip_rectangle;
        g.fill_rectangle(Brush::solid(th.surface0), b);
        let f_name = Font::with_dip("Segoe UI", 12.0, FontStyle::REGULAR);
        let f_sub = Font::with_dip("Segoe UI", 11.0, FontStyle::REGULAR);
        let near = StringFormat { alignment: StringAlignment::Near, line_alignment: StringAlignment::Center, trimming: StringTrimming::EllipsisCharacter, flags: StringFormatFlags::NO_WRAP };
        let far = StringFormat { alignment: StringAlignment::Far, line_alignment: StringAlignment::Center, trimming: StringTrimming::EllipsisCharacter, flags: StringFormatFlags::NO_WRAP };

        // One compact line per location: name (left), condition + high/low (right).
        for (i, (name, code, tmax, tmin, precip)) in self.rows.iter().enumerate() {
            let top = b.top + i as f32 * ROW_H;
            let short = name.split(',').next().unwrap_or(name);
            g.draw_string(short, &f_name, Brush::solid(th.text_primary), Rect::new(b.left + 2.0, top, b.left + 120.0, top + ROW_H), &near);
            let mut sub = format!("{}  {}°/{}°", wmo_label(*code, self.lang_fr), tmax.round() as i32, tmin.round() as i32);
            if *precip > 10 {
                sub.push_str(&format!(" · {precip}%"));
            }
            g.draw_string(&sub, &f_sub, Brush::solid(th.text_secondary), Rect::new(b.left + 112.0, top, b.right - 4.0, top + ROW_H), &far);
        }
        e.raise(self, "OnPaint");
    }
}
