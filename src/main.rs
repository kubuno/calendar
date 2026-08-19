use anyhow::{Context, Result};
use clap::Parser;
use kubuno_calendar::{
    config::Settings,
    router,
    services::{reminder_service::ReminderService, weather_service::WeatherService},
    state::AppState,
};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::postgres::PgPoolOptions;
use std::sync::{Arc, RwLock};
use std::time::Duration;

// ── Lecture de module.toml ─────────────────────────────────────────────────────

#[derive(Deserialize)]
struct Manifest {
    module:        ManifestModule,
    #[serde(default)]
    sidebar_items: Vec<SidebarItemRaw>,
    events:        Option<ManifestEvents>,
    /// Declarative settings manifest pushed to the core at registration.
    #[serde(default)]
    settings:      Vec<SettingDefRaw>,
    /// Pages the admin panel is split into (`[[setting_groups]]`). Each becomes
    /// an entry of the admin menu with its own address; a setting's `category`
    /// becomes a tab inside its group.
    #[serde(default)]
    setting_groups: Vec<SettingGroupRaw>,
}

/// One `[[setting_groups]]` entry of module.toml, forwarded verbatim. `id` is a
/// STABLE, UNTRANSLATED slug: it travels in the URL of the admin page.
#[derive(Deserialize, Serialize)]
struct SettingGroupRaw {
    id:          String,
    label:       String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    icon:        Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    position:    Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    description: Option<String>,
}

/// One `[[settings]]` entry from module.toml. Serialized verbatim into the
/// registration payload (`type` is renamed to match the core's `SettingDef`).
#[derive(Deserialize, Serialize)]
struct SettingDefRaw {
    key:         String,
    scope:       String,
    #[serde(rename = "type")]
    value_type:  String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    values:      Option<Vec<Value>>,
    default:     Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    label:       Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    category:    Option<String>,
    /// Id of a `[[setting_groups]]` entry: which admin page this belongs to.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    group:       Option<String>,
    #[serde(default)]
    public:      bool,
    // ── Presentation metadata, forwarded untouched (an older core ignores it) ──
    #[serde(default)]
    advanced:    bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    risk:        Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    min:         Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    max:         Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    unit:        Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    placeholder: Option<String>,
    #[serde(default)]
    multiline:   bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    depends_on:  Option<String>,
}

#[derive(Deserialize)]
struct ManifestModule {
    #[allow(dead_code)]
    id:            String,
    display_name:  String,
    description:   Option<String>,
    settings_path: Option<String>,
}

#[derive(Deserialize)]
struct SidebarItemRaw {
    id:       String,
    label:    String,
    icon:     String,
    path:     String,
    position: i32,
}

#[derive(Deserialize)]
struct ManifestEvents {
    #[serde(default)]
    subscribed: Vec<String>,
}

fn load_manifest() -> Option<Manifest> {
    let path = if let Ok(dir) = std::env::var("KUBUNO_MODULE_DIR") {
        std::path::PathBuf::from(dir).join("module.toml")
    } else {
        std::env::current_exe().ok()?.parent()?.join("module.toml")
    };

    let content = std::fs::read_to_string(&path)
        .map_err(|e| tracing::warn!(path = %path.display(), error = %e, "module.toml introuvable"))
        .ok()?;

    toml::from_str::<Manifest>(&content)
        .map_err(|e| tracing::error!(path = %path.display(), error = %e, "module.toml invalide"))
        .ok()
}

// ── CLI ───────────────────────────────────────────────────────────────────────

#[derive(Parser, Debug)]
#[command(name = "kubuno-calendar", version, about = "Module calendar Kubuno")]
struct Cli {
    #[arg(short, long, env = "KC_CONFIG_FILE")]
    config: Option<String>,
}

// ── Entry point ───────────────────────────────────────────────────────────────

