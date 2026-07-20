<!--
  SPDX-FileCopyrightText: 2026 Kubuno contributors
  SPDX-License-Identifier: AGPL-3.0-or-later
-->

<div align="center">

# 📅 Kubuno Calendar

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](LICENSE)
![Rust](https://img.shields.io/badge/Rust-edition_2021-orange.svg)
![React](https://img.shields.io/badge/React-19-61dafb.svg)
![Module](https://img.shields.io/badge/Kubuno-module-4D38DB.svg)

**The Calendar app for [Kubuno](https://github.com/kubuno/core). Manage your events, sync over CalDAV, and organize your days — all self-hosted.**

</div>

---

## 💜 Why is this awesome?

- 🗓️ **Day / Week / Month / Year views** — each with its own URL (`/calendar/day`, `/calendar/week`…), navigable and shareable.
- ⏱️ **Drag & resize** — move an event or adjust its times directly with the mouse.
- 🔁 **Recurrence (RRULE)** — repeating events with scope selection (this event / this and following / all), plus a full custom-recurrence editor (every N days/weeks/months/years, weekday multi-select, monthly by date or nth weekday, end conditions) and humanized rule summaries.
- 📆 **Bookable appointment schedules** — publish your availability (durations, buffers, booking windows, per-day caps, custom form fields) and let anyone book a slot on a standalone public page; bookings land on your calendar automatically, with e-mail confirmations and reminders.
- 🫂 **Calendar sharing** — share a calendar with other users in view or edit mode, revoke at any time, and hand out a public read-only `.ics` feed link.
- 📡 **Subscriptions** — follow any remote iCalendar feed (`https://` or `webcal://` — published calendars, holidays…); the mirror calendar refreshes hourly and on demand.
- 🌐 **CalDAV** — sync with your devices (phone, Thunderbird…).
- 🤝 **Attendees & scheduling** — invite participants, find a common slot, collect RSVPs on a standalone public page, run meeting polls.
- ⏰ **Reminders** — browser and email notifications.
- 🧩 **Cross-app events** — copy an event as a rich card and paste it into other Kubuno apps (Chat, Notes…); other modules can also open the event picker as a service.
- 🔄 **Delta sync API** — cursor-based change feeds with tombstones (calendars, events, time blocks) for local-first clients.
- 🌦️ **Built-in weather** — per-location forecasts right inside the calendar: hourly strip, temperature/precipitation charts, wind compass, sunrise/sunset arc, air quality and a 7-day outlook.
- 🌖 **Moon phases** — optional principal-phase markers on the day/week/month views, computed entirely client-side.
- 🕑 **Secondary time zone** — show a second time column in the Day view.
- 🟣 **Dedicated theme** — module-specific purple accent.
- 🌍 **i18n** — 13 languages.

## 🏗️ Architecture

Calendar is a **Kubuno module**: a standalone Rust process (port `3102`) that registers with the [core](https://github.com/kubuno/core) at startup. The core proxies its routes (`/api/v1/calendar/*`) and serves its runtime-loaded frontend bundle.

```
core (kubuno/core)  ──proxy──►  kubuno-calendar (this repo, :3102)
       │                              ├─ Rust backend (Axum + PostgreSQL, schema `calendar`)
       └─ serves /modules/calendar/entry.js (React frontend, loaded at runtime)
```

- **Backend** — `src/`: Axum + SQLx (PostgreSQL, schema `calendar`); migrations in `migrations/`.
- **Frontend** — `frontend/`: a React bundle built to `entry.js`; consumes `@kubuno/sdk` and `@kubuno/ui` (provided by the host at runtime via the import map).

## 🐳 Install

This module ships in the **all-in-one [Kubuno](https://github.com/kubuno/core) Docker image** (`ghcr.io/kubuno/kubuno`) — the easiest way to self-host a full Kubuno instance (core + every module). See **[kubuno/docker](https://github.com/kubuno/docker)** for `docker compose` instructions.

Native packages are also built by CI for every tagged release and attached to the [GitHub Releases](https://github.com/kubuno/calendar/releases): **Debian/Ubuntu** (`.deb`), **Fedora/RHEL/openSUSE** (`.rpm`), **Windows** (NSIS installer) and **macOS** (`.pkg`). Each installs the module into an existing Kubuno core installation and restarts the service.

To build this module from source, see below.

## 🛠️ Build

**Requirements:** Rust ≥ 1.82, Node.js ≥ 24, PostgreSQL 16, and the [kubuno/core](https://github.com/kubuno/core) repo.

```bash
# Backend
cargo build --release            # → target/release/kubuno-calendar

# Frontend (module bundle)
cd frontend && npm ci && npm run build   # → dist/{entry.js, entry.css, chunks/}

# Debian package
bash build_deb.sh                # → dist/kubuno-calendar_*.deb

# Other platforms
bash build_rpm.sh                # → dist/kubuno-calendar-*.rpm   (needs rpmbuild)
bash build_windows.sh            # → dist/kubuno-calendar-setup-*.exe (NSIS; cross-compiles with cargo-xwin)
bash build_macos.sh              # → dist/kubuno-calendar-*.pkg   (run on macOS)
```

> Shared dependencies come from Kubuno — no `kubuno/core` checkout required:
> - **Rust** — `kubuno-seccomp` via a tagged git dependency on `kubuno/core` (fetched automatically by Cargo).
> - **Frontend** — `@kubuno/sdk`, `@kubuno/ui`, `@kubuno/drive` from npm (`@kubuno` scope), pulled in by `npm ci`. They are `external` at runtime (the host provides the singletons via its import map); the npm packages supply the build-time type surface.

## ⚙️ Configuration

Copy `config.toml.example` → `config.toml`, or use environment variables (`KUBUNO_CORE_URL`, `KUBUNO_INTERNAL_SECRET`, `KUBUNO_DB_*`). See `module.toml` for the manifest (id, port, routes, sidebar entry).

## 🤝 Contributing

Issues and pull requests are welcome. For any significant change, please open an issue first.

## 📄 License

[AGPL-3.0-or-later](LICENSE) © Kubuno contributors.
