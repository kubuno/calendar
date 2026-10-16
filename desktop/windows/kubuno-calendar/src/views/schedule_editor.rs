//! The appointment-schedule editor (web `AppointmentScheduleEditor.tsx`): a two-pane page to create or
//! configure a bookable booking page - a settings pane (two steps: availability/window/calendar, then
//! location/description/reminders) and a live week-availability preview. Wired to the appointment REST API.
//!
//! Faithful reductions for this first desktop increment (noted in the design note): the weekly availability
//! editor manages a single range per weekday (extra ranges and date-specific overrides on an existing schedule
//! are preserved untouched); the custom booking-form-field builder is not yet ported.

use kubuno_desktop::prelude::*;
use kubuno_desktop::{Row, Rows, Value as BValue};

use kubuno_calendar_core::model::Calendar;
use kubuno_calendar_desktop_common::live::{self, AvailRule, ScheduleWrite};

use crate::controls::availability_preview::AvailabilityPreview;
use crate::Resources;

const DURATIONS: [i32; 7] = [15, 20, 30, 45, 60, 90, 120];
const TIMEZONES: [&str; 18] = [
    "UTC", "Europe/Paris", "Europe/London", "Europe/Berlin", "Europe/Madrid", "Europe/Brussels", "Europe/Lisbon",
    "Europe/Zurich", "Africa/Casablanca", "Africa/Douala", "Africa/Abidjan", "America/New_York", "America/Chicago",
    "America/Los_Angeles", "America/Sao_Paulo", "Asia/Dubai", "Asia/Tokyo", "Australia/Sydney",
];

#[kubuno_desktop::view("schedule_editor.kbview")]
pub struct ScheduleEditor {
    #[control]
    preview: Custom<AvailabilityPreview>,

    #[bind]
    window_title: String,
    #[bind]
    title: String,

    // Step flags.
    #[bind]
    is_step1: bool,
    #[bind]
    is_step2: bool,

    // Duration + timezone.
    #[bind]
    duration_value: String,
    #[bind]
    duration_items: Rows,
    #[bind]
    tz_value: String,
    #[bind]
    tz_items: Rows,

    // Shared time options for every start/end dropdown.
    #[bind]
    time_items: Rows,

    // Weekly availability - one editable range per weekday (Mon=0..Sun=6).
    #[bind]
    day0_label: String,
    #[bind]
    day1_label: String,
    #[bind]
    day2_label: String,
    #[bind]
    day3_label: String,
    #[bind]
    day4_label: String,
    #[bind]
    day5_label: String,
    #[bind]
    day6_label: String,
    #[bind]
    day0_on: bool,
    #[bind]
    day1_on: bool,
    #[bind]
    day2_on: bool,
    #[bind]
    day3_on: bool,
    #[bind]
    day4_on: bool,
    #[bind]
    day5_on: bool,
    #[bind]
    day6_on: bool,
    #[bind]
    day0_start: String,
    #[bind]
    day1_start: String,
    #[bind]
    day2_start: String,
    #[bind]
    day3_start: String,
    #[bind]
    day4_start: String,
    #[bind]
    day5_start: String,
    #[bind]
    day6_start: String,
    #[bind]
    day0_end: String,
    #[bind]
    day1_end: String,
    #[bind]
    day2_end: String,
    #[bind]
    day3_end: String,
    #[bind]
    day4_end: String,
    #[bind]
    day5_end: String,
    #[bind]
    day6_end: String,

    // Scheduling window.
    #[bind]
    window_value: String,
    #[bind]
    fixed_visible: bool,
    #[bind]
    start_date: String,
    #[bind]
    end_date: String,
    #[bind]
    maxdays_on: bool,
    #[bind]
    maxdays: f32,
    #[bind]
    minhours_on: bool,
    #[bind]
    minhours: f32,

    // Booked settings.
    #[bind]
    buffer_on: bool,
    #[bind]
    buffer: f32,
    #[bind]
    maxperday_on: bool,
    #[bind]
    maxperday: f32,
    #[bind]
    guests: bool,

    // Calendar.
    #[bind]
    cal_value: String,
    #[bind]
    cal_items: Rows,

