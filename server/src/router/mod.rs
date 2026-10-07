use axum::{
    middleware,
    routing::{delete, get, patch, post},
    Router,
};
use tower_http::{cors::CorsLayer, trace::TraceLayer};

use crate::{
    handlers::{
        analytics, appointments, attendees, caldav, calendars, delta, events, health, import_export, rooms,
        internal_events, mcp, policy, public, scheduling, time_blocks, weather,
    },
    middleware::{require_auth, require_internal_secret},
    state::AppState,
};

pub fn build(state: AppState) -> Router {
    // Authenticated routes
    let authed = Router::new()
        // Calendriers
        // Sync deltas (local-first) — before the :id catch-alls.
        .route("/calendars/delta",  get(delta::calendars_delta))
        .route("/events/delta",     get(delta::events_delta))
        .route("/time-blocks/delta", get(delta::time_blocks_delta))
        .route("/instance-policy",          get(policy::instance_policy))
        .route("/calendars",                get(calendars::list).post(calendars::create))
        .route("/calendars/subscribe",      post(calendars::subscribe))
        .route("/calendars/:id",            get(calendars::get).patch(calendars::update).delete(calendars::delete))
        .route("/calendars/:id/share",      post(calendars::share))
        .route("/calendars/:id/share/:uid", delete(calendars::unshare))
        .route("/calendars/:id/shares",     get(calendars::list_shares))
        .route("/calendars/:id/export",     get(calendars::export))
        .route("/calendars/:id/refresh",    post(calendars::refresh))
        // MCP tools (called by the core gateway on behalf of the user)
        .route("/mcp/list-events",          get(mcp::list_events))
        .route("/mcp/create-event",         post(mcp::create_event))
        .route("/mcp/delete-event",         post(mcp::delete_event))
        // Events
        .route("/events",                   get(events::list).post(events::create))
        .route("/events/:id",               get(events::get).patch(events::update).delete(events::delete))
        .route("/events/:id/ics",           get(events::export_ics))
        // Participants
        .route("/events/:id/attendees",          get(attendees::list).post(attendees::invite))
        .route("/events/:id/attendees/:aid",     patch(attendees::update_rsvp).delete(attendees::remove))
        // Salles. Chemin distinct des participants : une salle n'a pas d'adresse,
        // ne compte pas dans le plafond d'invités, n'est jamais extérieure — et
        // elle RÉPOND (elle refuse un créneau déjà pris) au lieu de faire échouer
        // la requête (cf. handlers::rooms).
        .route("/rooms",                         get(rooms::list))
        .route("/rooms/availability",            get(rooms::availability))
        .route("/events/:id/rooms",              post(rooms::invite))
        .route("/events/:id/rooms/:rid",         delete(rooms::remove))
        // Import
        .route("/import",                   post(import_export::import_ics))
        // Blocs de temps
        .route("/time-blocks",              get(time_blocks::list).post(time_blocks::create))
        .route("/time-blocks/:id",          patch(time_blocks::update).delete(time_blocks::delete))
        // Availability
        .route("/availability",             post(scheduling::find_common_slots))
        .route("/availability/me",          get(scheduling::my_availability))
        // Sondages
        .route("/polls",                    get(scheduling::list_polls).post(scheduling::create_poll))
        .route("/polls/:id",                get(scheduling::get_poll).patch(scheduling::update_poll).delete(scheduling::delete_poll))
        .route("/polls/:id/respond",        post(scheduling::respond_poll))

        // Bookable appointment schedules
        .route("/appointment-schedules",              get(appointments::list).post(appointments::create))
        .route("/appointment-schedules/:id",          get(appointments::get).patch(appointments::update).delete(appointments::delete))
        .route("/appointment-schedules/:id/bookings", get(appointments::bookings))
        // Analytics
        .route("/analytics/workload",       get(analytics::workload))
        .route("/analytics/distribution",   get(analytics::distribution))
        .route("/analytics/trends",         get(analytics::trends))
        // Weather
        .route("/weather/locations",         get(weather::list_locations).post(weather::add_location))
        .route("/weather/locations/:id",     patch(weather::update_location).delete(weather::delete_location))
        .route("/weather/forecast",          get(weather::get_forecast))
        .route("/weather/geocode",           get(weather::geocode))
        .layer(middleware::from_fn_with_state(state.clone(), require_auth))
        .with_state(state.clone());

    // Routes publiques (sans auth)
    let public_routes = Router::new()
        .route("/public/rsvp/:token",                    get(public::rsvp_info).post(public::rsvp_respond))
        .route("/public/rsvp/:token/page",               get(public::rsvp_page))
        .route("/public/polls/:token",                   get(public::poll_info))
        .route("/public/polls/:token/respond",           post(public::poll_respond))
        .route("/public/calendars/:token/feed.ics",      get(public::calendar_feed))
        .route("/public/appointments/:token",            get(appointments::public_info))
        .route("/public/appointments/:token/slots",      get(appointments::public_slots))
        .route("/public/appointments/:token/book",       post(appointments::public_book))
        .route("/public/appointments/:token/page",       get(appointments::public_page))
        .route("/public/appointments/:token/app.js",     get(appointments::public_page_js))
        .with_state(state.clone());

    // Internal routes (core → module event delivery). Reached directly by the
    // core, not through its proxy, so guarded by the shared internal secret and
    // never by the per-user token. The core POSTs to `/ipc/events` (its
    // convention) with `X-Internal-Secret`. The documented `/events` fallback is
    // deliberately not registered here: it would collide with the authenticated
    // `POST /events` CRUD route, and the core only falls back to it on a 404 from
    // `/ipc/events`, which this router never returns.
    let internal = Router::new()
        .route("/ipc/events", post(internal_events::handle_event))
        .route("/ipc/room-stats", get(rooms::stats))
        .layer(middleware::from_fn_with_state(state.clone(), require_internal_secret))
        .with_state(state.clone());

    // Health check
    let system = Router::new()
        .route("/health", get(health::health))
        .with_state(state.clone());

    // CalDAV
    let caldav_routes = caldav::caldav_router().with_state(state);

    Router::new()
        .merge(system)
        .merge(internal)
        .merge(public_routes)
        .nest("/", authed)
        .merge(caldav_routes)
        .layer(CorsLayer::permissive())
        .layer(TraceLayer::new_for_http())
}
