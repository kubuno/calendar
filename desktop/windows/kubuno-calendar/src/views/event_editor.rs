//! The event editor dialog (`event_editor.kbview`) — the desktop counterpart of the web `EventEditor.tsx` /
//! `RecurrenceCustomDialog.tsx`: title, start/end (date + time), all-day, location, a recurrence preset, a
//! description, and — when editing a recurring series — the scope (this occurrence / this and following / all).
//! It collects the fields locally and hands the window a [`EventForm`] (UTC timestamps, an RRULE) to POST/PATCH.
//! Guests, reminders, the colour picker, the calendar picker and the full custom-recurrence dialog are later
//! sub-increments.

use kubuno_desktop::prelude::*;
use kubuno_desktop::{Row, Rows, Value as BValue};

use kubuno_calendar_core::date::{Date, Lang};
use kubuno_calendar_core::model::{Calendar, EventInstance, Instant};
use kubuno_calendar_core::rrule;
use kubuno_calendar_desktop_common::live::EventWrite;

use crate::controls::color_swatches::ColorSwatches;
use crate::Resources;

#[kubuno_desktop::view("event_editor.kbview")]
pub struct EventEditor {
    #[control]
    colors: Custom<ColorSwatches>,
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
    #[bind]
    cal_items: Rows,
    #[bind]
    cal_value: String,
    // Reminders — up to two rows (the common case); each is a method + an offset, matching the web.
    #[bind]
    rem_type_items: Rows,
    #[bind]
    rem_min_items: Rows,
    #[bind]
    rem1_type: String,
    #[bind]
    rem1_min: String,
    #[bind]
    rem1_vis: bool,
    #[bind]
    rem2_type: String,
    #[bind]
    rem2_min: String,
    #[bind]
    rem2_vis: bool,
    /// Whether another reminder row can still be added (fewer than two shown).
    #[bind]
    can_add_rem: bool,
    // Guests — an e-mail field plus up to four invited rows, and the three permission toggles (web
    // GuestField / GuestRow / GuestPermissions). Guests are sent on create; editing guests of an existing
    // event goes through the attendee API and is a later sub-increment.
    #[bind]
    guest_email: String,
    #[bind]
    guest1: String,
    #[bind]
    guest1_vis: bool,
    #[bind]
    guest2: String,
    #[bind]
    guest2_vis: bool,
    #[bind]
    guest3: String,
    #[bind]
    guest3_vis: bool,
    #[bind]
    guest4: String,
    #[bind]
    guest4_vis: bool,
    #[bind]
    can_add_guest: bool,
    #[bind]
    perm_modify: bool,
    #[bind]
    perm_invite: bool,
    #[bind]
    perm_see: bool,
    offset: i32,
    lang: Lang,
    edit_id: Option<String>,
    occurrence: Option<String>,
    /// `(calendar id, colour)` for every offered calendar, so the colour swatches follow the picked calendar.
    cal_colors: Vec<(String, String)>,
    /// The per-event colour to preselect on the swatches once the control exists (set in OnLoad).
    init_color: Option<String>,
    /// The colour read from the swatch control on Save (the control is gone by the time `collect` runs).
    picked_color: Option<String>,
    /// The RRULE built by the custom-recurrence dialog, used when `recurrence == "custom"`.
    custom_rrule: Option<String>,
    /// The recurrence value before the current dropdown change, to restore if the custom dialog is cancelled.
    prev_recurrence: String,
}

impl EventEditor {
    /// A new-event editor anchored on `date`, with the writable `calendars` and the default one preselected.
    pub fn for_create(date: Date, offset: i32, lang: Lang, calendars: &[Calendar], default_calendar: &str) -> Self {
        let mut d = Self { offset, lang, ..Self::default() };
        d.fill_lists();
        d.fill_calendars(calendars, default_calendar);
        d.fill_reminder_items();
        // One default reminder, like the web (a notification 10 minutes before).
        d.rem1_type = "popup".into();
        d.rem1_min = "10".into();
        d.rem1_vis = true;
        d.can_add_rem = true;
        // Guest permission defaults, like the web.
        d.perm_modify = false;
        d.perm_invite = true;
        d.perm_see = true;
        d.can_add_guest = true;
        d.window_title = if lang == Lang::Fr { "Nouvel événement".into() } else { "New event".into() };
        d.timed = true;
        d.start_date = date.iso();
        d.end_date = date.iso();
        d.start_time = "09:00".into();
        d.end_time = "10:00".into();
        d.recurrence = "none".into();
        d.prev_recurrence = "none".into();
        d.scope = "all".into();
        d.initialize_component();
        d
    }

