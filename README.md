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
- 🔁 **Recurrence (RRULE)** — repeating events, with scope selection (this event / this and following).
- 🌐 **CalDAV** — sync with your devices (phone, Thunderbird…).
- 🤝 **Attendees & scheduling** — invite participants, find a common slot.
- ⏰ **Reminders** — browser and email notifications.
- 🌦️ **Built-in weather** — per-location forecasts right inside the calendar.
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

## 🛠️ Build

**Requirements:** Rust ≥ 1.82, Node.js ≥ 20, PostgreSQL 16, and the [kubuno/core](https://github.com/kubuno/core) repo.

```bash
# Backend
cargo build --release            # → target/release/kubuno-calendar

# Frontend (module bundle)
cd frontend && npm ci && npm run build   # → dist/{entry.js, entry.css, chunks/}

# Debian package
bash build_deb.sh                # → dist/kubuno-calendar_*.deb
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
