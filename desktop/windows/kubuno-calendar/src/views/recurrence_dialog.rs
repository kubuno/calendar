//! The custom-recurrence dialog (`recurrence_dialog.kbview`) — the desktop port of the web
//! `RecurrenceCustomDialog.tsx`: « Répéter tous les N [jour/semaine/mois/an] », the weekly weekday toggles,
//! the monthly by-month-day / by-weekday choice, and the « Se termine » end rule (Never / On date / After N).
//! It edits a [`CustomRecurrence`] with the shared core and returns the built RRULE string on « Terminé ».

use kubuno_desktop::prelude::*;
use kubuno_desktop::{Row, Rows, Value as BValue};

use kubuno_calendar_core::date::{Date, Lang};
use kubuno_calendar_core::rrule::{self, CustomRecurrence, End, Freq, MonthlyMode};

use crate::controls::weekday_picker::WeekdayPicker;
use crate::Resources;

/// French / English long weekday names, Monday first (the core keeps its arrays private).
const FR_WEEKDAY: [&str; 7] = ["lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"];
const EN_WEEKDAY: [&str; 7] = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

#[kubuno_desktop::view("recurrence_dialog.kbview")]
pub struct RecurrenceDialog {
    #[control]
    days: Custom<WeekdayPicker>,
    #[bind]
    window_title: String,
    #[bind]
    interval: f32,
    #[bind]
    freq: String,
    #[bind]
    freq_items: Rows,
    #[bind]
    is_weekly: bool,
    #[bind]
    is_monthly: bool,
    #[bind]
    month_mode: String,
    #[bind]
    month_label1: String,
    #[bind]
    month_label2: String,
    #[bind]
    end_mode: String,
    #[bind]
    until: String,
    #[bind]
    count: f32,
    #[bind]
    summary: String,
    start: Date,
    lang: Lang,
    /// The selection to apply to the weekday control once the control exists (set in OnLoad).
    initial_days: Vec<String>,
    /// The RRULE built on « Terminé », while the weekday control is still alive (it is gone by the time
    /// `run` returns after the dialog closes).
    built_rrule: String,
}

impl RecurrenceDialog {
    /// Open the editor on an existing rule (or the default when `rrule` is empty/None).
    pub fn for_rrule(rrule: Option<&str>, start: Date, lang: Lang) -> Self {
        let c = rrule::parse_custom_recurrence(rrule, start);
        let fr = lang == Lang::Fr;
        let mut d = Self { start, lang, ..Self::default() };
        d.window_title = Resources::rec_title().to_string();
        d.interval = c.interval as f32;
        d.freq = freq_code(c.freq).to_string();
        d.month_mode = match c.monthly_mode {
            MonthlyMode::ByMonthDay => "bymonthday".into(),
            MonthlyMode::ByDay => "byday".into(),
        };
        d.end_mode = match c.end {
            End::Never => "never".into(),
            End::Count => "count".into(),
            End::Until => "until".into(),
        };
        d.until = c.until.clone();
        d.count = c.count as f32;
        d.initial_days = c.byday.clone();
        d.freq_items = Rows::from(
            [
                ("DAILY", Resources::rec_unit_day()),
                ("WEEKLY", Resources::rec_unit_week()),
                ("MONTHLY", Resources::rec_unit_month()),
                ("YEARLY", Resources::rec_unit_year()),
            ]
            .into_iter()
            .map(|(v, l)| Row::new().with("Value", BValue::Str(v.to_string())).with("Label", BValue::Str(l.to_string())))
            .collect::<Vec<_>>(),
        );
        d.is_weekly = c.freq == Freq::Weekly;
        d.is_monthly = c.freq == Freq::Monthly;
        d.set_month_labels(fr);
        d.initialize_component();
        d
    }

