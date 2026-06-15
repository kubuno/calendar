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

**L'application Calendrier de [Kubuno](https://github.com/kubuno/core). Gérez vos événements, synchronisez via CalDAV, et organisez vos journées — le tout chez vous.**

</div>

---

## 💜 Pourquoi c'est génial ?

- 🗓️ **Vues Jour / Semaine / Mois / Année** — chacune avec son URL (`/calendar/day`, `/calendar/week`…), navigables et partageables.
- ⏱️ **Glisser-déposer & redimensionnement** — déplacez un événement ou ajustez ses horaires directement à la souris.
- 🔁 **Récurrences (RRULE)** — événements répétés, avec choix de portée (cet événement / les suivants).
- 🌐 **CalDAV** — synchronisez avec vos appareils (téléphone, Thunderbird…).
- 🤝 **Invités & planification** — invitez des participants, trouvez un créneau commun.
- ⏰ **Rappels** — notifications navigateur et e-mail.
- 🌦️ **Météo intégrée** — prévisions par lieu directement dans l'agenda.
- 🕑 **Double fuseau horaire** — affichez un fuseau secondaire dans la vue Jour.
- 🟣 **Thème dédié** — accent violet propre au module.
- 🌍 **i18n** — 13 langues.

## 🏗️ Architecture

Calendar est un **module Kubuno** : un processus Rust autonome (port `3102`) qui s'enregistre auprès du [core](https://github.com/kubuno/core) au démarrage. Le core proxifie ses routes (`/api/v1/calendar/*`) et sert son bundle frontend chargé à l'exécution.

```
core (kubuno/core)  ──proxy──►  kubuno-calendar (ce dépôt, :3102)
       │                              ├─ backend Rust (Axum + PostgreSQL, schéma `calendar`)
       └─ sert /modules/calendar/entry.js (frontend React, chargé au runtime)
```

- **Backend** : `src/` — Axum + SQLx (PostgreSQL, schéma `calendar`), migrations dans `migrations/`.
- **Frontend** : `frontend/` — bundle React buildé en `entry.js` ; consomme `@kubuno/sdk` et `@kubuno/ui` (fournis par le host au runtime via l'import map).

## 🛠️ Build

**Prérequis** : Rust ≥ 1.82, Node.js ≥ 20, PostgreSQL 16, et le dépôt [kubuno/core](https://github.com/kubuno/core).

```bash
# Backend
cargo build --release            # → target/release/kubuno-calendar

# Frontend (bundle du module)
cd frontend && npm ci && npm run build   # → dist/{entry.js, entry.css, chunks/}

# Paquet Debian
bash build_deb.sh                # → kubuno-calendar_*.deb
```

> Les dépendances partagées proviennent de Kubuno :
> - **Rust** : `kubuno-seccomp` via dépendance git taguée sur `kubuno/core`.
> - **Frontend** : `@kubuno/sdk`, `@kubuno/ui`, `@kubuno/drive` depuis npm (scope `@kubuno`).

## ⚙️ Configuration

Copier `config.toml.example` → `config.toml`, ou via variables d'environnement (`KUBUNO_CORE_URL`, `KUBUNO_INTERNAL_SECRET`, `KUBUNO_DB_*`). Voir `module.toml` pour le manifeste (id, port, routes, entrée sidebar).

## 🤝 Contribuer

Issues et pull requests bienvenues. Pour un changement important, ouvrez d'abord une issue.

## 📄 Licence

[AGPL-3.0-or-later](LICENSE) © Kubuno contributors.
