# Changelog

All notable changes to **kubuno-calendar** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this
project adheres to [Semantic Versioning](https://semver.org/). Entries are added under
`[Unreleased]` **as the change is made**; `_tools/release.sh` stamps them under the version
number at release time, and CI publishes that section as the GitHub Release notes.

## [Unreleased]

## [0.1.8] - 2026-09-18

### Security

- **HTTP/2 layer updated to a patched release.** `h2` moves from 0.4.14 to
  0.4.19, closing a denial of service through unbounded empty DATA frames
  (RUSTSEC-2026-0258).
- **Error library updated to a patched release.** `anyhow` moves from 1.0.102
  to 1.0.104, closing an unsoundness in `Error::downcast_mut()`
  (RUSTSEC-2026-0190).
- **TLS library updated to a patched release.** The pinned `rustls` carried
  RUSTSEC-2026-0285 (medium). Every outbound HTTPS connection goes through it.

## [0.1.7] - 2026-09-18

### Changed

- **An event can carry labels, and can be given them while it is being
  created.** They are the instance's own labels — the ones that also go on a
  file, a note or a task — and they now have a line in the form beside the date
  and the location, in the quick card and in the full editor alike. Attaching
  them used to mean finding "Kubuno labels…" under other actions on an event
  that already existed; a new event had nowhere to put them. Chosen before the
  event exists, they are attached the moment it does, and a refusal there costs
  the labels, never the event.

- **The help behind a "?" is now a bubble that points at what it explains.** It
  was a white card on a white panel, which reads as more of the form rather than
  as an answer to the question just asked; it is now filled in the instance's
  accent with an arrow on whichever edge faces the control, at that control's
  own centre. It is the shared library's bubble, so every "?" in the product
  answers the same way.

### Fixed

- **A description written with formatting or a mention is readable again on the
  event card.** The card edited it in a plain box while the full form used the
  rich editor, so a description that had been through the full form came back to
  the card as its own source — `<span class="…">` and all — and saving from
  there stored that. The card now uses the same editor, so the two forms show
  the same thing and a mention stays a mention. Copying an event or sending it
  by e-mail puts the words in the body, not the markup, and searching a
  description matches what was written rather than the tags around it.

### Changed

- **Typing `@` in the guest field reaches for a person.** One letter after it is
  now enough to be offered a list — the `@` has already said you are naming
  somebody rather than typing an address, so the usual two-letter wait no longer
  applies. What follows the `@` is what gets searched, and `@m` is no longer
  mistaken for an address: it stops raising the "this address is outside your
  organisation" notice, and pressing Enter on it no longer invites `@m`.

- **The "Invite" button is gone from both guest panels.** A suggestion is taken
  by choosing it and a typed address by pressing Enter; the button was a third
  way to do what two already did, and it took a quarter of the column to say so.
  The field now spans the full width.

### Added

- **An event and its video call share one title.** A meeting attached to an
  event used to take the event's name once, at creation, and then drift: rename
  the event and the meetings list still showed the old name. The two names are
  now the same name — change it in either place and the other follows, whether
  the change comes from this calendar, from the meetings list, or from another
  device. A small link mark sits beside the title to say so before you type, and
  taking the call off the event releases it: the meeting keeps the name its link
  was shared under, and stops following.

### Added

- **The quick card invites people the same way the full editor does.** It had
  its own plain address box and its own chips: no suggestions, no faces, no
  "optional", no clash warning — the same job done twice, an inch apart, and one
  of the two always behind. Both now use the same field and the same line, so
  what is true of one is true of the other.

- **"Other actions" in a window's title bar is an icon.** Two words wrapped onto
  a second line in that narrow strip and crowded the close button; the name now
  lives in the tooltip, where it costs no width. A menu bar rather than an
  ellipsis: three dots are almost no ink and read as a smudge on a coloured band
  at normal distance, and the button has to be findable without being hunted
  for.

- **A `Name <address>` string is understood as a name and an address.** It is the
  form every mail client copies, and the form a colleague pastes into a message.
  Stored whole it became an address nobody could write to and a name nobody
  could read. It is now split where the address lands — on the server — so an
  import, a script or another client gets the same treatment as the guest field,
  and a malformed one is refused rather than mangled.

- **Typing `@` in an event's description suggests people.** From whatever this
  instance can offer: its own accounts, and your contacts when that module is
  installed. Only in the description — in the guest field `@` is part of an
  address, and a title is a title.

- **Guests have faces.** A guest with an account shows their photo — on the
  suggestion, on the line and on the card — derived from the account rather than
  fetched, so a list of twenty names costs no extra request. A photo held by
  your contacts wins over it, being the one chosen for that person; an initial
  stands in when there is nothing, and also when a photo fails to load.

- **Writing to a guest uses the instance's own composer when it has one**,
  rather than handing you to an external mail client. Without a mail module the
  link keeps doing exactly what a link does.

- **A guest's card shows what the instance actually knows about them.** It was
  a name and an address. It now carries the directory's own profile — how the
  name is said, the pronouns asked for, where the person works from, the line
  they wrote about themselves, their unit — plus whatever other modules
  contribute: their job title, organisation and telephone from your contacts, a
  named link to their site. Nothing is invented and no empty row is drawn.
  (Gender and date of birth are deliberately not part of it, and never will be.)

- **The card's buttons come from the modules that can perform them.** Writing
  an e-mail is always there; chatting and starting a call appear when a module
  hosts them, and only for someone with an account — there is nobody to talk to
  behind an outside address. Opening the full contact sheet appears when
  contacts is installed. An instance without those modules simply shows fewer
  buttons rather than buttons that fail.

- **A guest who is already busy at that hour is flagged when you add them.**
  Checked per guest over the event's own window, for the guests whose calendar
  this instance can read. It is said on their line, in amber, and nothing is
  blocked: a clash is what makes an organiser move the hour, not an error to
  refuse.

- **Guest permissions, and they are enforced.** An organiser decides three
  things: whether guests may modify the event, invite other people, and see who
  else is invited. The defaults are the familiar ones — guests may invite and
  may see each other, and may not rewrite the event. Each is applied by the
  server: a guest allowed to modify can now actually edit the event (but not
  move it to someone else's calendar), one allowed to invite can add a name, and
  one kept from the guest list sees only the organiser and themselves rather
  than an empty list. The three checkboxes were on screen before, wired to
  nothing.

- **A guest whose availability cannot be shown says so.** A name on the list
  carries an asterisk when this instance cannot read that person's calendar —
  they have no account here, their agenda is not shared with you, or it does not
  publish its free time. The asterisk is explained once under the list, behind a
  question mark, rather than repeated on every line. Without it, the "Find a
  time" grid stays blank for that guest and blank reads as "free".

- **Clicking a guest opens their card**: photo, name, address, and what can
  actually be done from here — write to them, or look at when they are free.
  Nothing more: an action that opens a module this instance has not installed
  would be worse than an absent one.

- **A guest can be welcome without being required.** Mark a guest optional from
  the list and they are shown as such; the invitation itself carries it, so the
  distinction reaches their own calendar rather than stopping at yours. Only the
  organiser may set it — it is a statement about a guest, not an answer from
  them. Taking a name off the list stays with the organiser too: "invite others"
  adds people, it was never a licence to uninvite them.

- **The guest field suggests people as you type.** Colleagues from the instance
  directory, with their photo and name, and your own contacts when a module
  provides them; an address typed in full still invites anyone. A colleague
  found in both places appears once. When the directory is set to keep addresses
  private — the common case — the suggestion invites the ACCOUNT and the server
  resolves the address, so picking a colleague works without their mailbox ever
  reaching the browser.

### Fixed

- **A day's entries are listed in the order of the day.** The grid draws four
  things — your events, booking-page availability, public holidays and the block
  you are dragging — and they were simply appended one list after another. Each
  was in order within itself, but the result was not: a 09:00 booking slot sat
  below a 16:00 meeting in the same cell. They are now merged chronologically,
  all-day entries first, in every view at once.

- **Moving an event's start date moves its end date with it.** The two dates
  were independent: pushing an event forward left its end where it was, so the
  event finished before it began and saving answered “Database error” without
  saying what was wrong. The end now follows the start and keeps the event the
  same length, and dragging the end before the start stops it on the first day
  instead. An evening that runs past midnight (22:00–01:00) is still a
  three-hour event, not a negative one.

- **A date range the server cannot accept is refused with a sentence, not a
  “Database error”.** The table has always refused an event that ends before it
  starts; reaching that constraint produced an opaque 500. The range is checked
  before the write now, and the form shows what is wrong.

- **An event you close without saving takes its video call with it.** The room
  behind a call has to be created while the event is still being written, and it
  used to stay behind when the event did not: abandoning the form, or removing
  the call from it, left the room in place for ever. The form now says which way
  it went — saved, or thrown away — and whoever hosts the call acts on it.

### Changed

- **One card for an event, whether it exists yet or not.** Clicking an event
  opened a detail window; creating one opened a small card. They showed the same
  event an inch apart and agreed on almost nothing — different surface,
  different rows, and the video call dressed by the meeting module in one and a
  bare button in the other. There is one card now: empty for a new event, filled
  for an existing one. Consulting and changing are the same gesture — the rows
  open already filled — and what only an existing event can offer came with it:
  invite with a link, send by e-mail, delete, duplicate, copy, labels, print,
  its reminders and its visibility, all editable rather than merely displayed.
  Changing or deleting one occurrence of a series asks which occurrences, in the
  same words for both.

- **The quick card offers the same video call as the full editor.** It created
  the room through a private path of its own, so the module that hosts meetings
  dressed the editor's row and not this one — and the link it wrote landed in
  the *location* field rather than in the event's link. Both forms now go
  through the same extension point, and a room created from the card is the same
  draft as one created from the editor: it survives “More options”, and it is
  taken back if the card is dismissed.

- **The quick-create card is the event form, not a look-alike.** It sat on white
  with outlined boxes while the full editor sat on a tint with filled fields —
  the same five fields, dressed two different ways, one click apart. The card
  now wears the same surface and the same fields as the editor it opens into.

- **The reminder row lines up with the rest of the form.** It drew its own icon
  gutter instead of using the shared one, which put its fields six pixels left
  of every other field in the column.

- **The event form has one vertical rhythm.** Its rows were 20 px apart, the
  date lines 4 px, and a reminder sat 6 px above the link that adds another —
  spacing that reads as though some fields belong together and others do not.
  Every gap is the same now, and the first field of each region starts on the
  same line.

- **An event's video call is a link of its own, typed or pasted like any
  other.** The video row used to be a single button that only worked when a
  module of this instance hosted meetings, and it stored the link in the
  event's place — so a call held anywhere else could not be attached, and a
  call and a place could not coexist. The row is now a link field, kept apart
  from the place; the event's detail offers to join it, opening a link into
  this instance in the app and any other in its own tab. Events saved before
  the link had a field of its own are read back into it.

- **Whoever hosts meetings on this instance may replace that field.** Calendar
  declares the place (`video-meeting-field`) and never names a module: if
  someone active has claimed it, their control stands where the field stood
  and their mark replaces the row's generic camera; otherwise the field and
  the camera do. The same bargain as the map behind a building's coordinates.

- **Emptying a text field on an event now clears it.** Saving an event with
  its place, description or link emptied kept the old value, because an absent
  field and a blank one were read the same way. A blank now means "clear".

- **"Find a time" is a calendar, not a list of proposals.** It used to ask for a
  date range and office hours and then print slots where everyone happened to be
  free. That answers a different question from the one an organiser is holding:
  they are looking at a week, they already know which morning would work, and
  they want to see what stands in the way of it. The tab now shows the
  calendars themselves — a day or a week, navigable, with the hours in your own
  zone and in the second zone when you keep one — with your events drawn on
  them, your guests' busy time as a band across the column, and the meeting as
  a block you click or drag onto the hour you want. Its duration is carried
  over unchanged; the hour is what this tab is for.

- **The event window's side margins are narrower**, giving the form back the
  width the margins were holding.

- **The guest and room lists no longer live inside the event's details tab.**
  They are a region of their own, beside it: they stay in view while you look
  for an hour — which is exactly when you want to see who you are trying to
  gather — and the details tabs no longer rule a column they do not command.
  The two regions start on the same line, each strip drawn over its own content,
  and the tabbed region is raised onto a white card.

- **The event form stands on a tint instead of on white**, and its fields —
  text, description, dates, guests, the calendar and status lists — are filled
  boxes with no outline at rest. A field is then something the eye picks out by
  its shape, and the blue stroke it grows on focus is the only line in the form
  that means anything.

- **The event editor is a window now.** It was a card that imitated one, with
  its own drag, its own top bar and its own close button — the one window in the
  product that behaved differently. It is the shared window: it can be moved and
  RESIZED, Escape closes it, and on a phone it fills the screen. The event is
  named at the top of the form it names, and **Save** sits at the bottom right
  where a window's action belongs; the band says which event is being written,
  so a window buried under others is still identifiable. A refused save is also
  stated at the top of the form instead of at the bottom, where it took a scroll
  to find.

- **The event title shows a three-pixel stroke when it has focus.** It drew a
  one-pixel line, thin enough to miss on a high-density screen, where every
  other field marks focus with three. The stroke is reserved at rest too, so the
  title does not move when you click into it.
- **The event editor is built from the shared controls.** Its tab strip was a
  hand-made imitation and three of its fields were bare markup; they are the
  product's own controls now, so they carry the same focus mark, the same
  keyboard behaviour and the same heights as everywhere else. The tab labels
  also line up with the title above them and the fields below them, instead of
  sitting on a third margin of their own.

### Added

- **Creating an event no longer opens a form.** Clicking a slot now draws a
  provisional block right where you clicked — named "(No title)" until you name
  it, and following the title and the hour as you change them — and opens a small
  card beside it carrying what an event needs to exist: a title, the day, guests,
  a video meeting, a place, a description and the calendar it goes to. Most
  events are a title and an hour; asking for a full sheet to get there put the
  save button at the far end of a form nobody wanted to cross. Everything else
  is one click away, behind **More options**, which hands the editor what has
  already been typed rather than starting again.
  Clicking a day in the month grid starts an event AT an hour — the same default
  the editor would have used — rather than a whole day: a whole-day block is
  drawn as a banner, and a banner reserves its height in every cell of the week,
  which pushed the other days' events down while never appearing among the
  events of the day it belonged to.
  **Escape** gives up on the event being composed: the card closes and the
  provisional block leaves the grid with it. **Shift+C** opens this card from
  anywhere, while **C** still goes straight to the full editor — two gestures,
  because an event you already know is complicated should not have to pass
  through a small card first.

### Changed

- **The calendar now wears the platform's blue.** It carried its own accent, the
  purple of its logo; every surface that took that colour — the day marker, the
  buttons, the default colour of a new event — is now the same blue as the rest
  of the product. Purple remains available as an event colour, it is simply no
  longer the one chosen for you.

- **Book a room while you are still writing the invitation.** The room list used
  to appear only once the meeting had been saved, so anyone creating an event
  simply never saw it. It is now beside the guest list from the first keystroke,
  and each room says whether it is free **at the hour currently in the form** —
  naming the meeting that holds it when it is not, because "unavailable" leaves
  the reader with nothing to do and "held by the weekly review" lets them go and
  ask. Several rooms can be picked, and a taken one can still be chosen: the
  meeting is not the room's to cancel, so the room answers and its refusal is
  read beside everyone else's.
  Guests and rooms are two lists of the same rank, so they sit in two tabs
  rather than one stacked under the other, and the rooms tab is simply absent
  on an instance that has declared no room. Each room is read as columns — its
  own name, then the building and floor, then how many it seats and what it is
  equipped with — instead of the single composed string that packs all four into
  a line nobody scans.
  The location field is left to the geographic address, deliberately: a room is
  a participant of the meeting, not the place it is written down as.

### Fixed

- **Moving a meeting now asks its rooms again.** A room that had agreed to
  Tuesday at ten stayed marked as accepting after the meeting was moved to
  Wednesday at three — so two meetings could quietly own the same room. Every
  room held by a meeting is re-decided when its times change, and declines when
  it is no longer free.
- **Room usage figures are now cut into days and hours where you live.** The
  bookings were grouped by the clock in UTC, so a nine o'clock meeting in Paris
  was counted at eight, and an early one in Tokyo landed on the previous day.
  The caller now names the time zone and every day and hour is read on a clock
  there; the instants themselves never changed.

### Added

- **The module can now report what its rooms were used for.** It answers, over a
  period, how many bookings the rooms held and for how many hours, day by day and
  hour by hour, per room, and how many hours were handed back automatically.
  Recurring bookings are counted occurrence by occurrence: a weekly meeting
  occupies its room every week, and counting it once would show the busiest room
  in the building as idle.

- **Everyone on the meeting is told when its room goes back.** The organiser and
  the guests get the same notice they get for any other change to the event —
  because that is what happened. The meeting itself is untouched.

- **A room that nobody is coming to is given back.** When every invitee but one
  has declined, the room declines too and returns to the pool, so the next person
  looking for a space can have it — and your meeting is left alone, because two
  people who cannot come do not cancel it. The organiser sees the room marked as
  released rather than merely refused, which is a different thing from a room
  that turned the meeting down because it was already booked.
  Nothing is ever taken back at the last moment, or from a booking where the
  stakes are high: a meeting starting within half an hour keeps its room, and so
  does one that runs longer than four hours, one held in a room seating twenty or
  more, and one with a guest from outside the organisation, whose answer we
  cannot read. An administrator can also exempt a specific room, or a group whose
  meetings must always keep theirs.

- **A meeting room can now be invited to an event, and it answers.** Pick a room
  from the organisation's directory and it joins the guest list like anyone
  else: it accepts when it is free, and it declines when it is already taken —
  naming the meeting that holds it, so "held by the weekly review, 14:00" is
  what you read instead of "unavailable". A taken room never cancels your
  meeting; it simply says no, where you read everyone else's answer.
  Recurring meetings are checked occurrence by occurrence, which is the case
  that matters: a room is most often held by the weekly meeting rather than by a
  one-off.
### Added
- **Invitation e-mails carry Yes / No / Maybe buttons.** Each guest receives their own answer link, so someone outside the instance can reply from their mail client without an account. Answering records the response on the event straight away.
- **New administrator setting "Public URL of the instance"** (Calendar → Sharing). It is the address invitation answer links are built on; left empty, invitations simply carry no buttons and guests answer from their own calendar.

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

- **This module now installs as a Kubuno package (`.kbpkg`) only.** Its system
  packages (Debian/RPM and the Windows and macOS installers) are no longer
  built: the module is distributed as one `.kbpkg` per platform (Linux, Windows,
  macOS) that the Kubuno server installs itself — from the admin console, or
  offline with `kubuno modules:install <file>.kbpkg`.
- **Dates and times are now written by the platform in the reader's language.**
  Calendar's date and time formatting moved to the in-house Intl API in
  `@kubuno/sdk`, and the `date-fns` dependency is gone. Day, month and weekday
  names, week numbers and the 12 h/24 h clock now follow each reader's language
  and regional conventions instead of a fixed pattern.

- Internal: the translations file was split into one file per language under
  `frontend/src/i18n/` (was a single 4,600-line module), for maintainability. No
  user-facing change — the exact same strings are registered.

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

[Unreleased]: https://github.com/kubuno/calendar/compare/v0.1.8...HEAD
[0.1.8]: https://github.com/kubuno/calendar/releases/tag/v0.1.8
[0.1.7]: https://github.com/kubuno/calendar/releases/tag/v0.1.7
[0.1.6]: https://github.com/kubuno/calendar/releases/tag/v0.1.6
