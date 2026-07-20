use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    Extension, Json,
};
use uuid::Uuid;

use crate::{
    errors::Result,
    middleware::CalendarUser,
    models::appointment::{BookDto, SaveScheduleDto, SlotsQuery},
    services::appointment_service::AppointmentService,
    state::AppState,
};

// ── Owner (authenticated) ───────────────────────────────────────────────────

pub async fn list(
    State(state): State<AppState>,
    Extension(user): Extension<CalendarUser>,
) -> Result<Json<serde_json::Value>> {
    let schedules = AppointmentService::list(user.id, &state.db).await?;
    Ok(Json(serde_json::json!({ "schedules": schedules })))
}

pub async fn create(
    State(state): State<AppState>,
    Extension(user): Extension<CalendarUser>,
    Json(dto): Json<SaveScheduleDto>,
) -> Result<(StatusCode, Json<serde_json::Value>)> {
    use validator::Validate;
    dto.validate().map_err(|e| crate::errors::CalendarError::Validation(e.to_string()))?;
    let schedule = AppointmentService::save(user.id, None, dto, &state.db).await?;
    Ok((StatusCode::CREATED, Json(serde_json::json!({ "schedule": schedule }))))
}

pub async fn get(
    State(state): State<AppState>,
    Extension(user): Extension<CalendarUser>,
    Path(id): Path<Uuid>,
) -> Result<Json<serde_json::Value>> {
    let schedule = AppointmentService::get_with_rules(id, user.id, &state.db).await?;
    Ok(Json(serde_json::json!({ "schedule": schedule })))
}

pub async fn update(
    State(state): State<AppState>,
    Extension(user): Extension<CalendarUser>,
    Path(id): Path<Uuid>,
    Json(dto): Json<SaveScheduleDto>,
) -> Result<Json<serde_json::Value>> {
    use validator::Validate;
    dto.validate().map_err(|e| crate::errors::CalendarError::Validation(e.to_string()))?;
    let schedule = AppointmentService::save(user.id, Some(id), dto, &state.db).await?;
    Ok(Json(serde_json::json!({ "schedule": schedule })))
}

