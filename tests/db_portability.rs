//! Runs the calendar module's own migrations and its own services against a real
//! server of **each** engine, from a single compiled binary — the proof that the
//! engine is a run-time choice, not a build-time one, and that the recently
//! ported primitives (the delta journal, the JSON array columns, and the
//! TIME/DATE columns) behave identically on all of them.
//!
//! * SQLite always runs (a temp file, no server).
//! * PostgreSQL runs when `KUBUNO_PG_TEST_URL` points at a throwaway database
//!   (which must have `CREATE EXTENSION "uuid-ossp"`, used by the frozen 000001).
//! * MySQL/MariaDB runs when `KUBUNO_MYSQL_TEST_URL` does.
//!
//! ```sh
//! KUBUNO_PG_TEST_URL=postgres://u:p@127.0.0.1:5433/calendar \
//! KUBUNO_MYSQL_TEST_URL=mysql://u:p@127.0.0.1:3307/calendar \
//!   SQLX_OFFLINE=true cargo test --test db_portability
//! ```

use chrono::{Duration, NaiveTime, Utc};
use kubuno_calendar::config::InstanceConfig;
use kubuno_calendar::models::calendar::CreateCalendarDto;
use kubuno_calendar::models::event::{CreateEventDto, Event, RecurrenceScope, UpdateEventDto};
use kubuno_calendar::models::time_block::CreateTimeBlockDto;
use kubuno_calendar::services::{
    calendar_service::CalendarService, event_service::EventService,
    time_block_service::TimeBlockService,
};
use kubuno_calendar::{sync, SCHEMA};
use kubuno_db::params;
use uuid::Uuid;

fn base_settings(engine: &str) -> kubuno_db::DbSettings {
    kubuno_db::DbSettings {
        engine: engine.to_string(),
        url: None,
        host: None,
        port: None,
        user: None,
        password: None,
        database: None,
        path: None,
        max_connections: 4,
        min_connections: 0,
        connect_timeout: std::time::Duration::from_secs(10),
        run_migrations: true,
        schema_prefix: None,
    }
}

/// Migrations run one at a time: the PostgreSQL and MySQL suites may share a server.
static EXCLUSIVE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

async fn migrated_pool(settings: kubuno_db::DbSettings) -> (kubuno_db::DbPool, impl Sized) {
    let guard = EXCLUSIVE.lock().await;
    let pool = kubuno_db::connect(&settings, SCHEMA).await.expect("connect");

    kubuno_db::migrations!(
        "./migrations/postgres",
        "./migrations/mysql",
        "./migrations/sqlite",
    )
    .run(&pool, SCHEMA)
    .await
    .expect("migrations");

    kubuno_db::events::ensure_outbox(&pool, SCHEMA).await.expect("outbox");

    (pool, guard)
}

fn mk_event(calendar_id: Uuid, title: &str) -> CreateEventDto {
    let now = Utc::now();
    CreateEventDto {
        id: None,
        calendar_id,
        title: title.to_string(),
        description: None,
        location: None,
        url: None,
        starts_at: now,
        ends_at: now + Duration::hours(1),
        all_day: Some(false),
        timezone: Some("UTC".into()),
        color: None,
        rrule: None,
        reminders: None,
        status: None,
        visibility: None,
        busy: None,
        attendees: None,
        guests_can_modify: None,
        guests_can_invite: None,
        guests_can_see_guests: None,
    }
}

/// The greatest event-domain change_seq an owner can see (0 if none). Reads
/// through the very primitive the port introduced: `changes_since`.
async fn max_event_seq(pool: &kubuno_db::DbPool, owner: Uuid) -> i64 {
    let changes = kubuno_db::journal::changes_since(
        pool, sync::EVENTS_TABLE, sync::EVENT_TOMBSTONES, owner, 0, 10_000,
    )
    .await
    .expect("events delta");
    changes.iter().map(|c| c.change_seq).max().unwrap_or(0)
}

async fn max_calendar_seq(pool: &kubuno_db::DbPool, owner: Uuid) -> i64 {
    let changes = kubuno_db::journal::changes_since(
        pool, sync::CALENDARS_TABLE, sync::CALENDAR_TOMBSTONES, owner, 0, 10_000,
    )
    .await
    .expect("calendars delta");
    changes.iter().map(|c| c.change_seq).max().unwrap_or(0)
}

