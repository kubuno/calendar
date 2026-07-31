// Resolved per-user settings of the Calendar module.
//
// The declarative manifest (`module.toml` → `[[settings]]`) is served already
// resolved by the core (`GET /modules/calendar/config`: user override ?? instance
// default ?? factory default). This hook turns that generic payload into a typed,
// ready-to-use object and is the single place the views read their preferences
// from. The query key is shared with <ModuleSettingsForm>, so saving the settings
// page instantly re-renders every view.
//
// Two preferences have no scalar representation in the manifest (a list of days,
// a list of timezones); they live in the same JSONB bag (`core.users.preferences
// .calendar`) and are read straight from the auth store — see `useModulePrefs`.
import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { format as fmtDateFns } from 'date-fns'
import { api, useAuthStore, getDateLocale } from '@kubuno/sdk'

export type TimeFormat        = '24h' | '12h'
export type NotificationsMode = 'off' | 'in_app' | 'desktop'
/** date-fns `weekStartsOn` (0 = Sunday). */
export type WeekStart         = 0 | 1 | 6

/** Where the user works on a given day — shown to people viewing their calendar. */
export type WorkLocation =
  | 'office' | 'home' | 'unspecified' | 'other_office' | 'elsewhere'

/** A working interval, in minutes from midnight. */
export interface WorkRange { start: number; end: number }

/** A working day: one or more time ranges, plus a location. `custom` holds the
 *  free-text place for `other_office` / `elsewhere` (Google's "Add a location").
 *  An entry with no range means the day is not a working day. */
export interface WorkDay { ranges: WorkRange[]; location: WorkLocation; custom?: string }

/** Per-weekday work schedule (0 = Sunday … 6 = Saturday). */
export type WorkSchedule = Record<number, WorkDay>

export interface CalendarSettings {
  // Langue et région
  dateFormat:        string          // '' = follow the active locale
  timeFormat:        TimeFormat
  // Fuseau horaire
  secondaryTimezone: string | null   // null = single hour column
  // Événements
  defaultDurationMin: number
  speedyMeetings:     boolean
  defaultReminderMin: number         // 0 = no reminder
  // Notifications
  notificationsMode:    NotificationsMode
  notificationSound:    boolean
  notifyOnlyIfAccepted: boolean
  // Affichage
  showWeekends:       boolean
  showDeclinedEvents: boolean
  showWeekNumbers:    boolean
  minEventHeight:     boolean
  dimPastEvents:      boolean
  weekStartsOn:       WeekStart
  customViewDays:     number
  defaultView:        string
  dayStartHour:       number
  // Heures et lieu de travail
  workingHoursEnabled:    boolean
  workSchedule:           WorkSchedule  // per-weekday ranges + location
  /** Instance-wide (admin) toggle: may users set a daily work location at all? */
  workingLocationAllowed: boolean
  // Divers
  keyboardShortcuts: boolean
  worldClock:        string[]        // IANA timezones shown in the sidebar clock
}

/** Factory work schedule: Monday–Friday, 09:00–17:00, location left unspecified
 *  (so day headers stay clean until the user actually picks a location). */
export function defaultWorkSchedule(): WorkSchedule {
  const day = (): WorkDay => ({ ranges: [{ start: 540, end: 1020 }], location: 'unspecified' })
  return { 1: day(), 2: day(), 3: day(), 4: day(), 5: day() }
}

/** Factory defaults — must mirror the `default =` of `module.toml`. Used until
 *  the config query resolves so the first paint already looks right. */
export const CALENDAR_SETTINGS_DEFAULTS: CalendarSettings = {
  dateFormat:        '',
  timeFormat:        '24h',
  secondaryTimezone: null,

  defaultDurationMin: 60,
  speedyMeetings:     false,
  defaultReminderMin: 10,

  notificationsMode:    'in_app',
  notificationSound:    true,
  notifyOnlyIfAccepted: false,

  showWeekends:       true,
  showDeclinedEvents: true,
  showWeekNumbers:    false,
  minEventHeight:     false,
  dimPastEvents:      true,
  weekStartsOn:       1,
  customViewDays:     4,
  defaultView:        'month',
  dayStartHour:       8,

  workingHoursEnabled:    false,
  workSchedule:           {},   // filled from prefs, or defaultWorkSchedule() when enabled
  workingLocationAllowed: true,

  keyboardShortcuts: true,
  worldClock:        [],
}