pub async fn delete(
    State(state): State<AppState>,
    Extension(user): Extension<CalendarUser>,
    Path(id): Path<Uuid>,
) -> Result<StatusCode> {
    AppointmentService::delete(id, user.id, &state.db).await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn bookings(
    State(state): State<AppState>,
    Extension(user): Extension<CalendarUser>,
    Path(id): Path<Uuid>,
) -> Result<Json<serde_json::Value>> {
    let bookings = AppointmentService::list_bookings(id, user.id, &state.db).await?;
    Ok(Json(serde_json::json!({ "bookings": bookings })))
}

// ── Public (no auth) ────────────────────────────────────────────────────────

pub async fn public_info(
    State(state): State<AppState>,
    Path(token): Path<String>,
) -> Result<Json<serde_json::Value>> {
    let schedule = AppointmentService::get_by_token(&token, &state.db).await?;
    Ok(Json(serde_json::json!({ "schedule": AppointmentService::to_public(&schedule) })))
}

pub async fn public_slots(
    State(state): State<AppState>,
    Path(token): Path<String>,
    Query(q): Query<SlotsQuery>,
) -> Result<Json<serde_json::Value>> {
    let schedule = AppointmentService::get_by_token(&token, &state.db).await?;
    let rules = AppointmentService::load_rules(schedule.id, &state.db).await?;
    let slots = AppointmentService::compute_slots(&schedule, &rules, q.from, q.until, &state.db).await?;
    Ok(Json(serde_json::json!({ "slots": slots })))
}

pub async fn public_book(
    State(state): State<AppState>,
    Path(token): Path<String>,
    Json(dto): Json<BookDto>,
) -> Result<(StatusCode, Json<serde_json::Value>)> {
    use validator::Validate;
    dto.validate().map_err(|e| crate::errors::CalendarError::Validation(e.to_string()))?;
    let booking = AppointmentService::book(&token, dto, &state.db).await?;
    Ok((StatusCode::CREATED, Json(serde_json::json!({ "booking": booking }))))
}

/// Standalone booking page (self-contained HTML, no shell / auth). The invitee
/// opens the shared link, picks a free slot and fills the form.
///
/// The behaviour lives in an EXTERNAL same-origin script (`app.js`): the core's
/// Content-Security-Policy blocks inline scripts, but allows `script-src 'self'`.
/// The token is handed to it via a `data-token` attribute on `<body>`.
pub async fn public_page(
    State(state): State<AppState>,
    Path(token): Path<String>,
) -> Result<axum::response::Html<String>> {
    let schedule = AppointmentService::get_by_token(&token, &state.db).await?;
    let esc = |s: &str| s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;");
    let title = esc(if schedule.title.is_empty() { "Prendre rendez-vous" } else { &schedule.title });
    let host = esc(schedule.host_name.as_deref().unwrap_or(""));
    // Description is plain text from the editor: escape it and keep line breaks.
    let desc = esc(schedule.description.as_deref().unwrap_or("")).replace('\n', "<br>");
    let token_attr = esc(&token);
    let duration = schedule.duration_minutes;

    let html = format!(
        r#"<!DOCTYPE html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<style>
  :root {{ --accent: #4d38db; }}
  body {{ font-family: system-ui, -apple-system, sans-serif; background: #f3f4f6; margin: 0; color: #111827; }}
  .wrap {{ max-width: 760px; margin: 0 auto; padding: 24px 16px 60px; }}
  .card {{ background: #fff; border-radius: 16px; box-shadow: 0 8px 30px rgba(0,0,0,.06); padding: 28px; }}
  h1 {{ font-size: 22px; margin: 0 0 4px; }}
  .host {{ color: #6b7280; font-size: 14px; margin: 0 0 8px; }}
  .dur {{ color: #6b7280; font-size: 13px; }}
  .desc {{ margin: 14px 0; color: #374151; font-size: 14px; }}
  .day {{ font-weight: 600; margin: 20px 0 8px; font-size: 14px; text-transform: capitalize; }}
  .slots {{ display: grid; grid-template-columns: repeat(auto-fill, minmax(96px,1fr)); gap: 8px; }}
  .slot {{ padding: 10px 0; border: 1px solid #d1d5db; border-radius: 10px; background: #fff; cursor: pointer; font-size: 14px; text-align: center; }}
  .slot:hover {{ border-color: var(--accent); }}
  .slot.sel {{ background: var(--accent); color: #fff; border-color: var(--accent); }}
  form {{ margin-top: 20px; display: none; }}
  form.show {{ display: block; }}
  label {{ display: block; font-size: 13px; color: #374151; margin: 10px 0 4px; }}
  input {{ width: 100%; box-sizing: border-box; padding: 10px; border: 1px solid #d1d5db; border-radius: 10px; font-size: 14px; }}
  .submit {{ margin-top: 16px; padding: 11px 18px; background: var(--accent); color: #fff; border: 0; border-radius: 10px; font-size: 15px; cursor: pointer; }}
  #msg {{ margin-top: 14px; font-size: 14px; }}
  .ok {{ color: #059669; }} .err {{ color: #dc2626; }}
  .empty {{ color: #6b7280; font-size: 14px; padding: 20px 0; }}
</style></head><body data-token="{token_attr}">
<div class="wrap"><div class="card">
  <h1>{title}</h1>
  {host_line}
  <p class="dur">⏱ {duration} minutes</p>
  <div class="desc">{desc}</div>
  <div id="slots"><p class="empty">Chargement des disponibilités…</p></div>
  <form id="form">
    <div id="picked" class="dur"></div>
    <label>Prénom *</label><input id="first_name" required>
    <label>Nom</label><input id="last_name">
    <label>Adresse e-mail *</label><input id="email" type="email" required>
    <button class="submit" type="submit">Confirmer la réservation</button>
    <p id="msg"></p>
  </form>
</div></div>
<script src="/api/v1/calendar/public/appointments/{token_attr}/app.js" defer></script>
</body></html>"#,
        title = title,
        host_line = if host.is_empty() { String::new() } else { format!(r#"<p class="host">avec {host}</p>"#) },
        duration = duration,
        desc = desc,
        token_attr = token_attr,
    );
    Ok(axum::response::Html(html))
}

/// The booking page's behaviour, served as an external same-origin script so it
/// passes the core CSP (`script-src 'self'`). Static — the token comes from the
/// page's `<body data-token>`.
pub async fn public_page_js() -> impl axum::response::IntoResponse {
    const JS: &str = r#"
const token = document.body.dataset.token;
const base = "/api/v1/calendar/public/appointments/" + token;
let selected = null;
const fmtDay = d => d.toLocaleDateString('fr-FR', { weekday:'long', day:'numeric', month:'long' });
const fmtTime = d => d.toLocaleTimeString('fr-FR', { hour:'2-digit', minute:'2-digit' });
async function load() {
  const from = new Date();
  const until = new Date(Date.now() + 60*24*3600*1000);
  const r = await fetch(base + "/slots?from=" + from.toISOString() + "&until=" + until.toISOString());
  const data = await r.json();
  const slots = (data.slots || []).map(s => ({ ...s, d: new Date(s.starts_at) }));
  const box = document.getElementById('slots');
  if (!slots.length) { box.innerHTML = '<p class="empty">Aucune disponibilité pour le moment.</p>'; return; }
  const byDay = {};
  for (const s of slots) { const k = s.d.toDateString(); (byDay[k] = byDay[k] || []).push(s); }
  box.innerHTML = '';
  for (const k of Object.keys(byDay)) {
    const h = document.createElement('div'); h.className = 'day'; h.textContent = fmtDay(byDay[k][0].d); box.appendChild(h);
    const grid = document.createElement('div'); grid.className = 'slots';
    for (const s of byDay[k]) {
      const b = document.createElement('div'); b.className = 'slot'; b.textContent = fmtTime(s.d);
      b.onclick = () => {
        document.querySelectorAll('.slot').forEach(x => x.classList.remove('sel'));
        b.classList.add('sel'); selected = s.starts_at;
        document.getElementById('form').classList.add('show');
        document.getElementById('picked').textContent = fmtDay(s.d) + ' à ' + fmtTime(s.d);
      };
      grid.appendChild(b);
    }
    box.appendChild(grid);
  }
}
document.getElementById('form').onsubmit = async e => {
  e.preventDefault();
  if (!selected) return;
  const msg = document.getElementById('msg'); msg.textContent = '';
  const r = await fetch(base + "/book", {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({
      starts_at: selected,
      first_name: document.getElementById('first_name').value,
      last_name: document.getElementById('last_name').value,
      email: document.getElementById('email').value
    })
  });
  if (r.ok) { document.querySelector('.card').innerHTML = '<h1>Réservation confirmée ✓</h1><p class="desc">Vous recevrez une confirmation par e-mail.</p>'; }
  else { const d = await r.json().catch(()=>({})); msg.className = 'err'; msg.textContent = (d.message || 'Ce créneau n\'est plus disponible.'); load(); }
};
load();
"#;
    ([(axum::http::header::CONTENT_TYPE, "application/javascript; charset=utf-8")], JS)
}
