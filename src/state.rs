use crate::{config::Settings, services::weather_service::WeatherService};
use sqlx::PgPool;
use std::sync::Arc;

#[derive(Clone)]
pub struct AppState {
    pub db:       PgPool,
    pub settings: Arc<Settings>,
    pub weather:  Arc<WeatherService>,
}
