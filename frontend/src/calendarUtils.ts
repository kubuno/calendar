// Shared helpers, constants and small hooks used across the calendar views.
// Split out of the former monolithic CalendarApp.tsx for maintainability.
import { useState, useEffect } from 'react'
import { toDate, addDays, startOfDay, startOfMonth, endOfMonth, startOfWeek, endOfWeek, isSameDay, eachDayOfInterval, ModuleServiceRegistry } from '@kubuno/sdk'
import { type ViewMode } from './store'
import {
  workDayFor, isWorkingHour,
  type CalendarSettings, type WeekStart,
} from './calendarSettings'
import type { Calendar, EventInstance, AppointmentSchedule } from './api'

export type MeetingProvider = (title: string, attendeeIds?: string[]) => Promise<{ link: string; roomId: string }>
export const MEETING_LINK_RE = /\/chat\/meet\/[\w-]+/
export function getMeetingProvider(): MeetingProvider | undefined {
  return ModuleServiceRegistry.get<MeetingProvider>('chat', 'createMeeting')
}

export const EVENT_SWATCHES = ['#1a73e8', '#1e8e3e', '#d93025', '#f9ab00', '#9334e6', '#e8710a', '#12b5cb', '#4D38DB', '#5f6368']

// Google-style single-letter view shortcuts (match the switcher menu hints).
export const VIEW_SHORTCUTS: Record<string, ViewMode> = {
  d: 'day', w: 'week', m: 'month', y: 'year', a: 'schedule', x: 'custom',
}

// ── Helpers ──────────────────────────────────────────────────────────────────

export const REMINDER_OPTIONS: Array<{ value: number; labelKey: string }> = [
  { value: 5,    labelKey: 'rem_5min' },
  { value: 10,   labelKey: 'rem_10min' },
  { value: 15,   labelKey: 'rem_15min' },
  { value: 30,   labelKey: 'rem_30min' },
  { value: 60,   labelKey: 'rem_1h' },
  { value: 120,  labelKey: 'rem_2h' },
  { value: 1440, labelKey: 'rem_1day' },
]

export function isWeekend(date: Date): boolean {
  const d = toDate(date).getDay()
  return d === 0 || d === 6
}

// Calendars the user can WRITE to: their own plus those shared with "Edit"
// access. Subscriptions (mirrors of a remote feed) are excluded: any event
// created there would be purged on the next sync.
export function writableCalendars(calendars: Calendar[]): Calendar[] {
  return calendars.filter(c =>
    (c.my_permission == null || c.my_permission === 'owner' || c.my_permission === 'write')
    && !c.subscription_url)
}

// Calendar locked for event editing (read-only or subscription).
export function isCalendarLocked(cal: Calendar | undefined): boolean {
  return !!cal && (cal.my_permission === 'read' || !!cal.subscription_url)
}

// Marker prefix identifying a synthetic availability block (vs a real event).
export const APPT_PREFIX = 'appt::'

// Expand appointment schedules into synthetic per-day availability blocks over
// the visible range, so the owner sees when their booking pages are open
// (recurring "09:00 <title>" markers). These are non-editable events
// tagged via `event_id = appt::<scheduleId>`; clicking one opens the editor.
// Times are built in local time — correct when the browser shares the schedule's
// timezone (the default), which is the common case.
export function buildAvailabilityEvents(schedules: AppointmentSchedule[], from: Date, to: Date): EventInstance[] {
  const out: EventInstance[] = []
  for (const s of schedules) {
    const rules = s.availability ?? []
    if (rules.length === 0) continue
    const color = s.color || '#1a73e8'
    const cursor = new Date(from.getFullYear(), from.getMonth(), from.getDate())
    const last = new Date(to.getFullYear(), to.getMonth(), to.getDate())
    while (cursor <= last) {
      const y = cursor.getFullYear(), mo = cursor.getMonth(), d = cursor.getDate()
      const iso = `${y}-${String(mo + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`
      const weekday = (cursor.getDay() + 6) % 7                    // 0 = Mon … 6 = Sun
      const overrides = rules.filter(r => r.specific_date === iso)
      const windows = overrides.length > 0 ? overrides : rules.filter(r => r.weekday === weekday)
      for (const w of windows) {
        const start = new Date(y, mo, d, Math.floor(w.start_minute / 60), w.start_minute % 60)
        const end   = new Date(y, mo, d, Math.floor(w.end_minute / 60), w.end_minute % 60)
        out.push({
          id: `${APPT_PREFIX}${s.id}::${iso}::${w.start_minute}`,
          event_id: `${APPT_PREFIX}${s.id}`,
          calendar_id: s.calendar_id, owner_id: s.owner_id,
          title: s.title || 'Rendez-vous',
          description: null, location: null, url: null,
          starts_at: start.toISOString(), ends_at: end.toISOString(),
          all_day: false, is_recurring: true, rrule: null,
          status: 'confirmed', visibility: 'public', busy: false,
          color, ical_uid: '', etag: '', reminders: [],
        })
      }
      cursor.setDate(cursor.getDate() + 1)
    }
  }
  return out
}