#[tokio::main]
async fn main() -> Result<()> {
    let _ = dotenvy::dotenv();
    let _cli = Cli::parse();

    let settings = Settings::load().context("Chargement de la configuration")?;

    let log_level = settings.logging.level.clone();
    let subscriber = tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new(&log_level)),
        );

    match settings.logging.format {
        kubuno_calendar::config::LogFormat::Json   => subscriber.json().init(),
        kubuno_calendar::config::LogFormat::Pretty => subscriber.init(),
    }

    tracing::info!("Kubuno Calendar v{} démarrage…", env!("CARGO_PKG_VERSION"));

    // Security: forbid any process execution on the host (see kubuno-seccomp).
    kubuno_seccomp::lock_down_process_execution("calendar");

    // Pool PostgreSQL
    let opts = settings.database.connect_options()?;
    let pool = PgPoolOptions::new()
        .max_connections(settings.database.max_connections)
        .min_connections(settings.database.min_connections)
        .acquire_timeout(settings.database.connect_timeout)
        .connect_with(opts)
        .await
        .context("Connexion PostgreSQL")?;

    // Migrations
    if settings.database.run_migrations {
        sqlx::query("CREATE SCHEMA IF NOT EXISTS calendar")
            .execute(&pool)
            .await
            .context("Création du schéma calendar")?;

        let migration_opts = settings.database.connect_options()?
            .options([("search_path", "calendar,public")]);
        let migration_pool = PgPoolOptions::new()
            .max_connections(1)
            .acquire_timeout(settings.database.connect_timeout)
            .connect_with(migration_opts)
            .await
            .context("Pool de migration")?;

        sqlx::migrate!("./migrations")
            .run(&migration_pool)
            .await
            .context("Migrations")?;
    }

    let http = Client::new();

    // Initial read of the admin-editable instance settings; fall back to the
    // compiled defaults if the core is not reachable yet (the refresher below
    // picks them up as soon as it is).
    let instance = kubuno_calendar::config::fetch_instance(
        &http, &settings.core.url, &settings.core.internal_secret,
    )
    .await
    .unwrap_or_default();
    let instance = Arc::new(RwLock::new(instance));

    let state = AppState {
        db:       pool,
        settings: Arc::new(settings.clone()),
        weather:  Arc::new(WeatherService::new()),
        http:     http.clone(),
        instance: instance.clone(),
    };

    // Refresh the instance settings from the core every 60s so an admin edit
    // takes effect without a restart. A failed read keeps the last known values.
    {
        let http_r     = http.clone();
        let core_url   = settings.core.url.clone();
        let secret     = settings.core.internal_secret.clone();
        let instance_r = instance.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(60)).await;
                if let Some(fresh) =
                    kubuno_calendar::config::fetch_instance(&http_r, &core_url, &secret).await
                {
                    if let Ok(mut guard) = instance_r.write() {
                        *guard = fresh;
                    }
                }
            }
        });
    }

    // Registration with the core (with infinite retry)
    register_with_core(&http, &settings).await;

    // Heartbeat every 30s
    {
        let http2     = http.clone();
        let settings2 = settings.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(30)).await;
                let url    = format!("{}/internal/modules/calendar/heartbeat", settings2.core.url);
                let secret = &settings2.core.internal_secret;
                match http2.post(&url).header("X-Internal-Secret", secret.as_str()).send().await {
                    Ok(r) if r.status().is_success() => {}
                    Ok(r) if r.status() == reqwest::StatusCode::NOT_FOUND => {
                        tracing::info!("Heartbeat 404 — ré-enregistrement…");
                        register_with_core(&http2, &settings2).await;
                    }
                    Ok(r) if r.status() == reqwest::StatusCode::FORBIDDEN => {
                        tracing::info!("Heartbeat 403 — module désactivé, attente…");
                    }
                    Ok(r)  => tracing::warn!(status = %r.status(), "Heartbeat réponse inattendue"),
                    Err(e) => tracing::warn!(error = %e, "Heartbeat erreur réseau"),
                }
            }
        });
    }

    // Worker de rappels
    {
        let state2 = Arc::new(state.clone());
        tokio::spawn(async move {
            ReminderService::run_worker(state2).await;
        });
    }

    // Retention cleaner: purges events finished long ago when the administrator
    // set a retention. Idle (and silent) while the setting is left at "never".
    {
        let state2 = state.clone();
        tokio::spawn(async move {
            use kubuno_calendar::services::retention_service::RetentionService;
            RetentionService::run_worker(state2).await;
        });
    }

    // Periodic sync of remote iCalendar subscriptions (hourly)
    {
        let state2 = state.clone();
        tokio::spawn(async move {
            use kubuno_calendar::services::subscription_service::SubscriptionService;
            // First pass 2 min after startup (lets the DB/network settle)
            tokio::time::sleep(Duration::from_secs(120)).await;
            loop {
                // Closing subscriptions must also stop the outbound traffic of
                // the ones already created, otherwise the switch only stops new
                // ones and the instance keeps fetching remote hosts.
                if state2.instance().allow_calendar_subscriptions {
                    SubscriptionService::sync_all(&state2.db).await;
                }
                tokio::time::sleep(Duration::from_secs(3600)).await;
            }
        });
    }

    // Serveur HTTP
    let addr = format!("{}:{}", settings.server.host, settings.server.port);
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .with_context(|| format!("Bind sur {addr}"))?;

    tracing::info!("Kubuno Calendar démarré sur http://{addr}");

    let app = router::build(state);
    axum::serve(listener, app.into_make_service_with_connect_info::<std::net::SocketAddr>())
        .await
        .context("Erreur du serveur HTTP")?;

    Ok(())
}

