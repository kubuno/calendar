//! The event editor dialog (`event_editor.kbview`) — the desktop counterpart of the web `EventEditor.tsx` /
//! `RecurrenceCustomDialog.tsx`: title, start/end (date + time), all-day, location, a recurrence preset, a
//! description, and — when editing a recurring series — the scope (this occurrence / this and following / all).
//! It collects the fields locally and hands the window a [`EventForm`] (UTC timestamps, an RRULE) to POST/PATCH.
//! Guests, reminders, the colour picker, the calendar picker and the full custom-recurrence dialog are later
//! sub-increments.

use kubuno_desktop::prelude::*;
use kubuno_desktop::{Row, Rows, Value as BValue};

use kubuno_calendar_core::date::{Date, Lang};
use kubuno_calendar_core::model::{EventInstance, Instant};
use kubuno_calendar_core::rrule;
use kubuno_calendar_desktop_common::live::EventWrite;

#[kubuno_desktop::view("event_editor.kbview")]
pub struct EventEditor {
    #[bind]
    window_title: String,
    #[bind]
    title: String,
    #[bind]
    all_day: bool,
    /// `!all_day` — drives the time dropdowns' visibility.
    #[bind]
    timed: bool,
    #[bind]
    start_date: String,
    #[bind]
    start_time: String,
    #[bind]
    end_date: String,
    #[bind]
    end_time: String,
    #[bind]
    recurrence: String,
    #[bind]
    location: String,
    #[bind]
    description: String,
    #[bind]
    time_items: Rows,
    #[bind]
    recur_items: Rows,
    #[bind]
    is_recurring_edit: bool,
    #[bind]
    scope: String,
    #[bind]
    scope_items: Rows,
    offset: i32,
    lang: Lang,
    edit_id: Option<String>,
    occurrence: Option<String>,
}

impl EventEditor {
    /// A new-event editor anchored on `date`.
    pub fn for_create(date: Date, offset: i32, lang: Lang) -> Self {
        let mut d = Self { offset, lang, ..Self::default() };
        d.fill_lists();
        d.window_title = if lang == Lang::Fr { "Nouvel événement".into() } else { "New event".into() };
        d.timed = true;
        d.start_date = date.iso();
        d.end_date = date.iso();
        d.start_time = "09:00".into();
        d.end_time = "10:00".into();
        d.recurrence = "none".into();
        d.scope = "all".into();
        d.initialize_component();
        d
    }

    /// An editor for an existing event, prefilled.
    pub fn for_edit(ev: &EventInstance, offset: i32, lang: Lang) -> Self {
        let mut d = Self { offset, lang, ..Self::default() };
        d.fill_lists();
        d.window_title = if lang == Lang::Fr { "Modifier l'événement".into() } else { "Edit event".into() };
        d.title = ev.title.clone();
        d.all_day = ev.all_day;
        d.timed = !ev.all_day;
        d.location = ev.location.clone().unwrap_or_default();
        let (sd, st) = local_parts(&ev.starts_at, offset, ev.all_day);
        let (ed, et) = local_parts(&ev.ends_at, offset, ev.all_day);
        d.start_date = sd;
        d.start_time = st;
        d.end_date = ed;
        d.end_time = et;
        d.recurrence = rrule::preset_from_rrule(ev.rrule.as_deref());
        if d.recurrence == "custom" {
            d.recurrence = "none".into(); // the custom editor is a later sub-increment; keep the rule untouched on save
        }
        d.is_recurring_edit = ev.is_recurring;
        d.occurrence = Some(ev.starts_at.clone());
        d.scope = "all".into();
        d.edit_id = Some(ev.event_id.clone());
        d.initialize_component();
        d
    }

