use axum::{
    extract::{Request, State},
    middleware::Next,
    response::Response,
};
use uuid::Uuid;

use crate::{errors::CalendarError, state::AppState};

/// Utilisateur extrait des headers injectés par le core.
#[derive(Debug, Clone)]
pub struct CalendarUser {
    pub id:    Uuid,
    pub role:  String,
    pub email: String,
}

/// Clé d'extension Axum pour stocker l'utilisateur dans la requête.
pub type CalendarUserExt = axum::Extension<CalendarUser>;

/// Middleware : extrait X-Kubuno-User-Id, X-Kubuno-User-Role, X-Kubuno-User-Email.
/// Ces headers sont injectés par le proxy du core — on leur fait confiance.
/// This module's id, used as the token audience.
const MODULE_ID: &str = "calendar";

/// Authenticate the caller from the signed `X-Kubuno-Auth` token the core mints
/// with this module's internal secret (see `kubuno-modauth`), instead of
/// trusting the plain `X-Kubuno-User-*` headers — which any process reaching this
/// module's loopback port could otherwise forge to impersonate any user.
pub async fn require_auth(
    State(state): State<AppState>,
    mut req: Request,
    next: Next,
) -> std::result::Result<Response, CalendarError> {
    let token = req
        .headers()
        .get(kubuno_modauth::TOKEN_HEADER)
        .and_then(|v| v.to_str().ok())
        .ok_or(CalendarError::Unauthorized)?;

    let user = kubuno_modauth::verify(
        state.settings.core.internal_secret.as_bytes(),
        token,
        MODULE_ID,
    )
    .map_err(|_| CalendarError::Unauthorized)?;

    req.extensions_mut()
        .insert(CalendarUser { id: user.id, role: user.role, email: user.email });
    Ok(next.run(req).await)
}
