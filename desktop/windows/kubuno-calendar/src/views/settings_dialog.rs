//! The « Paramètres de l'agenda » dialog (web `CalendarSettingsPage.tsx` / `ModuleSettingsForm.tsx`): the
//! module's per-user preferences. It loads the resolved settings (`GET /modules/calendar/config`), shows the
//! common ones, and saves changes as user preferences (`PATCH /me`). A representative subset of the manifest's
//! settings is rendered; the rest (holiday calendars, work schedule, secondary timezone…) are later increments.

use kubuno_desktop::prelude::*;
use kubuno_desktop::{Row, Rows, Value as BValue};

use kubuno_calendar_desktop_common::live::{self, SettingValue};

/// `(key, option values)` of the enum dropdowns, with their labels built per language.
fn enum_opts(key: &str, fr: bool) -> Vec<(String, String)> {
    let p = |v: &str, l: &str| (v.to_string(), l.to_string());
    match key {
        "time_format" => vec![p("24h", "24 h (14:30)"), p("12h", "12 h (2:30 PM)")],
        "week_starts_on" => vec![
            p("monday", if fr { "Lundi" } else { "Monday" }),
            p("sunday", if fr { "Dimanche" } else { "Sunday" }),
            p("saturday", if fr { "Samedi" } else { "Saturday" }),
        ],
        "default_view" => vec![
            p("day", if fr { "Jour" } else { "Day" }),
            p("week", if fr { "Semaine" } else { "Week" }),
            p("month", if fr { "Mois" } else { "Month" }),
            p("year", if fr { "Année" } else { "Year" }),
            p("schedule", if fr { "Planning" } else { "Schedule" }),
        ],
        "default_event_duration_min" => [15, 30, 45, 60, 90, 120].iter().map(|m| p(&m.to_string(), &format!("{m} min"))).collect(),
        "default_reminder_min" => vec![
            p("0", if fr { "Aucun" } else { "None" }),
            p("5", "5 min"),
            p("10", "10 min"),
            p("15", "15 min"),
            p("30", "30 min"),
            p("60", if fr { "1 heure" } else { "1 hour" }),
            p("1440", if fr { "1 jour" } else { "1 day" }),
        ],
        "notifications_mode" => vec![
            p("off", if fr { "Désactivées" } else { "Off" }),
            p("in_app", if fr { "Dans l'application" } else { "In-app" }),
            p("desktop", if fr { "Bureau" } else { "Desktop" }),
        ],
        _ => Vec::new(),
    }
}

#[kubuno_desktop::view("settings_dialog.kbview")]
pub struct SettingsDialog {
    #[bind]
    time_format: String,
    #[bind]
    time_format_items: Rows,
    #[bind]
    week_start: String,
    #[bind]
    week_start_items: Rows,
    #[bind]
    default_view: String,
    #[bind]
    default_view_items: Rows,
    #[bind]
    duration: String,
    #[bind]
    duration_items: Rows,
    #[bind]
    reminder: String,
    #[bind]
    reminder_items: Rows,
    #[bind]
    notif_mode: String,
    #[bind]
    notif_mode_items: Rows,
    #[bind]
    speedy: bool,
    #[bind]
    notif_sound: bool,
    #[bind]
    show_weekends: bool,
    #[bind]
    show_week_numbers: bool,
    #[bind]
    dim_past: bool,
    #[bind]
    shortcuts: bool,

    fr: bool,
    saved: bool,
}

impl SettingsDialog {
    pub fn new(fr: bool) -> Self {
        let mut d = Self { fr, ..Self::default() };
        d.initialize_component();
        d
    }

    /// Show it; returns `true` if settings were saved (so the window may reload preferences).
    pub fn run(mut self, owner: &dyn AsForm) -> bool {
        let _ = self.show_dialog(owner);
        self.saved
    }

    fn mk(&self, key: &str) -> Rows {
        Rows::from(enum_opts(key, self.fr).into_iter().map(|(v, l)| Row::new().with("Value", BValue::Str(v)).with("Label", BValue::Str(l))).collect::<Vec<_>>())
    }

    fn settings_load(&mut self) {
        self.time_format_items = self.mk("time_format");
        self.week_start_items = self.mk("week_starts_on");
        self.default_view_items = self.mk("default_view");
        self.duration_items = self.mk("default_event_duration_min");
        self.reminder_items = self.mk("default_reminder_min");
        self.notif_mode_items = self.mk("notifications_mode");

        let cfg = live::fetch_calendar_settings().unwrap_or_default();
        let s = |k: &str, dflt: &str| cfg.get(k).map(|v| v.as_string()).unwrap_or_else(|| dflt.to_string());
        let b = |k: &str, dflt: bool| cfg.get(k).map(|v| v.as_bool()).unwrap_or(dflt);

        self.time_format = s("time_format", "24h");
        self.week_start = s("week_starts_on", "monday");
        self.default_view = s("default_view", "month");
        self.duration = s("default_event_duration_min", "60");
        self.reminder = s("default_reminder_min", "10");
        self.notif_mode = s("notifications_mode", "in_app");
        self.speedy = b("speedy_meetings", false);
        self.notif_sound = b("notification_sound", true);
        self.show_weekends = b("show_weekends", true);
        self.show_week_numbers = b("show_week_numbers", false);
        self.dim_past = b("dim_past_events", true);
        self.shortcuts = b("keyboard_shortcuts", true);
    }

    fn save_click(&mut self) {
        let num = |s: &str| SettingValue::Int(s.parse::<i64>().unwrap_or(0));
        let str_v = |s: &str| SettingValue::Str(s.to_string());
        let changes: Vec<(String, SettingValue)> = vec![
            ("time_format".into(), str_v(&self.time_format)),
            ("week_starts_on".into(), str_v(&self.week_start)),
            ("default_view".into(), str_v(&self.default_view)),
            ("default_event_duration_min".into(), num(&self.duration)),
            ("default_reminder_min".into(), num(&self.reminder)),
            ("notifications_mode".into(), str_v(&self.notif_mode)),
            ("speedy_meetings".into(), SettingValue::Bool(self.speedy)),
            ("notification_sound".into(), SettingValue::Bool(self.notif_sound)),
            ("show_weekends".into(), SettingValue::Bool(self.show_weekends)),
            ("show_week_numbers".into(), SettingValue::Bool(self.show_week_numbers)),
            ("dim_past_events".into(), SettingValue::Bool(self.dim_past)),
            ("keyboard_shortcuts".into(), SettingValue::Bool(self.shortcuts)),
        ];
        match live::save_calendar_settings(&changes) {
            Ok(()) => {
                self.saved = true;
                self.set_dialog_result(DialogResult::Ok);
                self.close();
            }
            Err(e) => kubuno_desktop::tracing::error!("[calendar] save settings failed: {e}"),
        }
    }

    fn cancel_click(&mut self) {
        self.set_dialog_result(DialogResult::Cancel);
        self.close();
    }
}
