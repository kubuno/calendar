//! The « Partager » dialog (web `CalendarShareModal.tsx`): share a calendar with other Kubuno users (read /
//! write), list and revoke the existing shares, and publish a public read-only `.ics` link. Each action calls
//! the calendar REST API directly and refreshes in place, exactly as the web modal does.

use kubuno_desktop::prelude::*;
use kubuno_desktop::{Row, Rows, Value as BValue};

use kubuno_calendar_desktop_common::live;

use crate::controls::share_list::{RemoveShareArgs, ShareList};
use crate::Resources;

#[kubuno_desktop::view("share_dialog.kbview")]
pub struct ShareDialog {
    #[control]
    shares: Custom<ShareList>,
    #[bind]
    window_title: String,
    /// The user-search query for the « Ajouter » row.
    #[bind]
    user_query: String,
    /// The permission to grant: `"read"` or `"write"`.
    #[bind]
    perm_value: String,
    #[bind]
    perm_items: Rows,
    /// Whether the calendar is public (the toggle checkbox).
    #[bind]
    is_public: bool,
    /// The public feed URL label (shown only when public).
    #[bind]
    feed_url: String,
    #[bind]
    feed_visible: bool,
    /// A short status / error line.
    #[bind]
    status: String,

    cal_id: String,
    caldav_token: String,
    fr: bool,
}

impl ShareDialog {
    pub fn new(cal_id: &str, name: &str, is_public: bool, caldav_token: &str, fr: bool) -> Self {
        let title = if fr { format!("Partager « {name} »") } else { format!("Share \u{201c}{name}\u{201d}") };
        let mut d = Self {
            window_title: title,
            perm_value: "read".to_string(),
            is_public,
            cal_id: cal_id.to_string(),
            caldav_token: caldav_token.to_string(),
            fr,
            ..Self::default()
        };
        d.initialize_component();
        d
    }

    /// Show the dialog; returns `true` when the calendar may have changed (so the window reloads its list).
    pub fn run(mut self, owner: &dyn AsForm) -> bool {
        let _ = self.show_dialog(owner);
        true
    }

    fn share_load(&mut self) {
        self.perm_items = Rows::from(vec![
            Row::new().with("Value", BValue::Str("read".into())).with("Label", BValue::Str(Resources::share_perm_read().to_string())),
            Row::new().with("Value", BValue::Str("write".into())).with("Label", BValue::Str(Resources::share_perm_write().to_string())),
        ]);
        self.update_feed();
        self.shares.with(|v| v.set_loading(true));
        self.reload_shares();
    }

    /// Recompute the public feed URL label and its visibility from `is_public`.
    fn update_feed(&mut self) {
        self.feed_visible = self.is_public;
        self.feed_url = if self.is_public { live::public_feed_url(&self.caldav_token) } else { String::new() };
    }

    /// Fetch the shares, resolve the user names, and push them into the list control.
    fn reload_shares(&mut self) {
        let rows = match live::list_shares(&self.cal_id) {
            Ok(s) => s,
            Err(e) => {
                kubuno_desktop::tracing::error!("[calendar] list shares failed: {e}");
                self.shares.with(|v| v.set_rows(Vec::new(), self.fr));
                return;
            }
        };
        let ids: Vec<String> = rows.iter().map(|(id, _)| id.clone()).collect();
        let names: std::collections::HashMap<String, String> = live::lookup_users(&ids).unwrap_or_default().into_iter().collect();
        let fr = self.fr;
        let out: Vec<(String, String, String)> = rows
            .into_iter()
            .map(|(id, perm)| {
                let name = names.get(&id).cloned().unwrap_or_else(|| id.chars().take(8).collect());
                (id, name, perm)
            })
            .collect();
        self.shares.with(|v| v.set_rows(out, fr));
    }

    /// The public-link checkbox changed: publish or unpublish the calendar.
    fn public_changed(&mut self) {
        match live::set_calendar_public(&self.cal_id, self.is_public) {
            Ok(now) => {
                self.is_public = now;
                self.update_feed();
                self.status = String::new();
            }
            Err(e) => {
                kubuno_desktop::tracing::error!("[calendar] set public failed: {e}");
                // Roll the checkbox back to the server's state.
                self.is_public = !self.is_public;
                self.status = if self.fr { "Publication refusée par l'instance.".into() } else { "Publishing refused by the instance.".into() };
            }
        }
    }

    /// « Ajouter »: search the directory for the typed user and share with the first match.
    fn add_click(&mut self) {
        let q = self.user_query.trim().to_string();
        if q.is_empty() {
            return;
        }
        let matches = match live::search_users(&q) {
            Ok(m) => m,
            Err(e) => {
                kubuno_desktop::tracing::error!("[calendar] user search failed: {e}");
                return;
            }
        };
        let Some((id, _, _)) = matches.into_iter().next() else {
            self.status = if self.fr { "Aucun utilisateur trouvé.".into() } else { "No user found.".into() };
            return;
        };
        match live::share_calendar(&self.cal_id, &id, &self.perm_value) {
            Ok(()) => {
                self.user_query = String::new();
                self.status = String::new();
                self.reload_shares();
            }
            Err(e) => kubuno_desktop::tracing::error!("[calendar] share failed: {e}"),
        }
    }

    /// A « Retirer » button of the list: revoke that user's access.
    fn remove_share(&mut self, args: &RemoveShareArgs) {
        match live::unshare_calendar(&self.cal_id, &args.user_id) {
            Ok(()) => {
                self.reload_shares();
            }
            Err(e) => kubuno_desktop::tracing::error!("[calendar] unshare failed: {e}"),
        }
    }

    fn close_click(&mut self) {
        self.set_dialog_result(DialogResult::Ok);
        self.close();
    }
}
