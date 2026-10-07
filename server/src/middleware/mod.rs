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

/// Guard of the `/internal/*` sub-router (event delivery from the core): the
/// core, and nothing else.
///
/// Unlike every other route of this module, an internal one is not reached
/// through the core's proxy and carries no signed `X-Kubuno-Auth` token. What
/// authenticates it is the shared secret the core handed this process at startup
/// (`KUBUNO_INTERNAL_SECRET`), presented verbatim in `X-Internal-Secret`.
///
/// An **empty** configured secret refuses everything: a module started outside
/// the supervisor would otherwise accept any request sending an empty header.
/// The comparison is constant-time.
pub async fn require_internal_secret(
    State(state): State<AppState>,
    req: Request,
    next: Next,
) -> std::result::Result<Response, CalendarError> {
    let expected = state.settings.core.internal_secret.as_str();
    if expected.is_empty() {
        tracing::error!(
            "calendar: core.internal_secret vide — route interne refusée. \
             Renseignez KUBUNO_INTERNAL_SECRET."
        );
        return Err(CalendarError::Unauthorized);
    }

    let provided = req
        .headers()
        .get("x-internal-secret")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");

    if !constant_time_eq(provided.as_bytes(), expected.as_bytes()) {
        return Err(CalendarError::Unauthorized);
    }
    Ok(next.run(req).await)
}

/// Byte comparison whose duration does not depend on where the first difference
/// is. The length check leaks the length, which is not a secret.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}