    // Step 2.
    #[bind]
    host_name: String,
    #[bind]
    loc_value: String,
    #[bind]
    loc_items: Rows,
    #[bind]
    loc_details: String,
    #[bind]
    loc_details_visible: bool,
    #[bind]
    description: String,
    #[bind]
    rem1_on: bool,
    #[bind]
    rem1_value: String,
    #[bind]
    rem2_on: bool,
    #[bind]
    rem2_value: String,
    #[bind]
    rem_items: Rows,

    // Button labels / visibility.
    #[bind]
    primary_label: String,

    // Non-bound state.
    edit_id: Option<String>,
    calendars: Vec<Calendar>,
    extra_rules: Vec<AvailRule>,
    fr: bool,
    saved: bool,
}

fn to_min(t: &str) -> i32 {
    let mut p = t.split(':');
    let h: i32 = p.next().and_then(|x| x.trim().parse().ok()).unwrap_or(0);
    let m: i32 = p.next().and_then(|x| x.trim().parse().ok()).unwrap_or(0);
    h * 60 + m
}
fn to_time(min: i32) -> String {
    format!("{:02}:{:02}", min / 60, min % 60)
}

impl ScheduleEditor {
    /// A new editor. `edit_id` + `full` is the schedule to edit (or `None` to create). `calendars` are the
    /// owner's writable calendars; `host` the display name for the booking page; `fr` the UI language.
    pub fn new(edit_id: Option<String>, full: Option<ScheduleWrite>, calendars: Vec<Calendar>, extra_rules: Vec<AvailRule>, host: &str, fr: bool) -> Self {
        let mut d = Self {
            edit_id,
            calendars,
            extra_rules,
            fr,
            host_name: host.to_string(),
            is_step1: true,
            ..Self::default()
        };
        d.window_title = if d.edit_id.is_some() { Resources::appt_edit_title().to_string() } else { Resources::appt_new_title().to_string() };
        d.seed(full);
        d.initialize_component();
        d
    }

    /// Show it; returns `true` if a schedule was saved (so the sidebar reloads).
    pub fn run(mut self, owner: &dyn AsForm) -> bool {
        let _ = self.show_dialog(owner);
        self.saved
    }

    fn seed(&mut self, full: Option<ScheduleWrite>) {
        // Weekday labels in the UI language.
        let labels = if self.fr { ["Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi", "Dimanche"] } else { ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] };
        self.day0_label = labels[0].into();
        self.day1_label = labels[1].into();
        self.day2_label = labels[2].into();
        self.day3_label = labels[3].into();
        self.day4_label = labels[4].into();
        self.day5_label = labels[5].into();
        self.day6_label = labels[6].into();

        // Defaults (web DEFAULT_WEEKLY: Mon–Fri 09:00–17:00).
        let host_tz = full.as_ref().map(|f| f.timezone.clone()).unwrap_or_else(|| "Europe/Paris".to_string());
        let mut on = [true, true, true, true, true, false, false];
        let mut starts = [540i32; 7];
        let mut ends = [1020i32; 7];

        if let Some(f) = &full {
            // First weekly range per weekday → the editor; everything else is preserved in extra_rules.
            on = [false; 7];
            for r in &f.availability {
                if let Some(wd) = r.weekday {
                    let wd = wd as usize;
                    if wd < 7 && !on[wd] {
                        on[wd] = true;
                        starts[wd] = r.start_minute;
                        ends[wd] = r.end_minute;
                    }
                }
            }
            self.title = f.title.clone();
            self.description = f.description.clone().unwrap_or_default();
            self.duration_value = f.duration_minutes.to_string();
            self.tz_value = f.timezone.clone();
            self.window_value = f.window_type.clone();
            self.start_date = f.window_start_date.clone().unwrap_or_default();
            self.end_date = f.window_end_date.clone().unwrap_or_default();
            self.maxdays_on = f.window_max_days.is_some();
            self.maxdays = f.window_max_days.unwrap_or(60) as f32;
            self.minhours_on = f.window_min_hours.is_some();
            self.minhours = f.window_min_hours.unwrap_or(4) as f32;
            self.buffer_on = f.buffer_minutes.is_some();
            self.buffer = f.buffer_minutes.unwrap_or(15) as f32;
            self.maxperday_on = f.max_per_day.is_some();
            self.maxperday = f.max_per_day.unwrap_or(4) as f32;
            self.guests = f.guests_can_invite;
            self.cal_value = f.calendar_id.clone();
            self.loc_value = f.location_type.clone();
            self.loc_details = f.location_details.clone().unwrap_or_default();
            let rem = &f.email_reminders;
            self.rem1_on = !rem.is_empty();
            self.rem1_value = rem.first().copied().unwrap_or(1440).to_string();
            self.rem2_on = rem.len() > 1;
            self.rem2_value = rem.get(1).copied().unwrap_or(60).to_string();
        } else {
            self.duration_value = "60".into();
            self.tz_value = host_tz;
            self.window_value = "rolling".into();
            self.maxdays_on = true;
            self.maxdays = 60.0;
            self.minhours_on = true;
            self.minhours = 4.0;
            self.guests = true;
            self.cal_value = self.calendars.iter().find(|c| c.is_default).or_else(|| self.calendars.first()).map(|c| c.id.clone()).unwrap_or_default();
            self.loc_value = "none".into();
            self.rem1_on = true;
            self.rem1_value = "1440".into();
        }