fn backoff(attempt: u32) -> u64 {
    if attempt <= 10 { (attempt * 2) as u64 } else { 30 }
}

async fn register_with_core(http: &Client, settings: &Settings) {
    let base_url = format!("http://{}:{}", settings.server.host, settings.server.port);
    let core_url = &settings.core.url;
    let secret   = &settings.core.internal_secret;

    let manifest = load_manifest();
    let display_name  = manifest.as_ref().map(|m| m.module.display_name.as_str()).unwrap_or("Calendar").to_string();
    let description   = manifest.as_ref().and_then(|m| m.module.description.clone());
    let settings_path = manifest.as_ref().and_then(|m| m.module.settings_path.clone());
    let sidebar_items: Vec<Value> = manifest.as_ref()
        .map(|m| m.sidebar_items.iter().map(|s| json!({
            "id":       s.id,
            "label":    s.label,
            "icon":     s.icon,
            "path":     s.path,
            "position": s.position,
        })).collect())
        .unwrap_or_else(|| vec![
            json!({ "id": "calendar", "label": "Calendar", "icon": "Calendar", "path": "/calendar", "position": 20 }),
        ]);
    let subscribed_events: Vec<String> = manifest.as_ref()
        .and_then(|m| m.events.as_ref())
        .map(|e| e.subscribed.clone())
        .unwrap_or_else(|| vec!["UserDeleted".into(), "ContactUpdated".into()]);
    let settings_schema: Value = manifest.as_ref()
        .map(|m| serde_json::to_value(&m.settings).unwrap_or_else(|_| json!([])))
        .unwrap_or_else(|| json!([]));
    // Admin-panel pages. An older core ignores the field and keeps a single page.
    let setting_groups: Value = manifest.as_ref()
        .map(|m| serde_json::to_value(&m.setting_groups).unwrap_or_else(|_| json!([])))
        .unwrap_or_else(|| json!([]));

    // MCP tools exposed to the assistant through the core gateway. The names
    // use underscores (some LLMs reject dots). The
    // `annotations` distinguishes backend tools (executed server-side) from
    // UI tools (`kubuno_ui`: dispatched into the user's client).
    let mcp_tools = json!([
        {
            "name": "calendar_list_events",
            "description": "Liste les événements de l'agenda de l'utilisateur sur une période. Sans dates, renvoie les 30 prochains jours.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "from":  { "type": "string", "format": "date-time", "description": "Début de la période (ISO 8601)." },
                    "until": { "type": "string", "format": "date-time", "description": "Fin de la période (ISO 8601)." }
                }
            },
            "route": "/mcp/list-events", "method": "GET"
        },
        {
            "name": "calendar_create_event",
            "description": "Crée un événement dans l'agenda par défaut de l'utilisateur.",
            "input_schema": {
                "type": "object",
                "required": ["title", "starts_at", "ends_at"],
                "properties": {
                    "title":       { "type": "string", "description": "Titre de l'événement." },
                    "starts_at":   { "type": "string", "format": "date-time", "description": "Début (ISO 8601)." },
                    "ends_at":     { "type": "string", "format": "date-time", "description": "Fin (ISO 8601), doit être ≥ au début." },
                    "all_day":     { "type": "boolean", "description": "Journée entière." },
                    "description": { "type": "string" },
                    "location":    { "type": "string" }
                }
            },
            "route": "/mcp/create-event", "method": "POST"
        },
        {
            "name": "calendar_delete_event",
            "description": "Supprime un événement de l'agenda par son identifiant.",
            "input_schema": {
                "type": "object",
                "required": ["event_id"],
                "properties": {
                    "event_id": { "type": "string", "description": "Identifiant (UUID) de l'événement à supprimer." }
                }
            },
            "route": "/mcp/delete-event", "method": "POST",
            "annotations": { "confirm": true, "destructiveHint": true }
        },
        {
            "name": "calendar_open_date",
            "description": "Ouvre l'agenda de l'utilisateur sur une date donnée (action d'interface, n'effectue aucune modification).",
            "input_schema": {
                "type": "object",
                "required": ["date"],
                "properties": {
                    "date": { "type": "string", "format": "date", "description": "Date à afficher (AAAA-MM-JJ)." }
                }
            },
            "route": "/mcp/noop", "method": "POST",
            "annotations": { "kubuno_ui": { "service": "calendar", "method": "openDate" } }
        }
    ]);

    let payload = json!({
        "module_id":         "calendar",
        "display_name":      display_name,
        "description":       description,
        "settings_path":     settings_path,
        "base_url":          base_url,
        "version":           env!("CARGO_PKG_VERSION"),
        "routes":            [{ "method": "*", "path": "/*" }],
        "sidebar_items":     sidebar_items,
        "subscribed_events": subscribed_events,
        "mcp_tools":         mcp_tools,
        "settings_schema":   settings_schema,
        "setting_groups":    setting_groups,
    });

    for attempt in 1u32.. {
        let url = format!("{core_url}/internal/modules/register");
        match http.post(&url)
            .header("X-Internal-Secret", secret.as_str())
            .json(&payload)
            .send()
            .await
        {
            Ok(resp) if resp.status().is_success() => {
                tracing::info!("Module calendar enregistré auprès du core");
                return;
            }
            Ok(resp) if resp.status() == reqwest::StatusCode::FORBIDDEN => {
                tracing::info!(attempt, "Module désactivé par l'admin, nouvel essai dans 30s…");
                tokio::time::sleep(Duration::from_secs(30)).await;
                continue;
            }
            Ok(resp) => {
                let wait = backoff(attempt);
                tracing::warn!(attempt, status = %resp.status(), "Enregistrement échoué, retry dans {wait}s…");
                tokio::time::sleep(Duration::from_secs(wait)).await;
            }
            Err(e) => {
                let wait = backoff(attempt);
                tracing::warn!(attempt, error = %e, "Core inaccessible, retry dans {wait}s…");
                tokio::time::sleep(Duration::from_secs(wait)).await;
            }
        }
    }
    unreachable!()
}