    /// The two monthly radio labels (« Le 12 du mois » / « Le 2e mardi du mois »), from the start date.
    fn set_month_labels(&mut self, fr: bool) {
        let wd = self.start.weekday_mon0() as usize;
        let name = if fr { FR_WEEKDAY[wd] } else { EN_WEEKDAY[wd] };
        let nth = self.start.day.div_ceil(7);
        let ord = ordinal(nth, fr);
        if fr {
            self.month_label1 = format!("Le {} du mois", self.start.day);
            self.month_label2 = format!("Le {ord} {name} du mois");
        } else {
            self.month_label1 = format!("On day {}", self.start.day);
            self.month_label2 = format!("On the {ord} {name}");
        }
    }

    /// Show it over `owner`; returns the built RRULE on « Terminé », `None` on cancel/close.
    pub fn run(mut self, owner: &dyn AsForm) -> Option<String> {
        match self.show_dialog(owner) {
            DialogResult::Ok => Some(self.built_rrule.clone()),
            _ => None,
        }
    }

    fn recurrence_load(&mut self) {
        let days = std::mem::take(&mut self.initial_days);
        self.days.with(|v| v.set_days(days));
        self.recompute();
    }

    /// Rebuild the editor state from the bindings and refresh the live summary + section visibility.
    fn recompute(&mut self) {
        let c = self.to_custom();
        self.is_weekly = c.freq == Freq::Weekly;
        self.is_monthly = c.freq == Freq::Monthly;
        self.summary = rrule::describe_rrule(Some(&rrule::build_custom_rrule(&c, self.start)), self.lang, self.start).unwrap_or_default();
    }

    /// The current editor state, read from the bindings and the weekday control.
    fn to_custom(&self) -> CustomRecurrence {
        CustomRecurrence {
            freq: parse_freq(&self.freq),
            interval: (self.interval.round() as u32).max(1),
            byday: self.days.with(|v| v.days()).unwrap_or_default(),
            monthly_mode: if self.month_mode == "byday" { MonthlyMode::ByDay } else { MonthlyMode::ByMonthDay },
            end: match self.end_mode.as_str() {
                "count" => End::Count,
                "until" => End::Until,
                _ => End::Never,
            },
            count: (self.count.round() as u32).max(1),
            until: self.until.clone(),
        }
    }

    // ── Field change handlers (all just recompute the summary + visibility) ──
    fn freq_changed(&mut self) {
        self.recompute();
    }
    fn month_mode_changed(&mut self) {
        self.recompute();
    }
    fn end_changed(&mut self) {
        self.recompute();
    }
    fn interval_changed(&mut self) {
        self.recompute();
    }
    fn count_changed(&mut self) {
        self.recompute();
    }
    fn until_changed(&mut self) {
        self.end_mode = "until".into();
        self.recompute();
    }
    fn days_changed(&mut self) {
        self.recompute();
    }

    fn done_click(&mut self) {
        // Build the RRULE now, while the weekday control is still alive.
        self.built_rrule = rrule::build_custom_rrule(&self.to_custom(), self.start);
        self.set_dialog_result(DialogResult::Ok);
        self.close();
    }
    fn cancel_click(&mut self) {
        self.set_dialog_result(DialogResult::Cancel);
        self.close();
    }
}

/// iCal FREQ code → the `Freq` enum (the core keeps `from_str` private).
fn parse_freq(s: &str) -> Freq {
    match s {
        "DAILY" => Freq::Daily,
        "MONTHLY" => Freq::Monthly,
        "YEARLY" => Freq::Yearly,
        _ => Freq::Weekly,
    }
}

fn freq_code(f: Freq) -> &'static str {
    match f {
        Freq::Daily => "DAILY",
        Freq::Weekly => "WEEKLY",
        Freq::Monthly => "MONTHLY",
        Freq::Yearly => "YEARLY",
    }
}

/// « 1er / 2e / … / dernier » (`nth` 5+ means the last), matching `RecurrenceCustomDialog.tsx`.
fn ordinal(nth: u32, fr: bool) -> String {
    if nth >= 5 {
        return if fr { "dernier".into() } else { "last".into() };
    }
    if fr {
        if nth == 1 { "1er".into() } else { format!("{nth}e") }
    } else {
        match nth {
            1 => "1st".into(),
            2 => "2nd".into(),
            3 => "3rd".into(),
            _ => format!("{nth}th"),
        }
    }
}
