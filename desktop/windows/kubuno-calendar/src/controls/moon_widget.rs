//! `MoonWidget` - the sidebar's Moon row (`web/src/CalendarSidebarBody.tsx` MoonSection): today's moon as a
//! small disc, its phase name and its illuminated percentage, from the shared core's moon maths.

use kubuno_desktop::ui::graphics::{Brush, Font, FontStyle, StringAlignment, StringFormat, StringFormatFlags, StringTrimming};
use kubuno_desktop::ui::{Canvas, Rect, Size};
use kubuno_desktop::views::component::{Control, ControlCore, PaintEventCx};

use kubuno_calendar_core::date::Lang;
use kubuno_calendar_core::moon::{moon_illumination, moon_phase, phase8, Phase8};

use crate::controls::draw::draw_moon;
use crate::controls::model::{Palette, Shared};

#[derive(kubuno_desktop::views::component::Component, Default)]
#[kubuno(extends = Control, overrides(Control))]
#[category("Calendar")]
#[toolbox(icon = "calendar")]
pub struct MoonWidget {
    base: ControlCore,
    model: Option<Shared>,
}

impl MoonWidget {
    pub fn set_model(&mut self, model: Shared) {
        self.model = Some(model);
        self.invalidate();
    }
}

impl Control for MoonWidget {
    fn get_preferred_size(&self, _canvas: &dyn Canvas, proposed: Size) -> Size {
        Size { width: proposed.width, height: 28.0 }
    }

    fn on_paint(&mut self, e: &mut PaintEventCx<'_>) {
        let th = Palette::of(kubuno_desktop::Application::theme().mode == kubuno_desktop::ui::ThemeMode::Dark);
        let g = e.graphics;
        let b = e.clip_rectangle;
        g.fill_rectangle(Brush::solid(th.surface0), b);
        let Some(model) = self.model.clone() else { return };
        let m = model.borrow();
        let lang = m.view.lang;
        // Today, at local noon, as an epoch (the offset is immaterial to the phase at this precision).
        let epoch = m.view.today.to_days() * 86_400 + 43_200 - m.offset_minutes as i64 * 60;
        let phase = moon_phase(epoch);
        let illum = moon_illumination(epoch);
        let r = 9.0;
        draw_moon(g, b.left + 4.0 + r, b.top + 14.0, r, phase, illum, th.surface2, th.border_strong);
        let name = phase_name(phase8(epoch), lang);
        let pct = (illum * 100.0).round() as i32;
        let text = format!("{name}  {pct}%");
        let f = Font::with_dip("Segoe UI", 12.0, FontStyle::REGULAR);
        let near = StringFormat { alignment: StringAlignment::Near, line_alignment: StringAlignment::Center, trimming: StringTrimming::EllipsisCharacter, flags: StringFormatFlags::NO_WRAP };
        g.draw_string(&text, &f, Brush::solid(th.text_primary), Rect::new(b.left + 30.0, b.top, b.right - 4.0, b.top + 28.0), &near);
        e.raise(self, "OnPaint");
    }
}

fn phase_name(p: Phase8, lang: Lang) -> &'static str {
    let fr = lang == Lang::Fr;
    match p {
        Phase8::New => if fr { "Nouvelle lune" } else { "New moon" },
        Phase8::WaxingCrescent => if fr { "Premier croissant" } else { "Waxing crescent" },
        Phase8::FirstQuarter => if fr { "Premier quartier" } else { "First quarter" },
        Phase8::WaxingGibbous => if fr { "Gibbeuse croissante" } else { "Waxing gibbous" },
        Phase8::Full => if fr { "Pleine lune" } else { "Full moon" },
        Phase8::WaningGibbous => if fr { "Gibbeuse décroissante" } else { "Waning gibbous" },
        Phase8::LastQuarter => if fr { "Dernier quartier" } else { "Last quarter" },
        Phase8::WaningCrescent => if fr { "Dernier croissant" } else { "Waning crescent" },
    }
}