// Side-by-side layout of overlapping events (day/week views): groups
// transitive overlaps into "clusters", assigns each event the first free
// column, and splits the cluster width between its columns.
export function layoutDayEvents(evs: EventInstance[]): Map<string, { leftPct: number; widthPct: number }> {
  const MIN_SPAN = 30 // minutes: a very short event still takes up room
  const items = evs
    .map(ev => {
      const s = toDate(ev.starts_at)
      const e = toDate(ev.ends_at)
      const sMin = s.getHours() * 60 + s.getMinutes()
      return { id: ev.id, s: sMin, e: Math.max(e.getHours() * 60 + e.getMinutes(), sMin + MIN_SPAN) }
    })
    .sort((a, b) => a.s - b.s || b.e - a.e)

  const res = new Map<string, { leftPct: number; widthPct: number }>()
  let cluster: Array<{ id: string; s: number; e: number; col: number }> = []
  let clusterEnd = -1

  const flush = () => {
    if (!cluster.length) return
    const cols = Math.max(...cluster.map(c => c.col)) + 1
    for (const c of cluster) res.set(c.id, { leftPct: (c.col / cols) * 100, widthPct: 100 / cols })
    cluster = []
    clusterEnd = -1
  }

  for (const it of items) {
    if (cluster.length && it.s >= clusterEnd) flush()
    const busy = new Set(cluster.filter(c => c.e > it.s).map(c => c.col))
    let col = 0
    while (busy.has(col)) col++
    cluster.push({ ...it, col })
    clusterEnd = Math.max(clusterEnd, it.e)
  }
  flush()
  return res
}

export function calendarGrid(month: Date, weekStartsOn: WeekStart): Date[] {
  const start = startOfWeek(startOfMonth(month), weekStartsOn)
  const end   = endOfWeek(endOfMonth(month), weekStartsOn)
  return eachDayOfInterval(start, end)
}

/** Events the user explicitly declined — hidden unless the display option asks
 *  for them (the RSVP status is resolved server-side, see `my_status`). */
export function keepPerSettings(events: EventInstance[], settings: CalendarSettings): EventInstance[] {
  if (settings.showDeclinedEvents) return events
  return events.filter(ev => ev.my_status !== 'declined')
}

/** Is a given clock hour shaded as off-work in the Day/Week grid? Off when the
 *  working-hours preference is on and that hour is outside the day's ranges (a
 *  non-working day shades every hour). */
export function isOffWorkHour(date: Date, hour: number, settings: CalendarSettings): boolean {
  if (!settings.workingHoursEnabled) return false
  const day = workDayFor(settings.workSchedule, toDate(date).getDay())
  return !isWorkingHour(day, hour)
}

export interface CtxMenuState {
  x: number
  y: number
  event: EventInstance
}

// "Live" current time: re-renders periodically so the "now" line and the
// past/upcoming dimming evolve in real time without reloading the page.
export function useNowTick(intervalMs = 30_000): Date {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
  return now
}


// Width (px) reserved on the left of a day column for appointment-schedule
// availability strips, so real events are nudged right and never cover them.
export const APPT_GUTTER = 18

// ── Multi-day / all-day "banner" events ─────────────────────────────────────────
// Google shows all-day events and events spanning more than one calendar day as a
// continuous horizontal bar in a dedicated row (Day/Week) or across the day cells
// (Month), with a pointed end when the event continues outside the visible range.

/** Darken a #rgb / #rrggbb colour by `factor` (0–1) — used for the continuation
 *  arrow tip of a banner, which Google draws in a darker shade of the event. */