async fn max_time_block_seq(pool: &kubuno_db::DbPool, owner: Uuid) -> i64 {
    let changes = kubuno_db::journal::changes_since(
        pool, sync::TIME_BLOCKS_TABLE, sync::TIME_BLOCK_TOMBSTONES, owner, 0, 10_000,
    )
    .await
    .expect("time_blocks delta");
    changes.iter().map(|c| c.change_seq).max().unwrap_or(0)
}

async fn full_suite(pool: &kubuno_db::DbPool) {
    let user = Uuid::new_v4();
    let instance = InstanceConfig::default();

    // The very first calendar an account creates becomes its (undeletable)
    // default. Make that one here so the working calendar below is an ordinary
    // calendar the cascade-delete assertion at the end can actually remove.
    let _default = CalendarService::create(
        user,
        CreateCalendarDto {
            id: None,
            name: "Défaut".into(),
            description: None,
            color: None,
            cal_type: None,
            timezone: Some("UTC".into()),
            is_public: None,
        },
        &instance,
        pool,
    )
    .await
    .expect("create default calendar");

    // ── create the working calendar; its creation gives it a change_seq ──
    let cal = CalendarService::create(
        user,
        CreateCalendarDto {
            id: None,
            name: "Perso".into(),
            description: None,
            color: None,
            cal_type: None,
            timezone: Some("UTC".into()),
            is_public: None,
        },
        &instance,
        pool,
    )
    .await
    .expect("create calendar");
    assert_eq!(cal.name, "Perso");
    let cal_seq_0 = max_calendar_seq(pool, user).await;
    assert!(cal_seq_0 > 0, "the calendar carries a change_seq after creation");

    // ── create / list events + prove strict change_seq monotonicity ──
    let mut seqs: Vec<i64> = Vec::new();
    seqs.push(max_event_seq(pool, user).await); // 0, no events yet

    let a = EventService::create(user, mk_event(cal.id, "Alpha"), pool)
        .await
        .expect("create A");
    seqs.push(max_event_seq(pool, user).await);

    let b = EventService::create(user, mk_event(cal.id, "Beta"), pool)
        .await
        .expect("create B");
    seqs.push(max_event_seq(pool, user).await);

    // update A → its change_seq advances past B's create.
    let upd = UpdateEventDto {
        calendar_id: None,
        title: Some("Alpha (edited)".into()),
        description: None,
        location: None,
        url: None,
        starts_at: None,
        ends_at: None,
        all_day: None,
        timezone: None,
        color: None,
        clear_color: false,
        rrule: None,
        clear_rrule: false,
        reminders: None,
        status: None,
        visibility: None,
        busy: None,
        guests_can_modify: None,
        guests_can_invite: None,
        guests_can_see_guests: None,
    };
    let a_upd = EventService::update(a.id, user, upd, RecurrenceScope::All, None, pool)
        .await
        .expect("update A");
    assert_eq!(a_upd.title, "Alpha (edited)");
    seqs.push(max_event_seq(pool, user).await);

    // touch parent: writing an attendee bumps its event's change_seq (the
    // portable replacement for the old att_bump_event trigger).
    {
        let mut tx = pool.begin().await.expect("begin");
        tx.execute(
            "INSERT INTO calendar.attendees (id, event_id, email, status) VALUES ($1, $2, $3, 'accepted')",
            params![kubuno_db::new_id(), a.id, "guest@example.com"],
        )
        .await
        .expect("insert attendee");
        sync::touch_event(&mut tx, a.id).await.expect("touch event");
        tx.commit().await.expect("commit");
    }
    seqs.push(max_event_seq(pool, user).await);

    // delete B → an event tombstone with a fresh (greater) change_seq.
    EventService::delete(b.id, user, RecurrenceScope::All, None, pool)
        .await
        .expect("delete B");
    seqs.push(max_event_seq(pool, user).await);

    // EVERY step advanced the sequence: strict monotonicity of next_seq.
    for w in seqs.windows(2) {
        assert!(w[1] > w[0], "change_seq must strictly increase: {seqs:?}");
    }

    // The deletion surfaces as a tombstone; A is still a live modified row.
    let changes = kubuno_db::journal::changes_since(
        pool, sync::EVENTS_TABLE, sync::EVENT_TOMBSTONES, user, 0, 10_000,
    )
    .await
    .expect("delta");
    assert!(
        changes.iter().any(|c| c.id == b.id && c.deleted),
        "deleted event B must appear as a tombstone"
    );
    assert!(
        changes.iter().any(|c| c.id == a.id && !c.deleted),
        "live event A must appear as a modified row"
    );

    // ── the exdates JSON array column round-trips ──
    let ex1 = Utc::now();
    let ex2 = ex1 + Duration::days(7);
    pool.execute(
        "UPDATE calendar.events SET exdates = $1 WHERE id = $2",
        params![serde_json::json!([ex1, ex2]), a.id],
    )
    .await
    .expect("write exdates");
    let reread = pool
        .fetch_one_as::<Event>("SELECT * FROM calendar.events WHERE id = $1", params![a.id])
        .await
        .expect("reread event");
    assert_eq!(reread.exdates, vec![ex1, ex2], "exdates array round-trips on {:?}", pool.backend());

    // ── a time_block: the TIME columns round-trip (HH:MM:SS on every engine) ──
    let start = NaiveTime::from_hms_opt(9, 0, 0).unwrap();
    let end = NaiveTime::from_hms_opt(17, 30, 0).unwrap();
    let tb_seq_0 = max_time_block_seq(pool, user).await;
    let tb = TimeBlockService::create(
        user,
        CreateTimeBlockDto {
            id: None,
            label: "Bureau".into(),
            color: None,
            days: vec![0, 1, 2, 3, 4],
            start_time: start,
            end_time: end,
            priority: None,
        },
        pool,
    )
    .await
    .expect("create time_block");
    assert_eq!(tb.start_time, start, "TIME round-trip (start) on {:?}", pool.backend());
    assert_eq!(tb.end_time, end, "TIME round-trip (end) on {:?}", pool.backend());
    assert_eq!(tb.days, vec![0, 1, 2, 3, 4], "days JSON array round-trips");
    let tb_seq_1 = max_time_block_seq(pool, user).await;
    assert!(tb_seq_1 > tb_seq_0, "the time_block carries a fresh change_seq");

    TimeBlockService::delete(tb.id, user, pool).await.expect("delete time_block");
    let tb_changes = kubuno_db::journal::changes_since(
        pool, sync::TIME_BLOCKS_TABLE, sync::TIME_BLOCK_TOMBSTONES, user, 0, 10_000,
    )
    .await
    .expect("tb delta");
    assert!(
        tb_changes.iter().any(|c| c.id == tb.id && c.deleted),
        "deleted time_block must appear as a tombstone"
    );

    // ── delete the calendar: its events get tombstones, the calendar too ──
    CalendarService::delete(cal.id, user, pool).await.expect("delete calendar");
    let cal_changes = kubuno_db::journal::changes_since(
        pool, sync::CALENDARS_TABLE, sync::CALENDAR_TOMBSTONES, user, 0, 10_000,
    )
    .await
    .expect("calendar delta");
    assert!(
        cal_changes.iter().any(|c| c.id == cal.id && c.deleted),
        "deleted calendar must appear as a tombstone"
    );
    let ev_changes = kubuno_db::journal::changes_since(
        pool, sync::EVENTS_TABLE, sync::EVENT_TOMBSTONES, user, 0, 10_000,
    )
    .await
    .expect("event delta");
    assert!(
        ev_changes.iter().any(|c| c.id == a.id && c.deleted),
        "the calendar's cascade must tombstone its surviving event A"
    );
}

#[tokio::test]
async fn sqlite_from_the_one_binary() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut s = base_settings("sqlite");
    s.path = Some(dir.path().to_string_lossy().into_owned());
    let (pool, _keep) = migrated_pool(s).await;
    full_suite(&pool).await;
}

#[tokio::test]
async fn postgres_from_the_one_binary() {
    let Ok(url) = std::env::var("KUBUNO_PG_TEST_URL") else {
        eprintln!("skipping: KUBUNO_PG_TEST_URL not set");
        return;
    };
    let mut s = base_settings("postgres");
    s.url = Some(url);
    let (pool, _keep) = migrated_pool(s).await;
    full_suite(&pool).await;
}

#[tokio::test]
async fn mysql_from_the_one_binary() {
    let Ok(url) = std::env::var("KUBUNO_MYSQL_TEST_URL") else {
        eprintln!("skipping: KUBUNO_MYSQL_TEST_URL not set");
        return;
    };
    let mut s = base_settings("mysql");
    s.url = Some(url);
    let (pool, _keep) = migrated_pool(s).await;
    full_suite(&pool).await;
}