        self.day0_on = on[0];
        self.day1_on = on[1];
        self.day2_on = on[2];
        self.day3_on = on[3];
        self.day4_on = on[4];
        self.day5_on = on[5];
        self.day6_on = on[6];
        self.day0_start = to_time(starts[0]);
        self.day1_start = to_time(starts[1]);
        self.day2_start = to_time(starts[2]);
        self.day3_start = to_time(starts[3]);
        self.day4_start = to_time(starts[4]);
        self.day5_start = to_time(starts[5]);
        self.day6_start = to_time(starts[6]);
        self.day0_end = to_time(ends[0]);
        self.day1_end = to_time(ends[1]);
        self.day2_end = to_time(ends[2]);
        self.day3_end = to_time(ends[3]);
        self.day4_end = to_time(ends[4]);
        self.day5_end = to_time(ends[5]);
        self.day6_end = to_time(ends[6]);

        self.fixed_visible = self.window_value == "fixed";
        self.loc_details_visible = self.loc_value != "none";
        self.primary_label = Resources::appt_next().to_string();
    }

    fn editor_load(&mut self) {
        let mk = |pairs: Vec<(String, String)>| Rows::from(pairs.into_iter().map(|(v, l)| Row::new().with("Value", BValue::Str(v)).with("Label", BValue::Str(l))).collect::<Vec<_>>());

        self.duration_items = mk(DURATIONS
            .iter()
            .map(|d| {
                let label = if *d < 60 { format!("{d} min") } else if *d == 60 { if self.fr { "1 heure".into() } else { "1 hour".into() } } else if self.fr { format!("{} heures", d / 60) } else { format!("{} hours", d / 60) };
                (d.to_string(), label)
            })
            .collect());

        self.tz_items = mk(TIMEZONES.iter().map(|z| (z.to_string(), z.replace('_', " "))).collect());

        // Time options every 15 minutes.
        let mut times = Vec::new();
        let mut m = 0;
        while m < 24 * 60 {
            times.push((to_time(m), to_time(m)));
            m += 15;
        }
        self.time_items = mk(times);

        self.cal_items = mk(self.calendars.iter().map(|c| (c.id.clone(), c.name.clone())).collect());

        let rem = |v: i32| -> String {
            match (v, self.fr) {
                (60, true) => Resources::appt_rem_1h().to_string(),
                (60, false) => "1 hour before".into(),
                (2880, true) => Resources::appt_rem_2d().to_string(),
                (2880, false) => "2 days before".into(),
                (_, true) => Resources::appt_rem_1d().to_string(),
                (_, false) => "1 day before".into(),
            }
        };
        self.rem_items = mk(vec![("60".into(), rem(60)), ("1440".into(), rem(1440)), ("2880".into(), rem(2880))]);

        self.push_preview();
    }

    /// The 7 editable weekday rows → `(enabled, start, end)`.
    fn day_row(&self, d: usize) -> (bool, &str, &str) {
        match d {
            0 => (self.day0_on, &self.day0_start, &self.day0_end),
            1 => (self.day1_on, &self.day1_start, &self.day1_end),
            2 => (self.day2_on, &self.day2_start, &self.day2_end),
            3 => (self.day3_on, &self.day3_start, &self.day3_end),
            4 => (self.day4_on, &self.day4_start, &self.day4_end),
            5 => (self.day5_on, &self.day5_start, &self.day5_end),
            _ => (self.day6_on, &self.day6_start, &self.day6_end),
        }
    }

    fn push_preview(&mut self) {
        let mut weekly: Vec<Vec<(i32, i32)>> = Vec::with_capacity(7);
        for d in 0..7 {
            let (on, s, e) = self.day_row(d);
            weekly.push(if on { vec![(to_min(s), to_min(e))] } else { Vec::new() });
        }
        let fr = self.fr;
        self.preview.with(|v| v.set_weekly(weekly, "#1a73e8", fr));
    }

    /// Any availability field changed → refresh the preview.
    fn avail_changed(&mut self) {
        self.push_preview();
    }

    fn window_changed(&mut self) {
        self.fixed_visible = self.window_value == "fixed";
    }

    fn loc_changed(&mut self) {
        self.loc_details_visible = self.loc_value != "none";
    }

    fn next_click(&mut self) {
        self.is_step1 = false;
        self.is_step2 = true;
        self.primary_label = Resources::appt_save().to_string();
    }

    fn back_click(&mut self) {
        self.is_step1 = true;
        self.is_step2 = false;
        self.primary_label = Resources::appt_next().to_string();
    }

    /// The right-hand primary button: Next on step 1, Save on step 2.
    fn primary_click(&mut self) {
        if self.is_step1 {
            self.next_click();
        } else {
            self.save();
        }
    }

    fn collect(&self) -> ScheduleWrite {
        let mut availability: Vec<AvailRule> = Vec::new();
        for d in 0..7 {
            let (on, s, e) = self.day_row(d);
            if on {
                availability.push(AvailRule { weekday: Some(d as i32), specific_date: None, start_minute: to_min(s), end_minute: to_min(e) });
            }
        }
        // Preserve the rules the single-range editor does not manage.
        availability.extend(self.extra_rules.iter().cloned());

        let opt_i32 = |on: bool, v: f32| if on { Some(v.round() as i32) } else { None };
        let fixed = self.window_value == "fixed";
        let mut reminders = Vec::new();
        if self.rem1_on {
            reminders.push(self.rem1_value.parse().unwrap_or(1440));
        }
        if self.rem2_on {
            reminders.push(self.rem2_value.parse().unwrap_or(60));
        }
        ScheduleWrite {
            calendar_id: self.cal_value.clone(),
            title: self.title.trim().to_string(),
            description: Some(self.description.trim().to_string()).filter(|s| !s.is_empty()),
            duration_minutes: self.duration_value.parse().unwrap_or(60),
            buffer_minutes: opt_i32(self.buffer_on, self.buffer),
            max_per_day: opt_i32(self.maxperday_on, self.maxperday),
            timezone: self.tz_value.clone(),
            window_type: self.window_value.clone(),
            window_max_days: if self.window_value == "rolling" { opt_i32(self.maxdays_on, self.maxdays) } else { None },
            window_min_hours: opt_i32(self.minhours_on, self.minhours),
            window_start_date: if fixed && !self.start_date.is_empty() { Some(self.start_date.clone()) } else { None },
            window_end_date: if fixed && !self.end_date.is_empty() { Some(self.end_date.clone()) } else { None },
            location_type: self.loc_value.clone(),
            location_details: Some(self.loc_details.trim().to_string()).filter(|s| !s.is_empty()),
            guests_can_invite: self.guests,
            host_name: Some(self.host_name.clone()).filter(|s| !s.is_empty()),
            email_reminders: reminders,
            availability,
        }
    }

    fn save(&mut self) {
        let dto = self.collect();
        if dto.calendar_id.is_empty() {
            return;
        }
        match live::save_schedule(&dto, self.edit_id.as_deref()) {
            Ok(_) => {
                self.saved = true;
                self.set_dialog_result(DialogResult::Ok);
                self.close();
            }
            Err(e) => kubuno_desktop::tracing::error!("[calendar] save schedule failed: {e}"),
        }
    }

    fn cancel_click(&mut self) {
        self.set_dialog_result(DialogResult::Cancel);
        self.close();
    }
}
