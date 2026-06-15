use std::{
    collections::HashMap,
    sync::Mutex,
    time::{Duration, Instant},
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DailyWeather {
    pub date:            String,
    pub weather_code:    i32,
    pub temp_max:        f64,
    pub temp_min:        f64,
    pub precip_prob_max: i32,
    pub uv_index_max:    f64,
    pub sunrise:         Option<String>,
    pub sunset:          Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HourlyPoint {
    pub time:         String,  // "YYYY-MM-DDTHH:MM"
    pub weather_code: i32,
    pub temp:         f64,
    pub feels_like:   f64,
    pub humidity:     i32,
    pub precip_prob:  i32,
    pub wind_speed:   f64,
    pub wind_dir:     i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WeatherForecast {
    pub latitude:  f64,
    pub longitude: f64,
    pub timezone:  String,
    pub days:      Vec<DailyWeather>,
    // 48 hourly points (today 00:00 → tomorrow 23:00, local time)
    pub hours:     Vec<HourlyPoint>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GeocodingResult {
    pub name:      String,
    pub latitude:  f64,
    pub longitude: f64,
    pub timezone:  String,
    pub country:   String,
    pub admin1:    Option<String>,
}

#[derive(Hash, Eq, PartialEq, Clone)]
struct CacheKey {
    lat: i64,
    lon: i64,
}

struct CacheEntry {
    fetched_at: Instant,
    data:       WeatherForecast,
}

pub struct WeatherService {
    client:    reqwest::Client,
    cache:     Mutex<HashMap<CacheKey, CacheEntry>>,
    cache_ttl: Duration,
}

impl WeatherService {
    pub fn new() -> Self {
        Self {
            client: reqwest::Client::builder()
                .timeout(Duration::from_secs(10))
                .build()
                .expect("weather HTTP client"),
            cache:     Mutex::new(HashMap::new()),
            cache_ttl: Duration::from_secs(3600),
        }
    }

    pub async fn forecast(&self, lat: f64, lon: f64, timezone: &str) -> anyhow::Result<WeatherForecast> {
        let key = CacheKey { lat: (lat * 100.0) as i64, lon: (lon * 100.0) as i64 };

        {
            let cache = self.cache.lock().unwrap();
            if let Some(entry) = cache.get(&key) {
                if entry.fetched_at.elapsed() < self.cache_ttl {
                    return Ok(entry.data.clone());
                }
            }
        }

        let resp: OpenMeteoForecastResp = self
            .client
            .get("https://api.open-meteo.com/v1/forecast")
            .query(&[
                ("latitude",       lat.to_string()),
                ("longitude",      lon.to_string()),
                ("daily",  "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,uv_index_max,sunrise,sunset".to_string()),
                ("hourly", "weather_code,temperature_2m,apparent_temperature,relative_humidity_2m,precipitation_probability,wind_speed_10m,wind_direction_10m".to_string()),
                ("timezone",       timezone.to_string()),
                ("forecast_days",  "16".to_string()),
                ("forecast_hours", "48".to_string()),
            ])
            .send()
            .await?
            .json()
            .await?;

        let days = resp
            .daily
            .time
            .into_iter()
            .enumerate()
            .map(|(i, date)| DailyWeather {
                date,
                weather_code:    resp.daily.weather_code.get(i).and_then(|v| *v).unwrap_or(0),
                temp_max:        resp.daily.temperature_2m_max.get(i).and_then(|v| *v).unwrap_or(0.0),
                temp_min:        resp.daily.temperature_2m_min.get(i).and_then(|v| *v).unwrap_or(0.0),
                precip_prob_max: resp.daily.precipitation_probability_max.get(i).and_then(|v| *v).unwrap_or(0),
                uv_index_max:    resp.daily.uv_index_max.get(i).and_then(|v| *v).unwrap_or(0.0),
                sunrise:         resp.daily.sunrise.get(i).and_then(|v| v.clone()),
                sunset:          resp.daily.sunset.get(i).and_then(|v| v.clone()),
            })
            .collect();

        let hours = resp
            .hourly
            .time
            .iter()
            .enumerate()
            .take(48)
            .map(|(i, time)| HourlyPoint {
                time:         time.clone(),
                weather_code: resp.hourly.weather_code.get(i).and_then(|v| *v).unwrap_or(0),
                temp:         resp.hourly.temperature_2m.get(i).and_then(|v| *v).unwrap_or(0.0),
                feels_like:   resp.hourly.apparent_temperature.get(i).and_then(|v| *v).unwrap_or(0.0),
                humidity:     resp.hourly.relative_humidity_2m.get(i).and_then(|v| *v).unwrap_or(0),
                precip_prob:  resp.hourly.precipitation_probability.get(i).and_then(|v| *v).unwrap_or(0),
                wind_speed:   resp.hourly.wind_speed_10m.get(i).and_then(|v| *v).unwrap_or(0.0),
                wind_dir:     resp.hourly.wind_direction_10m.get(i).and_then(|v| *v).unwrap_or(0),
            })
            .collect();

        let forecast = WeatherForecast {
            latitude:  lat,
            longitude: lon,
            timezone:  timezone.to_string(),
            days,
            hours,
        };

        let mut cache = self.cache.lock().unwrap();
        cache.insert(key, CacheEntry { fetched_at: Instant::now(), data: forecast.clone() });

        Ok(forecast)
    }

    pub async fn geocode(&self, query: &str, lang: Option<&str>) -> anyhow::Result<Vec<GeocodingResult>> {
        // Open-Meteo geocoding ne localise les noms que pour un sous-ensemble de langues ;
        // toute autre valeur retombe sur l'anglais.
        let language = match lang.unwrap_or("en").split('-').next().unwrap_or("en") {
            l @ ("en" | "de" | "fr" | "es" | "it" | "pt" | "ru" | "tr" | "hi") => l,
            _ => "en",
        };
        let resp: GeocodingApiResp = self
            .client
            .get("https://geocoding-api.open-meteo.com/v1/search")
            .query(&[
                ("name",     query),
                ("count",    "8"),
                ("language", language),
                ("format",   "json"),
            ])
            .send()
            .await?
            .json()
            .await?;

        Ok(resp.results.unwrap_or_default().into_iter().map(|r| GeocodingResult {
            name:      r.name,
            latitude:  r.latitude,
            longitude: r.longitude,
            timezone:  r.timezone,
            country:   r.country.unwrap_or_default(),
            admin1:    r.admin1,
        }).collect())
    }
}

// ── Open-Meteo response types ─────────────────────────────────────────────────

#[derive(Deserialize)]
struct OpenMeteoForecastResp {
    daily:  OpenMeteoDailyData,
    hourly: OpenMeteoHourlyData,
}

#[derive(Deserialize)]
struct OpenMeteoDailyData {
    time:                          Vec<String>,
    weather_code:                  Vec<Option<i32>>,
    temperature_2m_max:            Vec<Option<f64>>,
    temperature_2m_min:            Vec<Option<f64>>,
    precipitation_probability_max: Vec<Option<i32>>,
    uv_index_max:                  Vec<Option<f64>>,
    sunrise:                       Vec<Option<String>>,
    sunset:                        Vec<Option<String>>,
}

#[derive(Deserialize)]
struct OpenMeteoHourlyData {
    time:                      Vec<String>,
    weather_code:              Vec<Option<i32>>,
    temperature_2m:            Vec<Option<f64>>,
    apparent_temperature:      Vec<Option<f64>>,
    relative_humidity_2m:      Vec<Option<i32>>,
    precipitation_probability: Vec<Option<i32>>,
    wind_speed_10m:            Vec<Option<f64>>,
    wind_direction_10m:        Vec<Option<i32>>,
}

#[derive(Deserialize)]
struct GeocodingApiResp {
    results: Option<Vec<GeocodingApiResult>>,
}

#[derive(Deserialize)]
struct GeocodingApiResult {
    name:      String,
    latitude:  f64,
    longitude: f64,
    timezone:  String,
    country:   Option<String>,
    admin1:    Option<String>,
}