const WORK_LOCATIONS: WorkLocation[] = ['office', 'home', 'unspecified', 'other_office', 'elsewhere']

/** Coerce whatever sits in the JSONB bag into a well-formed WorkSchedule. */
function parseWorkSchedule(raw: unknown): WorkSchedule {
  if (raw === null || typeof raw !== 'object') return {}
  const out: WorkSchedule = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const wd = Number(k)
    if (!Number.isInteger(wd) || wd < 0 || wd > 6 || v === null || typeof v !== 'object') continue
    const rawRanges = (v as { ranges?: unknown }).ranges
    const ranges: WorkRange[] = Array.isArray(rawRanges)
      ? rawRanges
          .map(r => (r && typeof r === 'object')
            ? { start: Number((r as WorkRange).start), end: Number((r as WorkRange).end) }
            : { start: NaN, end: NaN })
          .filter(r => Number.isFinite(r.start) && Number.isFinite(r.end) && r.end > r.start)
      : []
    const loc = (v as { location?: unknown }).location
    const location = WORK_LOCATIONS.includes(loc as WorkLocation) ? loc as WorkLocation : 'office'
    const rawCustom = (v as { custom?: unknown }).custom
    const custom = typeof rawCustom === 'string' ? rawCustom : undefined
    out[wd] = { ranges, location, custom }
  }
  return out
}

interface RawSetting {
  key:       string
  effective: unknown
}

const WEEK_START_DAYS: Record<string, WeekStart> = { sunday: 0, monday: 1, saturday: 6 }

function asBool(v: unknown, fallback: boolean): boolean {
  if (typeof v === 'boolean') return v
  if (v === 'true' || v === 'false') return v === 'true'
  return fallback
}

function asNum(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''))
  return Number.isFinite(n) ? n : fallback
}

function asStr(v: unknown, fallback: string): string {
  return typeof v === 'string' ? v : fallback
}

/** The module's raw settings, as resolved by the core for the current user. */
export function useCalendarConfigQuery() {
  return useQuery({
    queryKey: ['module-config', 'calendar'],
    queryFn:  () => api.get<{ settings: RawSetting[] }>('/modules/calendar/config').then(r => r.data),
    staleTime: 60_000,
  })
}

