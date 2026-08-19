use crate::{config::{InstanceConfig, Settings}, services::weather_service::WeatherService};
use reqwest::Client;
use sqlx::PgPool;
use std::sync::{Arc, RwLock};

#[derive(Clone)]
pub struct AppState {
    pub db:       PgPool,
    pub settings: Arc<Settings>,
    pub weather:  Arc<WeatherService>,
    /// Shared outbound client, also used to ask the core the questions only it
    /// can answer (is this address one of ours?).
    pub http:     Client,
    /// Admin-editable instance settings, refreshed in the background from the
    /// core so an edit takes effect without restarting the module.
    pub instance: Arc<RwLock<InstanceConfig>>,
}

impl AppState {
    /// Snapshot of the current instance settings. Takes the read lock briefly,
    /// so callers never hold it across `.await`. Falls back to the compiled
    /// defaults if the lock was poisoned by a panicking writer — a lost value
    /// must never take a guard down in an unpredictable direction.
    pub fn instance(&self) -> InstanceConfig {
        match self.instance.read() {
            Ok(guard) => guard.clone(),
            Err(_)    => InstanceConfig::default(),
        }
    }
}