    fn fill_lists(&mut self) {
        // 15-minute time options, 00:00 … 23:45.
        let times: Vec<Row> = (0..96)
            .map(|q| {
                let s = format!("{:02}:{:02}", q / 4, (q % 4) * 15);
                Row::new().with("Value", BValue::Str(s.clone())).with("Label", BValue::Str(s))
            })
            .collect();
        self.time_items = Rows::from(times);
        let fr = self.lang == Lang::Fr;
        let recur = [
            ("none", if fr { "Ne se répète pas" } else { "Does not repeat" }),
            ("daily", if fr { "Tous les jours" } else { "Daily" }),
            ("weekly", if fr { "Toutes les semaines" } else { "Weekly" }),
            ("monthly", if fr { "Tous les mois" } else { "Monthly" }),
            ("yearly", if fr { "Tous les ans" } else { "Yearly" }),
        ];
        self.recur_items = Rows::from(recur.iter().map(|(v, l)| Row::new().with("Value", BValue::Str(v.to_string())).with("Label", BValue::Str(l.to_string()))).collect::<Vec<_>>());
        let scope = [
            ("this", if fr { "Cet événement seulement" } else { "This event only" }),
            ("following", if fr { "Celui-ci et les suivants" } else { "This and following events" }),
            ("all", if fr { "Tous les événements" } else { "All events" }),
        ];
        self.scope_items = Rows::from(scope.iter().map(|(v, l)| Row::new().with("Value", BValue::Str(v.to_string())).with("Label", BValue::Str(l.to_string()))).collect::<Vec<_>>());
    }

    /// Show it over `owner`; returns the collected form on Save, `None` on cancel/close.
    pub fn run(mut self, owner: &dyn AsForm) -> Option<EventWrite> {
        match self.show_dialog(owner) {
            DialogResult::Ok => Some(self.collect()),
            _ => None,
        }
    }

    fn allday_changed(&mut self) {
        self.timed = !self.all_day;
    }

    fn save_click(&mut self) {
        self.set_dialog_result(DialogResult::Ok);
        self.close();
    }

    fn cancel_click(&mut self) {
        self.set_dialog_result(DialogResult::Cancel);
        self.close();
    }

    /// Build the REST payload from the fields.
    fn collect(&self) -> EventWrite {
        let sd = Date::parse(&self.start_date).unwrap_or(Date { year: 2026, month: 1, day: 1 });
        let ed = Date::parse(&self.end_date).unwrap_or(sd);
        let (starts_at, ends_at) = if self.all_day {
            (format!("{}T00:00:00Z", sd.iso()), format!("{}T23:59:59Z", ed.iso()))
        } else {
            let (sh, sm) = hm(&self.start_time);
            let (eh, em) = hm(&self.end_time);
            (Instant::from_local(sd, sh, sm, 0, self.offset).iso_utc(), Instant::from_local(ed, eh, em, 0, self.offset).iso_utc())
        };
        let rrule = if self.recurrence == "none" { None } else { rrule::build_rrule(&self.recurrence, sd) };
        EventWrite {
            title: self.title.clone(),
            starts_at,
            ends_at,
            all_day: self.all_day,
            location: self.location.clone(),
            rrule,
            edit_id: self.edit_id.clone(),
            occurrence: if self.is_recurring_edit { self.occurrence.clone() } else { None },
            scope: if self.is_recurring_edit { Some(self.scope.clone()) } else { None },
        }
    }
}

/// `"HH:MM"` → `(hour, minute)`.
fn hm(s: &str) -> (u32, u32) {
    let mut it = s.split(':');
    let h = it.next().and_then(|x| x.parse().ok()).unwrap_or(0);
    let m = it.next().and_then(|x| x.parse().ok()).unwrap_or(0);
    (h, m)
}

/// The local date (`YYYY-MM-DD`) and time (`HH:MM`) of an instant, for prefilling the editor.
fn local_parts(iso: &str, offset: i32, all_day: bool) -> (String, String) {
    match Instant::parse(iso) {
        Some(i) if all_day => (i.utc_date().iso(), "00:00".into()),
        Some(i) => {
            let l = i.local(offset);
            (l.date.iso(), format!("{:02}:{:02}", l.hour, l.minute))
        }
        None => (String::new(), "09:00".into()),
    }
}