    /// An editor for an existing event, prefilled, with the writable `calendars` offered in the picker and the
    /// event's current `guests` (non-organizer e-mails) loaded into the guest rows.
    pub fn for_edit(ev: &EventInstance, offset: i32, lang: Lang, calendars: &[Calendar], guests: &[String]) -> Self {
        let mut d = Self { offset, lang, ..Self::default() };
        d.fill_lists();
        d.fill_calendars(calendars, &ev.calendar_id);
        d.fill_reminder_items();
        d.load_reminders(&ev.reminders);
        d.set_guests(guests.to_vec());
        d.perm_modify = ev.guests_can_modify.unwrap_or(false);
        d.perm_invite = ev.guests_can_invite.unwrap_or(true);
        d.perm_see = ev.guests_can_see_guests.unwrap_or(true);
        d.can_add_guest = true;
        d.init_color = ev.color.clone();
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
            // A rule beyond the simple presets: keep it and let the custom dialog edit it.
            d.custom_rrule = ev.rrule.clone();
        }
        d.prev_recurrence = d.recurrence.clone();
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
            ("custom", Resources::ev_recur_custom()),
        ];
        self.recur_items = Rows::from(recur.iter().map(|(v, l)| Row::new().with("Value", BValue::Str(v.to_string())).with("Label", BValue::Str(l.to_string()))).collect::<Vec<_>>());
        let scope = [
            ("this", if fr { "Cet événement seulement" } else { "This event only" }),
            ("following", if fr { "Celui-ci et les suivants" } else { "This and following events" }),
            ("all", if fr { "Tous les événements" } else { "All events" }),
        ];
        self.scope_items = Rows::from(scope.iter().map(|(v, l)| Row::new().with("Value", BValue::Str(v.to_string())).with("Label", BValue::Str(l.to_string()))).collect::<Vec<_>>());
    }

    /// Build the calendar-picker options and remember each calendar's colour, selecting `selected` (or the
    /// first offered calendar when it is not writable / absent).
    fn fill_calendars(&mut self, calendars: &[Calendar], selected: &str) {
        self.cal_items = Rows::from(
            calendars
                .iter()
                .map(|c| Row::new().with("Value", BValue::Str(c.id.clone())).with("Label", BValue::Str(c.name.clone())))
                .collect::<Vec<_>>(),
        );
        self.cal_colors = calendars.iter().map(|c| (c.id.clone(), c.color.clone())).collect();
        self.cal_value = if calendars.iter().any(|c| c.id == selected) {
            selected.to_string()
        } else {
            calendars.first().map(|c| c.id.clone()).unwrap_or_default()
        };
    }

    /// The colour of the currently-picked calendar.
    fn current_cal_color(&self) -> String {
        self.cal_colors.iter().find(|(id, _)| *id == self.cal_value).map(|(_, c)| c.clone()).unwrap_or_default()
    }

    /// The reminder dropdowns' options: the method (notification / e-mail) and the offset (`REMINDER_OPTIONS`).
    fn fill_reminder_items(&mut self) {
        let fr = self.lang == Lang::Fr;
        self.rem_type_items = Rows::from(vec![
            Row::new().with("Value", BValue::Str("popup".into())).with("Label", BValue::Str(Resources::rem_notification().to_string())),
            Row::new().with("Value", BValue::Str("email".into())).with("Label", BValue::Str(Resources::rem_email().to_string())),
        ]);
        let opts: [(i64, &str, &str); 7] = [
            (5, "5 min avant", "5 min before"),
            (10, "10 min avant", "10 min before"),
            (15, "15 min avant", "15 min before"),
            (30, "30 min avant", "30 min before"),
            (60, "1 h avant", "1 h before"),
            (120, "2 h avant", "2 h before"),
            (1440, "1 jour avant", "1 day before"),
        ];
        self.rem_min_items = Rows::from(
            opts.iter()
                .map(|(v, frl, enl)| Row::new().with("Value", BValue::Str(v.to_string())).with("Label", BValue::Str((if fr { *frl } else { *enl }).to_string())))
                .collect::<Vec<_>>(),
        );
    }

    /// Prefill the two reminder rows from an event's reminders (at most two shown).
    fn load_reminders(&mut self, reminders: &[kubuno_calendar_core::model::EventReminder]) {
        let norm = |k: &str| if k == "email" { "email".to_string() } else { "popup".to_string() };
        if let Some(r) = reminders.first() {
            self.rem1_type = norm(&r.kind);
            self.rem1_min = r.minutes_before.to_string();
            self.rem1_vis = true;
        }
        if let Some(r) = reminders.get(1) {
            self.rem2_type = norm(&r.kind);
            self.rem2_min = r.minutes_before.to_string();
            self.rem2_vis = true;
        }
        self.can_add_rem = !(self.rem1_vis && self.rem2_vis);
    }

    /// The reminders to send, as `(method, minutes_before)` pairs from the visible rows.
    fn reminders_list(&self) -> Vec<(String, i64)> {
        let mut out = Vec::new();
        for (vis, kind, min) in [(self.rem1_vis, &self.rem1_type, &self.rem1_min), (self.rem2_vis, &self.rem2_type, &self.rem2_min)] {
            if vis {
                out.push((kind.clone(), min.parse::<i64>().unwrap_or(10)));
            }
        }
        out
    }

    fn add_reminder(&mut self) {
        if !self.rem1_vis {
            self.rem1_type = "popup".into();
            self.rem1_min = "10".into();
            self.rem1_vis = true;
        } else if !self.rem2_vis {
            self.rem2_type = "popup".into();
            self.rem2_min = "10".into();
            self.rem2_vis = true;
        }
        self.can_add_rem = !(self.rem1_vis && self.rem2_vis);
    }

    fn remove_rem1(&mut self) {
        if self.rem2_vis {
            // Shift the second row up into the first.
            self.rem1_type = std::mem::take(&mut self.rem2_type);
            self.rem1_min = std::mem::take(&mut self.rem2_min);
            self.rem2_vis = false;
        } else {
            self.rem1_vis = false;
        }
        self.can_add_rem = !(self.rem1_vis && self.rem2_vis);
    }

    fn remove_rem2(&mut self) {
        self.rem2_vis = false;
        self.can_add_rem = true;
    }

    // ── Guests ────────────────────────────────────────────────────────────────

    /// The invited e-mail addresses currently shown, in order.
    fn guests(&self) -> Vec<String> {
        let mut v = Vec::new();
        for (vis, g) in [(self.guest1_vis, &self.guest1), (self.guest2_vis, &self.guest2), (self.guest3_vis, &self.guest3), (self.guest4_vis, &self.guest4)] {
            if vis {
                v.push(g.clone());
            }
        }
        v
    }

    /// Lay a list of guests back into the four rows.
    fn set_guests(&mut self, list: Vec<String>) {
        self.guest1 = String::new();
        self.guest2 = String::new();
        self.guest3 = String::new();
        self.guest4 = String::new();
        self.guest1_vis = false;
        self.guest2_vis = false;
        self.guest3_vis = false;
        self.guest4_vis = false;
        for (i, g) in list.into_iter().take(4).enumerate() {
            match i {
                0 => (self.guest1, self.guest1_vis) = (g, true),
                1 => (self.guest2, self.guest2_vis) = (g, true),
                2 => (self.guest3, self.guest3_vis) = (g, true),
                _ => (self.guest4, self.guest4_vis) = (g, true),
            }
        }
        self.can_add_guest = self.guests().len() < 4;
    }

    fn add_guest(&mut self) {
        let email = self.guest_email.trim().to_string();
        if !is_email(&email) {
            return;
        }
        let mut g = self.guests();
        if g.len() < 4 {
            g.push(email);
            self.set_guests(g);
            self.guest_email = String::new();
        }
    }

    fn remove_guest_at(&mut self, i: usize) {
        let mut g = self.guests();
        if i < g.len() {
            g.remove(i);
        }
        self.set_guests(g);
    }

    fn remove_guest1(&mut self) {
        self.remove_guest_at(0);
    }
    fn remove_guest2(&mut self) {
        self.remove_guest_at(1);
    }
    fn remove_guest3(&mut self) {
        self.remove_guest_at(2);
    }
    fn remove_guest4(&mut self) {
        self.remove_guest_at(3);
    }

    /// Show it over `owner`; returns the collected form on Save, `None` on cancel/close.
    pub fn run(mut self, owner: &dyn AsForm) -> Option<EventWrite> {
        match self.show_dialog(owner) {
            DialogResult::Ok => Some(self.collect()),
            _ => None,
        }
    }

    /// Push the calendar colour and the preselected event colour into the swatch control (it exists only now).
    fn editor_load(&mut self) {
        let cal = self.current_cal_color();
        // A per-event colour equal to the calendar colour is « default » (no per-event colour), like the web.
        let sel = self.init_color.clone().filter(|c| !c.eq_ignore_ascii_case(&cal));
        self.colors.with(|v| {
            v.set_calendar_color(cal);
            v.set_selected(sel);
        });
    }

    fn allday_changed(&mut self) {
        self.timed = !self.all_day;
    }

    /// The calendar picker changed: the first colour swatch follows the picked calendar's colour.
    fn cal_changed(&mut self) {
        let cal = self.current_cal_color();
        self.colors.with(|v| v.set_calendar_color(cal));
    }

    /// The recurrence dropdown changed. « Personnalisé… » opens the custom-recurrence dialog; cancelling it
    /// restores the previous selection. The other presets are remembered so a later cancel can restore them.
    fn recur_changed(&mut self) {
        if self.recurrence == "custom" {
            let sd = Date::parse(&self.start_date).unwrap_or(Date { year: 2026, month: 1, day: 1 });
            let dialog = crate::views::recurrence_dialog::RecurrenceDialog::for_rrule(self.custom_rrule.as_deref(), sd, self.lang);
            match dialog.run(self) {
                Some(rule) => {
                    self.custom_rrule = Some(rule);
                    self.prev_recurrence = "custom".into();
                }
                None => {
                    // Cancelled: restore the previous selection.
                    self.recurrence = self.prev_recurrence.clone();
                }
            }
        } else {
            self.prev_recurrence = self.recurrence.clone();
        }
    }

    fn save_click(&mut self) {
        // Read the colour now, while the swatch control is still alive (it is gone once the dialog closes).
        self.picked_color = self.colors.with(|v| v.selected_color()).flatten();
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
        let rrule = match self.recurrence.as_str() {
            "none" => None,
            "custom" => self.custom_rrule.clone(),
            preset => rrule::build_rrule(preset, sd),
        };
        EventWrite {
            title: self.title.clone(),
            starts_at,
            ends_at,
            all_day: self.all_day,
            location: self.location.clone(),
            description: self.description.clone(),
            rrule,
            color: self.picked_color.clone(),
            reminders: Some(self.reminders_list()),
            // The guest e-mails: sent as `attendees` on create, reconciled through the attendee API on edit.
            attendees: Some(self.guests()),
            guests_can_modify: Some(self.perm_modify),
            guests_can_invite: Some(self.perm_invite),
            guests_can_see_guests: Some(self.perm_see),
            calendar_target: if self.cal_value.is_empty() { None } else { Some(self.cal_value.clone()) },
            edit_id: self.edit_id.clone(),
            occurrence: if self.is_recurring_edit { self.occurrence.clone() } else { None },
            scope: if self.is_recurring_edit { Some(self.scope.clone()) } else { None },
        }
    }
}

/// A lenient e-mail check for the guest field (`local@domain.tld`), mirroring the web's add guard.
fn is_email(s: &str) -> bool {
    let s = s.trim();
    match s.split_once('@') {
        Some((local, domain)) => !local.is_empty() && domain.contains('.') && !domain.starts_with('.') && !domain.ends_with('.') && !domain.contains(' '),
        None => false,
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
