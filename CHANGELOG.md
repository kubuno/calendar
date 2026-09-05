# Changelog

All notable changes to **kubuno-calendar** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this
project adheres to [Semantic Versioning](https://semver.org/). Entries are added under
`[Unreleased]` **as the change is made**; `_tools/release.sh` stamps them under the version
number at release time, and CI publishes that section as the GitHub Release notes.

## [Unreleased]

### Added

- **Meeting invitations are now e-mailed to your guests.** When you create an
  event with guests — and you can now add them right from the creation dialog,
  no longer only after saving — Kubuno asks the Mail module to send each guest a
  proper invitation carrying an iCalendar (`.ics`) attachment. Updating the
  meeting re-sends it, and cancelling (deleting) the meeting sends a
  cancellation. When a guest accepts, declines or answers "maybe" from their
  mail client, their response is reflected back on the event automatically.

- **You now see the meetings you were invited to in your own calendar**, even
  when the organizer never shared their calendar with you — an invitation is its
  own reason to show the event.

- **New administrator setting "Send invitations by e-mail" (on by default).**
  Turn it off and guests are still recorded on the event, but no mail leaves the
  instance.

### Changed

- **A guest is now linked to their Kubuno account** when their address matches
  one, and the organizer appears in the guest list as the meeting's host. The
  per-guest "send by e-mail" (`mailto:`) shortcut is gone, since the invitation
  is now sent for you.

### Fixed

- **Stale RSVP replies no longer overwrite a fresher answer.** A reply that
  answers an out-of-date invitation (one superseded by a later change to the
  meeting) is ignored.

- Removed two internal event notifications (`EventUpdated`/`EventDeleted`) that
  were malformed and silently rejected on every event edit and deletion since
  the module shipped.


- **The README now opens with the module's logo.** The public README on
  GitHub now shows the module's designer logo (the same PNG shown as the
  browser tab icon and in the applications menu) at the top of the page — the
  repository landing now matches the icon a signed-in user sees inside the
  platform. The image ships in-repo, under `.github/logo.png`, so it renders
  even when the repo is browsed offline.

- **New Calendar logo** — a violet hexagon with a white calendar grid, used
  as the browser-tab icon and in the applications menu. It is now raster (PNG)
  designer artwork.

- **The advanced-search panel and the search bar now stay in sync both ways.**
  Opening the panel pre-fills the "Subject" field with the bar's current text,
  and editing that field rewrites the bar's text live (running the search as
  you type, exactly like typing in the bar). The calendar's search is plain
  free text matched against event titles and descriptions — the other panel
  fields (location, excluded words, dates, scope) are state filters with no
  text representation, so they intentionally stay panel-only. "Reset" now also
  clears the search bar's text.




### Fixed


- **A withdrawn dependency is no longer used.** A crate deep in the tree
  (`spin` 0.9.8, pulled in through the HTTP stack) was yanked by its authors.
  No vulnerability was announced, but a withdrawn crate has no business in a
  release; the lockfile now takes the version that replaced it.
- **The package could not be built where `zip` is absent.** The Windows job of
  the continuous integration has no `zip`, so the Windows package was simply lost
  the first time it was attempted — a script failure, not a build failure. The
  builder now falls back to 7-Zip, then to PowerShell.
### Added

- **`createEvent` accepts a `status`** (confirmed/tentative) so callers can
  reflect an invitation RSVP when adding the event.

- **`createEvent` inter-module service.** Other modules (mail's "Add to
  calendar" on a rich card, for one) can now create an event without knowing the
  user's calendars: the service resolves a writable default calendar and creates
  the event there.

- **This module now ships a `.kbpkg`** — the single package format a Kubuno
  server installs by itself, the same file on Linux, Windows and macOS. It
  carries the same binary, interface and manifest as the system packages,
  arranged the way the server expects to find a module on disk, plus a
  `SHA256SUMS` so a copy carried offline can be checked without the catalogue.
  Nothing changes for existing installations: the `.deb`, `.rpm`, `.exe` and
  `.pkg` are still published, and a catalogue that sees both simply prefers the
  new one. It is also the only format the server can unpack without an external
  tool, which is what makes one-click installation possible away from
  Debian-like systems.
### Fixed

- **A built package could be thrown away instead of published.** The job that
  attaches a package to the release waited ten minutes for another workflow to
  create that release, then gave up with "release never appeared — build.yml
  likely failed". The diagnosis was wrong: on a repository whose `.deb` takes
  longer than ten minutes to build, the release simply did not exist yet, and a
  package that had built perfectly was discarded. Four modules reached v0.1.6
  with packages missing for some systems because of it. The job now creates the
  release itself when it is missing, so it no longer depends on another workflow
  finishing first.
### Added

- **Security policy and CI quality gate.** A `SECURITY.md` documents how to
  report vulnerabilities, and a CI workflow enforces `clippy -D warnings`, a
  dependency-vulnerability audit (`cargo audit`) and the frontend typecheck/tests.

### Security

- **Calendar now authenticates proxied requests from a signed token instead of
  trusting plain headers.** Requests must carry a valid `X-Kubuno-Auth` token
  minted by the core with this module's internal secret (see `kubuno-modauth`),
  rather than reading `X-Kubuno-User-*` headers at face value — which any process
  reaching Calendar's loopback port could otherwise forge to act as any user.

## [0.1.6] - 2026-08-19

### Changed

- **Pill-shaped buttons are gone from the interface.** Filter chips, view
  segments, tab selectors and action buttons that were drawn as pills now use the
  same 4 px corner radius as every other button — the shape set them apart for no
  reason other than habit. Round buttons that hold a lone icon, avatars, status
  dots and non-clickable badges keep their shape: a circle around a single glyph
  is not a pill.

- Theme tokens: two colours for navigation labels (`--color-text-nav`,
  `--color-text-nav-active`). Every module carries the same token sheet, so the
  values must match across them — whichever bundle loads last would otherwise
  win. No visible change inside this module.

### Changed

- Default application background token aligned with the core (`--body-bg` `#f8fafd`). Only
  visible when the module runs standalone: inside the shell the active theme sets it.

[Unreleased]: https://github.com/kubuno/calendar/compare/v0.1.6...HEAD
[0.1.6]: https://github.com/kubuno/calendar/releases/tag/v0.1.6
