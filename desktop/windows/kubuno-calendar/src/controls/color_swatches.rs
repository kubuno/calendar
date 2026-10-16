//! `ColorSwatches` - the event colour picker of the editor (`web/src/EventEditor.tsx` ColorField): the
//! calendar's own colour first (the « default »), then the fixed `EVENT_SWATCHES`, each a round swatch with a
//! 2px primary ring when selected. Selecting the calendar swatch means « no per-event colour » (`None`), which
//! the save path turns into the calendar default / `clear_color`, exactly like the web.

use kubuno_desktop::prelude::MouseEventArgs;
use kubuno_desktop::ui::graphics::{Brush, Pen};
use kubuno_desktop::ui::{Canvas, Rect, Size};
use kubuno_desktop::views::component::{Control, ControlCore, EventCx, PaintEventCx};
use kubuno_desktop::views::events::Event;

use kubuno_calendar_core::colors::{DEFAULT_EVENT_COLOR, EVENT_SWATCHES};

use crate::controls::model::{color_of, Palette};

/// The selected colour changed (the editor rereads `selected_color`).
#[derive(kubuno_desktop::views::events::EventArgs, Debug, Clone, Default, PartialEq)]
pub struct ColorChangedArgs;

const SW: f32 = 28.0; // swatch diameter
const GAP: f32 = 6.0;

#[derive(kubuno_desktop::views::component::Component, Default)]
#[kubuno(extends = Control, overrides(Control))]
#[category("Calendar")]
#[toolbox(icon = "calendar")]
#[default_event("ColorChanged")]
pub struct ColorSwatches {
    base: ControlCore,
    /// Occurs when a swatch is picked.
    #[event]
    #[category("Action")]
    pub color_changed: Event<ColorChangedArgs>,
    /// The calendar's own colour (the first swatch / the « default »).
    cal_color: String,
    /// The chosen per-event colour, or `None` for « use the calendar colour ».
    selected: Option<String>,
    hits: Vec<(Rect, Option<String>)>,
}

impl ColorSwatches {
    /// The calendar colour that the first swatch stands for (and the fallback when none is chosen).
    pub fn set_calendar_color(&mut self, color: String) {
        self.cal_color = color;
        self.invalidate();
    }

    /// Preselect a per-event colour (`None` = the calendar colour).
    pub fn set_selected(&mut self, color: Option<String>) {
        self.selected = color;
        self.invalidate();
    }

    /// The chosen per-event colour, or `None` to keep the calendar colour.
    pub fn selected_color(&self) -> Option<String> {
        self.selected.clone()
    }

    /// The swatches in order: the calendar colour, then the event palette minus any equal to it.
    fn swatches(&self) -> Vec<(Option<String>, String)> {
        let cal = if self.cal_color.is_empty() { DEFAULT_EVENT_COLOR.to_string() } else { self.cal_color.clone() };
        let mut out: Vec<(Option<String>, String)> = vec![(None, cal.clone())];
        for c in EVENT_SWATCHES {
            if !c.eq_ignore_ascii_case(&cal) {
                out.push((Some(c.to_string()), c.to_string()));
            }
        }
        out
    }
}

impl Control for ColorSwatches {
    fn get_preferred_size(&self, _canvas: &dyn Canvas, proposed: Size) -> Size {
        Size { width: proposed.width, height: SW }
    }

    fn on_paint(&mut self, e: &mut PaintEventCx<'_>) {
        let th = Palette::of(kubuno_desktop::Application::theme().mode == kubuno_desktop::ui::ThemeMode::Dark);
        let g = e.graphics;
        let b = e.clip_rectangle;
        g.fill_rectangle(Brush::solid(th.surface0), b);
        self.hits.clear();
        let mut x = b.left;
        for (value, hexc) in self.swatches() {
            if x + SW > b.right {
                break;
            }
            let rect = Rect::new(x, b.top, x + SW, b.top + SW);
            g.fill_ellipse(Brush::solid(color_of(&hexc, th.primary)), rect);
            if self.selected == value {
                // A 2px primary ring with a 2px gap (web: outline 2px, offset 2px).
                let ring = Rect::new(rect.left - 3.0, rect.top - 3.0, rect.right + 3.0, rect.bottom + 3.0);
                g.draw_ellipse(&Pen::new(th.primary, 2.0), ring);
            }
            self.hits.push((Rect::new(x - b.left, 0.0, x + SW - b.left, SW), value));
            x += SW + GAP;
        }
        e.raise(self, "OnPaint");
    }

    fn on_mouse_down(&mut self, e: &mut EventCx<'_, MouseEventArgs>) {
        let (x, y) = (e.args().x, e.args().y);
        if let Some((_, value)) = self.hits.iter().find(|(r, _)| r.contains(x, y)).cloned() {
            self.selected = value;
            self.invalidate();
            self.raise_color_changed(ColorChangedArgs);
        }
        e.raise(&*self, "OnMouseDown");
    }
}
