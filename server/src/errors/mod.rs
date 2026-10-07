use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;

#[derive(Debug, thiserror::Error)]
pub enum CalendarError {
    #[error("Non authentifié")]
    Unauthorized,

    #[error("Accès refusé")]
    Forbidden,

    #[error("Ressource introuvable: {0}")]
    NotFound(String),

    #[error("Données invalides: {0}")]
    Validation(String),

    #[error("Conflit: {0}")]
    Conflict(String),

    #[error("RRULE invalide: {0}")]
    InvalidRRule(String),

    #[error("Erreur base de données")]
    Database(#[from] sqlx::Error),

    #[error("Erreur interne")]
    Internal(#[from] anyhow::Error),
}

impl IntoResponse for CalendarError {
    fn into_response(self) -> Response {
        let (status, code, msg) = match &self {
            CalendarError::Unauthorized    => (StatusCode::UNAUTHORIZED,           "UNAUTHORIZED",    self.to_string()),
            CalendarError::Forbidden       => (StatusCode::FORBIDDEN,              "FORBIDDEN",       self.to_string()),
            CalendarError::NotFound(_)     => (StatusCode::NOT_FOUND,              "NOT_FOUND",       self.to_string()),
            CalendarError::Validation(_)   => (StatusCode::UNPROCESSABLE_ENTITY,   "VALIDATION",      self.to_string()),
            CalendarError::Conflict(_)     => (StatusCode::CONFLICT,               "CONFLICT",        self.to_string()),
            CalendarError::InvalidRRule(_) => (StatusCode::UNPROCESSABLE_ENTITY,   "INVALID_RRULE",   self.to_string()),
            CalendarError::Database(e) => {
                tracing::error!(error = %e, "Database error");
                (StatusCode::INTERNAL_SERVER_ERROR, "DATABASE_ERROR", "Erreur base de données".to_string())
            }
            CalendarError::Internal(e) => {
                tracing::error!(error = %e, "Internal error");
                (StatusCode::INTERNAL_SERVER_ERROR, "INTERNAL_ERROR", "Erreur interne".to_string())
            }
        };
        (status, Json(json!({ "error": code, "message": msg }))).into_response()
    }
}

pub type Result<T> = std::result::Result<T, CalendarError>;
