//! The « Ajouter un lieu » dialog (web `WeatherSettings.tsx`): search the geocoder for a city and save it as a
//! weather location. A search box, a results dropdown and an « Ajouter » button, wired to the weather REST API.

use kubuno_desktop::prelude::*;
use kubuno_desktop::{Row, Rows, Value as BValue};

use kubuno_calendar_desktop_common::live::{self, GeoResult};

#[kubuno_desktop::view("weather_dialog.kbview")]
pub struct WeatherDialog {
    #[bind]
    query: String,
    #[bind]
    result_value: String,
    #[bind]
    result_items: Rows,
    #[bind]
    status: String,

    results: Vec<GeoResult>,
    fr: bool,
    saved: bool,
}

impl WeatherDialog {
    pub fn new(fr: bool) -> Self {
        let mut d = Self { fr, ..Self::default() };
        d.initialize_component();
        d
    }

    /// Show it; returns `true` if a location was added (so the sidebar reloads).
    pub fn run(mut self, owner: &dyn AsForm) -> bool {
        let _ = self.show_dialog(owner);
        self.saved
    }

    fn search_click(&mut self) {
        let q = self.query.trim().to_string();
        if q.is_empty() {
            return;
        }
        let lang = if self.fr { "fr" } else { "en" };
        match live::weather_geocode(&q, lang) {
            Ok(results) => {
                self.result_items = Rows::from(
                    results
                        .iter()
                        .enumerate()
                        .map(|(i, r)| {
                            let mut label = r.name.clone();
                            if let Some(a) = &r.admin1 {
                                if !a.is_empty() && a != &r.name {
                                    label.push_str(&format!(", {a}"));
                                }
                            }
                            if !r.country.is_empty() {
                                label.push_str(&format!(", {}", r.country));
                            }
                            Row::new().with("Value", BValue::Str(i.to_string())).with("Label", BValue::Str(label))
                        })
                        .collect::<Vec<_>>(),
                );
                self.result_value = if results.is_empty() { String::new() } else { "0".to_string() };
                self.results = results;
                self.status = if self.results.is_empty() {
                    if self.fr { "Aucun résultat.".into() } else { "No results.".into() }
                } else {
                    String::new()
                };
            }
            Err(e) => kubuno_desktop::tracing::error!("[calendar] geocode failed: {e}"),
        }
    }

    fn add_click(&mut self) {
        let idx: usize = self.result_value.parse().unwrap_or(usize::MAX);
        let Some(r) = self.results.get(idx) else {
            return;
        };
        match live::weather_add_location(&r.name, r.latitude, r.longitude, &r.timezone) {
            Ok(_) => {
                self.saved = true;
                self.set_dialog_result(DialogResult::Ok);
                self.close();
            }
            Err(e) => kubuno_desktop::tracing::error!("[calendar] add location failed: {e}"),
        }
    }

    fn cancel_click(&mut self) {
        self.set_dialog_result(DialogResult::Cancel);
        self.close();
    }
}
