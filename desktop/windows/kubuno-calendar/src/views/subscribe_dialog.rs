//! The « S'abonner à un agenda » dialog (web `CalendarSubscribeModal.tsx`): a name and an external .ics URL.
//! The window posts them to `POST /calendar/calendars/subscribe`, which mirrors the feed as a new calendar.

use kubuno_desktop::prelude::*;

use crate::Resources;

#[kubuno_desktop::view("subscribe_dialog.kbview")]
pub struct SubscribeDialog {
    #[bind]
    window_title: String,
    #[bind]
    name: String,
    #[bind]
    url: String,
}

impl SubscribeDialog {
    pub fn new() -> Self {
        let mut d = Self { window_title: Resources::sub_title().to_string(), ..Self::default() };
        d.initialize_component();
        d
    }

    /// Show it; returns `(name, url)` on « S'abonner », `None` on cancel.
    pub fn run(mut self, owner: &dyn AsForm) -> Option<(String, String)> {
        match self.show_dialog(owner) {
            DialogResult::Ok => {
                let name = self.name.trim().to_string();
                let url = self.url.trim().to_string();
                if name.is_empty() || url.is_empty() {
                    None
                } else {
                    Some((name, url))
                }
            }
            _ => None,
        }
    }

    fn ok_click(&mut self) {
        self.set_dialog_result(DialogResult::Ok);
        self.close();
    }
    fn cancel_click(&mut self) {
        self.set_dialog_result(DialogResult::Cancel);
        self.close();
    }
}