export function shade(hex: string, factor: number): string {
  let h = hex.replace('#', '')
  if (h.length === 3) h = h.split('').map(c => c + c).join('')
  if (h.length !== 6) return hex
  const n = parseInt(h, 16)
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)))
  const r = clamp(((n >> 16) & 0xff) * factor)
  const g = clamp(((n >> 8) & 0xff) * factor)
  const b = clamp((n & 0xff) * factor)
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`
}

/** A banner event: all-day, or a timed event that covers more than one day. */
export function isBannerEvent(ev: EventInstance): boolean {
  if (ev.all_day) return true
  return !isSameDay(bannerStartDay(ev), bannerEndDay(ev))
}

/** All-day events are stored as UTC instants (`<date>T00:00:00Z` … `<date>
 *  T23:59:59Z`) but stand for whole calendar dates. Reading them in local time
 *  shifts the day (e.g. 23:59Z becomes the next day at GMT+2, or 00:00Z the
 *  previous day at GMT-5), so we take the date in UTC and rebuild it at local
 *  midnight — timezone-safe on either side of UTC. */
function allDayLocal(iso: string): Date {
  const d = toDate(iso)
  return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
}

/** The first day an event covers (local midnight). */
export function bannerStartDay(ev: EventInstance): Date {
  return ev.all_day ? allDayLocal(ev.starts_at) : startOfDay(toDate(ev.starts_at))
}

/** The inclusive last day an event covers. A timed event ending exactly at
 *  midnight does not reach into that following day, so it is pulled back a day. */
export function bannerEndDay(ev: EventInstance): Date {
  if (ev.all_day) return allDayLocal(ev.ends_at)
  const e = toDate(ev.ends_at)
  if (e.getHours() === 0 && e.getMinutes() === 0 && e.getSeconds() === 0) {
    return startOfDay(addDays(e, -1))
  }
  return startOfDay(e)
}

/** A laid-out banner segment, clipped to the visible `days` and assigned a row. */
export interface BannerSeg {
  ev:              EventInstance
  startCol:        number   // inclusive index into `days`
  endCol:          number   // inclusive index into `days`
  continuesBefore: boolean  // event starts before the first visible day
  continuesAfter:  boolean  // event ends after the last visible day
  row:             number   // stacking row (0 = top)
}

/** Lay banner events over a contiguous-or-gapped `days` array: clip each to the
 *  visible range, then greedily stack overlapping ones into rows so no two bars
 *  on the same row touch. `days` may skip week-ends (Week view): columns are
 *  matched by day, so a bar simply spans the visible columns it covers. */
export function layoutBanners(events: EventInstance[], days: Date[]): { segs: BannerSeg[]; rows: number } {
  if (days.length === 0) return { segs: [], rows: 0 }
  const dayTimes = days.map(d => startOfDay(d).getTime())
  const first = dayTimes[0]
  const last  = dayTimes[dayTimes.length - 1]

  const items = events
    .filter(isBannerEvent)
    .map(ev => ({ ev, s: bannerStartDay(ev).getTime(), e: bannerEndDay(ev).getTime() }))
    .filter(it => it.e >= first && it.s <= last)
    // Longer, earlier events first so they take the top rows (like Google).
    .sort((a, b) => a.s - b.s || b.e - a.e)

  const rowsEnd: number[] = []   // last endCol occupied on each row
  const segs: BannerSeg[] = []
  for (const it of items) {
    const continuesBefore = it.s < first
    const continuesAfter  = it.e > last
    // First visible column at or after the start; last at or before the end.
    let startCol = continuesBefore ? 0 : dayTimes.findIndex(t => t >= it.s)
    let endCol = continuesAfter ? days.length - 1 : (() => {
      let idx = -1
      for (let i = 0; i < dayTimes.length; i++) if (dayTimes[i] <= it.e) idx = i
      return idx
    })()
    if (startCol < 0 || endCol < 0 || startCol > endCol) continue
    let row = 0
    while (row < rowsEnd.length && rowsEnd[row] >= startCol) row++
    rowsEnd[row] = endCol
    segs.push({ ev: it.ev, startCol, endCol, continuesBefore, continuesAfter, row })
  }
  return { segs, rows: rowsEnd.length }
}
