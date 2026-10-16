//! The « Accès CalDAV » dialog (web `CalendarCalDavSettings.tsx`): the CalDAV connection details so the user
//! can sync their calendars with Apple Calendar, Thunderbird, Android (DAVx5), Windows, etc. Display only - the
//! main endpoint (server URL + username) and, per calendar, its CalDAV URL built from the calendar's token.

use kubuno_desktop::prelude::*;

use kubuno_calendar_core::model::Calendar;
use kubuno_calendar_desktop_common::live;

use crate::controls::caldav_list::CalDavList;
use crate::Resources;

#[kubuno_desktop::view("caldav_dialog.kbview")]
pub struct CalDavDialog {
    #[control]
    cals: Custom<CalDavList>,
    #[bind]
    server_url: String,
    #[bind]
    username: String,

    calendars: Vec<Calendar>,
    origin: String,
}

impl CalDavDialog {
    pub fn new(calendars: Vec<Calendar>) -> Self {
        let mut d = Self { calendars, ..Self::default() };
        d.initialize_component();
        d
    }

    pub fn run(mut self, owner: &dyn AsForm) {
        let _ = self.show_dialog(owner);
    }

    fn caldav_load(&mut self) {
        self.origin = live::server_origin();
        let username = live::fetch_username().unwrap_or_default();
        self.username = username.clone();
        self.server_url = format!("{}/api/v1/calendar/caldav/{}/", self.origin, username);

        let origin = self.origin.clone();
        let rows: Vec<(String, String, String, bool)> = self
            .calendars
            .iter()
            .map(|c| {
                let url = format!("{}/api/v1/calendar/caldav/{}/{}/", origin, username, c.caldav_token);
                (c.color.clone(), c.name.clone(), url, c.is_default)
            })
            .collect();
        self.cals.with(|v| v.set_rows(rows, Resources::caldav_default()));
    }

    fn close_click(&mut self) {
        self.set_dialog_result(DialogResult::Ok);
        self.close();
    }
}