export function useCalendarSettings(): CalendarSettings {
  const { data } = useCalendarConfigQuery()
  // Free-form preferences (arrays) share the module's JSONB bag but not the
  // declarative manifest, so they come straight from the authenticated user.
  const prefs = useAuthStore(s => s.user?.preferences?.calendar) as Record<string, unknown> | undefined

  return useMemo(() => {
    const d = CALENDAR_SETTINGS_DEFAULTS
    const map = new Map((data?.settings ?? []).map(s => [s.key, s.effective]))
    const get = (k: string) => map.get(k)

    const workingHoursEnabled = asBool(prefs?.work_enabled, d.workingHoursEnabled)
    // A stored schedule wins; before the user ever touched it, seed the factory
    // one so enabling the feature already shows sensible Mon–Fri hours.
    const stored = prefs && 'work_schedule' in prefs ? parseWorkSchedule(prefs.work_schedule) : null
    const workSchedule = stored && Object.keys(stored).length > 0 ? stored : defaultWorkSchedule()
    const worldClock = Array.isArray(prefs?.world_clock)
      ? (prefs!.world_clock as unknown[]).filter((v): v is string => typeof v === 'string')
      : d.worldClock

    const secondary = asStr(get('secondary_timezone'), '')

    return {
      dateFormat:        asStr(get('date_format'), 'auto') === 'auto' ? '' : asStr(get('date_format'), ''),
      timeFormat:        asStr(get('time_format'), d.timeFormat) === '12h' ? '12h' : '24h',
      secondaryTimezone: secondary.length > 0 ? secondary : null,

      defaultDurationMin: asNum(get('default_event_duration_min'), d.defaultDurationMin),
      speedyMeetings:     asBool(get('speedy_meetings'),     d.speedyMeetings),
      defaultReminderMin: asNum(get('default_reminder_min'), d.defaultReminderMin),

      notificationsMode:    (['off', 'in_app', 'desktop'] as const)
        .find(m => m === asStr(get('notifications_mode'), d.notificationsMode)) ?? d.notificationsMode,
      notificationSound:    asBool(get('notification_sound'),       d.notificationSound),
      notifyOnlyIfAccepted: asBool(get('notify_only_if_accepted'),  d.notifyOnlyIfAccepted),

      showWeekends:       asBool(get('show_weekends'),        d.showWeekends),
      showDeclinedEvents: asBool(get('show_declined_events'), d.showDeclinedEvents),
      showWeekNumbers:    asBool(get('show_week_numbers'),    d.showWeekNumbers),
      minEventHeight:     asBool(get('min_event_height'),     d.minEventHeight),
      dimPastEvents:      asBool(get('dim_past_events'),      d.dimPastEvents),
      weekStartsOn:       WEEK_START_DAYS[asStr(get('week_starts_on'), 'monday')] ?? d.weekStartsOn,
      customViewDays:     asNum(get('custom_view_days'), d.customViewDays),
      defaultView:        asStr(get('default_view'), d.defaultView),
      dayStartHour:       asNum(get('day_start_hour'), d.dayStartHour),

      workingHoursEnabled,
      workSchedule,
      workingLocationAllowed: asBool(get('allow_working_location'), d.workingLocationAllowed),

      keyboardShortcuts: asBool(get('keyboard_shortcuts'), d.keyboardShortcuts),
      worldClock,
    }
  }, [data, prefs])
}

// ── Formatting helpers ─────────────────────────────────────────────────────────

/** date-fns pattern for a time of day, honouring the 12 h/24 h preference. */
export function timePattern(timeFormat: TimeFormat): string {
  return timeFormat === '12h' ? 'h:mm a' : 'HH:mm'
}

/** Same, without the minutes when they are zero — used for hour gutters. */
export function hourPattern(timeFormat: TimeFormat): string {
  return timeFormat === '12h' ? 'h a' : 'HH:mm'
}

/** Formats a wall-clock time expressed in minutes from midnight. */
export function formatMinutes(minutes: number, timeFormat: TimeFormat): string {
  const d = new Date(2000, 0, 1)
  d.setHours(Math.floor(minutes / 60), Math.round(minutes % 60), 0, 0)
  return fmtDateFns(d, timePattern(timeFormat))
}

/** Formats a date with the user's numeric date format ('' = active locale). */
export function formatDate(date: Date, dateFormat: string, language?: string): string {
  return dateFormat
    ? fmtDateFns(date, dateFormat)
    : fmtDateFns(date, 'P', { locale: getDateLocale(language) })
}

// ── Work schedule helpers ───────────────────────────────────────────────────────

/** The working day for a JS weekday (0 = Sunday), or null when it is not a
 *  working day. Presence in the schedule marks a working day; a day always keeps
 *  at least one range even while the hours toggle hides them. */
export function workDayFor(schedule: WorkSchedule, weekday: number): WorkDay | null {
  return schedule[weekday] ?? null
}

/** True when the given clock hour is covered by a working range that day. Used to
 *  decide which hour cells of the Day/Week grid stay lit vs. shaded. */
export function isWorkingHour(day: WorkDay | null, hour: number): boolean {
  if (!day) return false
  const from = hour * 60, to = from + 60
  return day.ranges.some(r => from < r.end && to > r.start)
}
