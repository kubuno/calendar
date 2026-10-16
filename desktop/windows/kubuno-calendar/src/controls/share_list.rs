//! `ShareList` - the people a calendar is shared with (`web/src/CalendarShareModal.tsx`, the « Personnes ayant
//! accès » section): one row per share with the person's name, their permission (read / write) and a « Retirer »
//! action. Clicking « Retirer » raises `OnRemove` with that user's id; the dialog revokes the share and
//! refreshes the list.

use kubuno_desktop::prelude::MouseEventArgs;
use kubuno_desktop::ui::graphics::{Brush, Font, FontStyle, StringAlignment, StringFormat, StringFormatFlags, StringTrimming};
use kubuno_desktop::ui::{Canvas, Rect, Size};
use kubuno_desktop::views::component::{Control, ControlCore, EventCx, PaintEventCx};
use kubuno_desktop::views::events::Event;

use crate::controls::model::Palette;

/// A « Retirer » button was clicked: the user whose access to revoke.
#[derive(kubuno_desktop::views::events::EventArgs, Debug, Clone, Default, PartialEq)]
pub struct RemoveShareArgs {
    pub user_id: String,
}

const ROW_H: f32 = 34.0;
const REMOVE_W: f32 = 70.0;

#[derive(kubuno_desktop::views::component::Component, Default)]
#[kubuno(extends = Control, overrides(Control))]
#[category("Calendar")]
#[toolbox(icon = "users")]
#[default_event("Remove")]
pub struct ShareList {
    base: ControlCore,
    #[event]
    #[category("Action")]
    pub remove: Event<RemoveShareArgs>,
    /// `(user_id, display_name, permission)` - set by the dialog after each refresh.
    rows: Vec<(String, String, String)>,
    /// Whether the directory is still being queried (shows a discreet placeholder).
    loading: bool,
    /// Hit rectangles (control-relative) of each « Retirer » button → user id.
    hits: Vec<(Rect, String)>,
    lang_fr: bool,
}

impl ShareList {
    pub fn set_rows(&mut self, rows: Vec<(String, String, String)>, lang_fr: bool) {
        self.rows = rows;
        self.loading = false;
        self.lang_fr = lang_fr;
        self.invalidate();
    }

    pub fn set_loading(&mut self, loading: bool) {
        self.loading = loading;
        self.invalidate();
    }

    fn perm_label(&self, perm: &str) -> &'static str {
        match (perm, self.lang_fr) {
            ("write", true) => "Modification",
            ("write", false) => "Can edit",
            (_, true) => "Lecture seule",
            (_, false) => "Read only",
        }
    }
}

impl Control for ShareList {
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
        let f = Font::with_dip("Segoe UI", 12.0, FontStyle::REGULAR);
        let f_small = Font::with_dip("Segoe UI", 11.0, FontStyle::REGULAR);
        let near = StringFormat { alignment: StringAlignment::Near, line_alignment: StringAlignment::Center, trimming: StringTrimming::EllipsisCharacter, flags: StringFormatFlags::NO_WRAP };
        let far = StringFormat { alignment: StringAlignment::Far, line_alignment: StringAlignment::Center, trimming: StringTrimming::EllipsisCharacter, flags: StringFormatFlags::NO_WRAP };
        let rel = |r: Rect| Rect::new(r.left - b.left, r.top - b.top, r.right - b.left, r.bottom - b.top);

        // Empty / loading state.
        if self.rows.is_empty() {
            let msg = if self.loading {
                if self.lang_fr { "Chargement…" } else { "Loading…" }
            } else if self.lang_fr {
                "Cet agenda n'est partagé avec personne."
            } else {
                "This calendar is not shared with anyone."
            };
            g.draw_string(msg, &f, Brush::solid(th.text_tertiary), Rect::new(b.left + 2.0, b.top, b.right - 2.0, b.top + ROW_H), &near);
            e.raise(self, "OnPaint");
            return;
        }

        for (i, (uid, name, perm)) in self.rows.iter().enumerate() {
            let top = b.top + i as f32 * ROW_H;
            // The person's name.
            g.draw_string(name, &f, Brush::solid(th.text_primary), Rect::new(b.left + 4.0, top, b.right - 180.0, top + ROW_H), &near);
            // The permission, right-aligned before the « Retirer » button.
            g.draw_string(self.perm_label(perm), &f_small, Brush::solid(th.text_secondary), Rect::new(b.right - REMOVE_W - 120.0, top, b.right - REMOVE_W - 8.0, top + ROW_H), &far);
            // The « Retirer » button.
            let remove = if self.lang_fr { "Retirer" } else { "Remove" };
            let btn = Rect::new(b.right - REMOVE_W, top + 4.0, b.right - 2.0, top + ROW_H - 4.0);
            g.draw_string(remove, &f_small, Brush::solid(th.danger), btn, &far);
            self.hits.push((rel(Rect::new(btn.left - 8.0, top, b.right, top + ROW_H)), uid.clone()));
        }
        e.raise(self, "OnPaint");
    }

    fn on_mouse_down(&mut self, e: &mut EventCx<'_, MouseEventArgs>) {
        let (x, y) = (e.args().x, e.args().y);
        if let Some((_, uid)) = self.hits.iter().find(|(r, _)| r.contains(x, y)).cloned() {
            self.raise_remove(RemoveShareArgs { user_id: uid });
        }
        e.raise(&*self, "OnMouseDown");
    }
}
