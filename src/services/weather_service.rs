use std::{
    collections::HashMap,
    sync::Mutex,
    time::{Duration, Instant},
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CurrentWeather {
    pub time:         String,
    pub weather_code: i32,
    pub temp:         f64,
    pub feels_like:   f64,
    pub is_day:       bool,
    pub humidity:     i32,
    pub precip:       f64,  // mm over the last hour
    pub wind_speed:   f64,
    pub wind_gust:    f64,
    pub wind_dir:     i32,
    pub pressure:     f64,  // hPa (surface)
    pub cloud_cover:  i32,  // %
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DailyWeather {
    pub date:              String,
    pub weather_code:      i32,
    pub temp_max:          f64,
    pub temp_min:          f64,
    pub feels_like_max:    f64,
    pub feels_like_min:    f64,
    pub precip_prob_max:   i32,
    pub precip_sum:        f64,  // mm
    pub uv_index_max:      f64,
    pub wind_max:          f64,
    pub wind_gust_max:     f64,
    pub wind_dir_dominant: i32,
    pub sunrise:           Option<String>,
    pub sunset:            Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HourlyPoint {
    pub time:         String,  // "YYYY-MM-DDTHH:MM"
    pub weather_code: i32,
    pub temp:         f64,
    pub feels_like:   f64,
    pub is_day:       bool,
    pub humidity:     i32,
    pub precip:       f64,  // mm
    pub precip_prob:  i32,
    pub wind_speed:   f64,
    pub wind_gust:    f64,
    pub wind_dir:     i32,
    pub uv_index:     f64,
    pub pressure:     f64,  // hPa
    pub visibility:   f64,  // meters
    pub cloud_cover:  i32,  // %
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AirQuality {
    pub european_aqi: Option<i32>,
    pub us_aqi:       Option<i32>,
    pub pm2_5:        Option<f64>,
    pub pm10:         Option<f64>,
    pub ozone:        Option<f64>,
    pub no2:          Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WeatherForecast {
    pub latitude:  f64,
    pub longitude: f64,
    pub timezone:  String,
    pub current:   Option<CurrentWeather>,
    pub air:       Option<AirQuality>,
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

impl Default for WeatherService {
    fn default() -> Self {
        Self::new()
    }
}

fn int_to_bool(v: Option<i32>) -> bool {
    v.map(|n| n != 0).unwrap_or(true)
}

impl WeatherService {
    pub fn new() -> Self {
        Self {
            client: reqwest::Client::builder()
                .timeout(Duration::from_secs(10))
                .build()
                .expect("weather HTTP client"),
            cache:     Mutex::new(HashMap::new()),
            cache_ttl: Duration::from_secs(900),
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

        // Forecast + air quality are fetched concurrently; air quality is
        // best-effort (a failure there must not break the whole forecast).
        let (resp, air) = tokio::join!(
            self.fetch_forecast(lat, lon, timezone),
            self.fetch_air_quality(lat, lon, timezone),
        );
        let resp = resp?;
        let air = air.unwrap_or(None);

        let current = resp.current.map(|c| CurrentWeather {
            time:         c.time,
            weather_code: c.weather_code.unwrap_or(0),
            temp:         c.temperature_2m.unwrap_or(0.0),
            feels_like:   c.apparent_temperature.unwrap_or(0.0),
            is_day:       int_to_bool(c.is_day),
            humidity:     c.relative_humidity_2m.unwrap_or(0),
            precip:       c.precipitation.unwrap_or(0.0),
            wind_speed:   c.wind_speed_10m.unwrap_or(0.0),
            wind_gust:    c.wind_gusts_10m.unwrap_or(0.0),
            wind_dir:     c.wind_direction_10m.unwrap_or(0),
            pressure:     c.surface_pressure.unwrap_or(0.0),
            cloud_cover:  c.cloud_cover.unwrap_or(0),
        });

        let days = resp
            .daily
            .time
            .into_iter()
            .enumerate()
            .map(|(i, date)| DailyWeather {
                date,
                weather_code:      resp.daily.weather_code.get(i).and_then(|v| *v).unwrap_or(0),
                temp_max:          resp.daily.temperature_2m_max.get(i).and_then(|v| *v).unwrap_or(0.0),
                temp_min:          resp.daily.temperature_2m_min.get(i).and_then(|v| *v).unwrap_or(0.0),
                feels_like_max:    resp.daily.apparent_temperature_max.get(i).and_then(|v| *v).unwrap_or(0.0),
                feels_like_min:    resp.daily.apparent_temperature_min.get(i).and_then(|v| *v).unwrap_or(0.0),
                precip_prob_max:   resp.daily.precipitation_probability_max.get(i).and_then(|v| *v).unwrap_or(0),
                precip_sum:        resp.daily.precipitation_sum.get(i).and_then(|v| *v).unwrap_or(0.0),
                uv_index_max:      resp.daily.uv_index_max.get(i).and_then(|v| *v).unwrap_or(0.0),
                wind_max:          resp.daily.wind_speed_10m_max.get(i).and_then(|v| *v).unwrap_or(0.0),
                wind_gust_max:     resp.daily.wind_gusts_10m_max.get(i).and_then(|v| *v).unwrap_or(0.0),
                wind_dir_dominant: resp.daily.wind_direction_10m_dominant.get(i).and_then(|v| *v).unwrap_or(0),
                sunrise:           resp.daily.sunrise.get(i).and_then(|v| v.clone()),
                sunset:            resp.daily.sunset.get(i).and_then(|v| v.clone()),
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
                is_day:       int_to_bool(resp.hourly.is_day.get(i).and_then(|v| *v)),
                humidity:     resp.hourly.relative_humidity_2m.get(i).and_then(|v| *v).unwrap_or(0),
                precip:       resp.hourly.precipitation.get(i).and_then(|v| *v).unwrap_or(0.0),
                precip_prob:  resp.hourly.precipitation_probability.get(i).and_then(|v| *v).unwrap_or(0),
                wind_speed:   resp.hourly.wind_speed_10m.get(i).and_then(|v| *v).unwrap_or(0.0),
                wind_gust:    resp.hourly.wind_gusts_10m.get(i).and_then(|v| *v).unwrap_or(0.0),
                wind_dir:     resp.hourly.wind_direction_10m.get(i).and_then(|v| *v).unwrap_or(0),
                uv_index:     resp.hourly.uv_index.get(i).and_then(|v| *v).unwrap_or(0.0),
                pressure:     resp.hourly.surface_pressure.get(i).and_then(|v| *v).unwrap_or(0.0),
                visibility:   resp.hourly.visibility.get(i).and_then(|v| *v).unwrap_or(0.0),
                cloud_cover:  resp.hourly.cloud_cover.get(i).and_then(|v| *v).unwrap_or(0),
            })
            .collect();

        let forecast = WeatherForecast {
            latitude:  lat,
            longitude: lon,
            timezone:  timezone.to_string(),
            current,
            air,
            days,
            hours,
        };

        let mut cache = self.cache.lock().unwrap();
        cache.insert(key, CacheEntry { fetched_at: Instant::now(), data: forecast.clone() });

        Ok(forecast)
    }

    async fn fetch_forecast(&self, lat: f64, lon: f64, timezone: &str) -> anyhow::Result<OpenMeteoForecastResp> {
        Ok(self
            .client
            .get("https://api.open-meteo.com/v1/forecast")
            .query(&[
                ("latitude",       lat.to_string()),
                ("longitude",      lon.to_string()),
                ("current", "weather_code,temperature_2m,apparent_temperature,is_day,relative_humidity_2m,precipitation,wind_speed_10m,wind_gusts_10m,wind_direction_10m,surface_pressure,cloud_cover".to_string()),
                ("daily",   "weather_code,temperature_2m_max,temperature_2m_min,apparent_temperature_max,apparent_temperature_min,precipitation_probability_max,precipitation_sum,uv_index_max,wind_speed_10m_max,wind_gusts_10m_max,wind_direction_10m_dominant,sunrise,sunset".to_string()),
                ("hourly",  "weather_code,temperature_2m,apparent_temperature,is_day,relative_humidity_2m,precipitation,precipitation_probability,wind_speed_10m,wind_gusts_10m,wind_direction_10m,uv_index,surface_pressure,visibility,cloud_cover".to_string()),
                ("timezone",       timezone.to_string()),
                ("forecast_days",  "16".to_string()),
                ("forecast_hours", "48".to_string()),
            ])
            .send()
            .await?
            .json()
            .await?)
    }

    /// Best-effort air quality (European + US AQI, particulates). Any failure
    /// yields `None` — the widget simply omits the air-quality panel.
    async fn fetch_air_quality(&self, lat: f64, lon: f64, timezone: &str) -> anyhow::Result<Option<AirQuality>> {
        let resp: AirQualityResp = self
            .client
            .get("https://air-quality-api.open-meteo.com/v1/air-quality")
            .query(&[
                ("latitude",  lat.to_string()),
                ("longitude", lon.to_string()),
                ("current",   "european_aqi,us_aqi,pm2_5,pm10,ozone,nitrogen_dioxide".to_string()),
                ("timezone",  timezone.to_string()),
            ])
            .send()
            .await?
            .json()
            .await?;

        Ok(resp.current.map(|c| AirQuality {
            european_aqi: c.european_aqi,
            us_aqi:       c.us_aqi,
            pm2_5:        c.pm2_5,
            pm10:         c.pm10,
            ozone:        c.ozone,
            no2:          c.nitrogen_dioxide,
        }))
    }

    pub async fn geocode(&self, query: &str, lang: Option<&str>) -> anyhow::Result<Vec<GeocodingResult>> {
        // Open-Meteo geocoding only localizes names for a subset of languages;
        // any other value falls back to English.
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
    current: Option<OpenMeteoCurrentData>,
    daily:   OpenMeteoDailyData,
    hourly:  OpenMeteoHourlyData,
}

#[derive(Deserialize)]
struct OpenMeteoCurrentData {
    time:                 String,
    weather_code:         Option<i32>,
    temperature_2m:       Option<f64>,
    apparent_temperature: Option<f64>,
    is_day:               Option<i32>,
    relative_humidity_2m: Option<i32>,
    precipitation:        Option<f64>,
    wind_speed_10m:       Option<f64>,
    wind_gusts_10m:       Option<f64>,
    wind_direction_10m:   Option<i32>,
    surface_pressure:     Option<f64>,
    cloud_cover:          Option<i32>,
}

#[derive(Deserialize)]
struct OpenMeteoDailyData {
    time:                          Vec<String>,
    weather_code:                  Vec<Option<i32>>,
    temperature_2m_max:            Vec<Option<f64>>,
    temperature_2m_min:            Vec<Option<f64>>,
    apparent_temperature_max:      Vec<Option<f64>>,
    apparent_temperature_min:      Vec<Option<f64>>,
    precipitation_probability_max: Vec<Option<i32>>,
    precipitation_sum:             Vec<Option<f64>>,
    uv_index_max:                  Vec<Option<f64>>,
    wind_speed_10m_max:            Vec<Option<f64>>,
    wind_gusts_10m_max:            Vec<Option<f64>>,
    wind_direction_10m_dominant:   Vec<Option<i32>>,
    sunrise:                       Vec<Option<String>>,
    sunset:                        Vec<Option<String>>,
}

#[derive(Deserialize)]
struct OpenMeteoHourlyData {
    time:                      Vec<String>,
    weather_code:              Vec<Option<i32>>,
    temperature_2m:            Vec<Option<f64>>,
    apparent_temperature:      Vec<Option<f64>>,
    is_day:                    Vec<Option<i32>>,
    relative_humidity_2m:      Vec<Option<i32>>,
    precipitation:             Vec<Option<f64>>,
    precipitation_probability: Vec<Option<i32>>,
    wind_speed_10m:            Vec<Option<f64>>,
    wind_gusts_10m:            Vec<Option<f64>>,
    wind_direction_10m:        Vec<Option<i32>>,
    uv_index:                  Vec<Option<f64>>,
    surface_pressure:          Vec<Option<f64>>,
    visibility:                Vec<Option<f64>>,
    cloud_cover:               Vec<Option<i32>>,
}

#[derive(Deserialize)]
struct AirQualityResp {
    current: Option<AirQualityCurrent>,
}

#[derive(Deserialize)]
struct AirQualityCurrent {
    european_aqi:      Option<i32>,
    us_aqi:            Option<i32>,
    pm2_5:             Option<f64>,
    pm10:              Option<f64>,
    ozone:             Option<f64>,
    nitrogen_dioxide:  Option<f64>,
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
