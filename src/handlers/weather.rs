use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    Extension, Json,
};
use kubuno_db::params;
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
    let locations = state
        .db
        .fetch_all_as::<WeatherLocation>(
            "SELECT id, user_id, name, latitude, longitude, timezone, is_default, sort_order, created_at
             FROM calendar.weather_locations
             WHERE user_id = $1
             ORDER BY sort_order, created_at",
            params![user.id],
        )
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

    let count_expr = state.db.backend().count_bigint("*");
    let count: i64 = state
        .db
        .fetch_scalar(
            &format!("SELECT {count_expr} FROM calendar.weather_locations WHERE user_id = $1"),
            params![user.id],
        )
        .await?;

    let is_default = dto.is_default.unwrap_or(count == 0);

    if is_default {
        state
            .db
            .execute(
                "UPDATE calendar.weather_locations SET is_default = FALSE WHERE user_id = $1",
                params![user.id],
            )
            .await?;
    }

    // RETURNING is not portable: mint the id, insert, then re-select it.
    let id = kubuno_db::new_id();
    state
        .db
        .execute(
            "INSERT INTO calendar.weather_locations
                 (id, user_id, name, latitude, longitude, timezone, is_default, sort_order)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
            params![
                id, user.id, dto.name.trim(), dto.latitude, dto.longitude, dto.timezone,
                is_default, count as i32
            ],
        )
        .await?;
    let loc = state
        .db
        .fetch_one_as::<WeatherLocation>(
            "SELECT id, user_id, name, latitude, longitude, timezone, is_default, sort_order, created_at
             FROM calendar.weather_locations WHERE id = $1",
            params![id],
        )
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
        state
            .db
            .execute(
                "UPDATE calendar.weather_locations SET is_default = FALSE WHERE user_id = $1",
                params![user.id],
            )
            .await?;
    }

    // Guarded update (id + user_id) with COALESCE, then re-select the row — the
    // portable stand-in for `UPDATE … RETURNING`. An absent row re-selects to
    // None, which is the NotFound the guard used to express.
    let name = dto.name.as_deref().map(str::trim).map(str::to_owned);
    state
        .db
        .execute(
            "UPDATE calendar.weather_locations
             SET name       = COALESCE($1, name),
                 is_default = COALESCE($2, is_default),
                 sort_order = COALESCE($3, sort_order)
             WHERE id = $4 AND user_id = $5",
            params![name, dto.is_default, dto.sort_order, id, user.id],
        )
        .await?;
    let loc = state
        .db
        .fetch_optional_as::<WeatherLocation>(
            "SELECT id, user_id, name, latitude, longitude, timezone, is_default, sort_order, created_at
             FROM calendar.weather_locations WHERE id = $1 AND user_id = $2",
            params![id, user.id],
        )
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
    let affected = state
        .db
        .execute(
            "DELETE FROM calendar.weather_locations WHERE id = $1 AND user_id = $2",
            params![id, user.id],
        )
        .await?;

    if affected == 0 {
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
        .map_err(crate::errors::CalendarError::Internal)?;

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
        .map_err(crate::errors::CalendarError::Internal)?;

    Ok(Json(serde_json::json!({ "results": results })))
}
