use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    Extension, Json,
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{errors::Result, middleware::CalendarUser, state::AppState};

// ── Model ─────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct WeatherLocation {
    pub id:         Uuid,
    pub user_id:    Uuid,
    pub name:       String,
    pub latitude:   f64,
    pub longitude:  f64,
    pub timezone:   String,
    pub is_default: bool,
    pub sort_order: i32,
    pub created_at: chrono::DateTime<chrono::Utc>,
}

// ── List locations ────────────────────────────────────────────────────────────

pub async fn list_locations(
    State(state): State<AppState>,
    Extension(user): Extension<CalendarUser>,
) -> Result<Json<serde_json::Value>> {
    let locations = sqlx::query_as::<_, WeatherLocation>(
        "SELECT id, user_id, name, latitude, longitude, timezone, is_default, sort_order, created_at
         FROM calendar.weather_locations
         WHERE user_id = $1
         ORDER BY sort_order, created_at",
    )
    .bind(user.id)
    .fetch_all(&state.db)
    .await?;

    Ok(Json(serde_json::json!({ "locations": locations })))
}

// ── Add location ──────────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct AddLocationDto {
    pub name:       String,
    pub latitude:   f64,
    pub longitude:  f64,
    pub timezone:   String,
    pub is_default: Option<bool>,
}

pub async fn add_location(
    State(state): State<AppState>,
    Extension(user): Extension<CalendarUser>,
    Json(dto): Json<AddLocationDto>,
) -> Result<(StatusCode, Json<serde_json::Value>)> {
    if dto.name.trim().is_empty() {
        return Err(crate::errors::CalendarError::Validation("Le nom est requis".into()));
    }

    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM calendar.weather_locations WHERE user_id = $1",
    )
    .bind(user.id)
    .fetch_one(&state.db)
    .await?;

    let is_default = dto.is_default.unwrap_or(count == 0);

    if is_default {
        sqlx::query("UPDATE calendar.weather_locations SET is_default = FALSE WHERE user_id = $1")
            .bind(user.id)
            .execute(&state.db)
            .await?;
    }

    let loc = sqlx::query_as::<_, WeatherLocation>(
        "INSERT INTO calendar.weather_locations
             (user_id, name, latitude, longitude, timezone, is_default, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, user_id, name, latitude, longitude, timezone, is_default, sort_order, created_at",
    )
    .bind(user.id)
    .bind(dto.name.trim())
    .bind(dto.latitude)
    .bind(dto.longitude)
    .bind(&dto.timezone)
    .bind(is_default)
    .bind(count as i32)
    .fetch_one(&state.db)
    .await?;

    Ok((StatusCode::CREATED, Json(serde_json::json!({ "location": loc }))))
}

// ── Update location ───────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct UpdateLocationDto {
    pub name:       Option<String>,
    pub is_default: Option<bool>,
    pub sort_order: Option<i32>,
}

pub async fn update_location(
    State(state): State<AppState>,
    Extension(user): Extension<CalendarUser>,
    Path(id): Path<Uuid>,
    Json(dto): Json<UpdateLocationDto>,
) -> Result<Json<serde_json::Value>> {
    if dto.is_default == Some(true) {
        sqlx::query("UPDATE calendar.weather_locations SET is_default = FALSE WHERE user_id = $1")
            .bind(user.id)
            .execute(&state.db)
            .await?;
    }

    let loc = sqlx::query_as::<_, WeatherLocation>(
        "UPDATE calendar.weather_locations
         SET name       = COALESCE($1, name),
             is_default = COALESCE($2, is_default),
             sort_order = COALESCE($3, sort_order)
         WHERE id = $4 AND user_id = $5
         RETURNING id, user_id, name, latitude, longitude, timezone, is_default, sort_order, created_at",
    )
    .bind(dto.name.as_deref().map(str::trim))
    .bind(dto.is_default)
    .bind(dto.sort_order)
    .bind(id)
    .bind(user.id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| crate::errors::CalendarError::NotFound("Lieu météo introuvable".into()))?;

    Ok(Json(serde_json::json!({ "location": loc })))
}

// ── Delete location ───────────────────────────────────────────────────────────

pub async fn delete_location(
    State(state): State<AppState>,
    Extension(user): Extension<CalendarUser>,
    Path(id): Path<Uuid>,
) -> Result<StatusCode> {
    let result = sqlx::query(
        "DELETE FROM calendar.weather_locations WHERE id = $1 AND user_id = $2",
    )
    .bind(id)
    .bind(user.id)
    .execute(&state.db)
    .await?;

    if result.rows_affected() == 0 {
        return Err(crate::errors::CalendarError::NotFound("Lieu météo introuvable".into()));
    }
    Ok(StatusCode::NO_CONTENT)
}

// ── Forecast (proxied from Open-Meteo, cached server-side) ────────────────────

#[derive(Deserialize)]
pub struct ForecastQuery {
    pub lat: f64,
    pub lon: f64,
    pub tz:  String,
}

pub async fn get_forecast(
    State(state): State<AppState>,
    Extension(_user): Extension<CalendarUser>,
    Query(q): Query<ForecastQuery>,
) -> Result<Json<serde_json::Value>> {
    let forecast = state
        .weather
        .forecast(q.lat, q.lon, &q.tz)
        .await
        .map_err(|e| crate::errors::CalendarError::Internal(e))?;

    Ok(Json(serde_json::json!({ "forecast": forecast })))
}

// ── Geocoding ─────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct GeocodeQuery {
    pub q: String,
    /// Langue d'affichage des noms de villes (langue UI de l'utilisateur).
    #[serde(default)]
    pub lang: Option<String>,
}

pub async fn geocode(
    State(state): State<AppState>,
    Extension(_user): Extension<CalendarUser>,
    Query(q): Query<GeocodeQuery>,
) -> Result<Json<serde_json::Value>> {
    if q.q.trim().is_empty() {
        return Ok(Json(serde_json::json!({ "results": [] })));
    }
    let results = state
        .weather
        .geocode(&q.q, q.lang.as_deref())
        .await
        .map_err(|e| crate::errors::CalendarError::Internal(e))?;

    Ok(Json(serde_json::json!({ "results": results })))
}
