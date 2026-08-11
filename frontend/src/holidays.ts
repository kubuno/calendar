// Public holidays, read from the core.
//
// The calendar owns no holiday data and knows no country: it asks the core what
// applies to the person looking at the screen (`/holidays/applicable`) and then
// asks for the days in the visible range. That is the whole integration — the
// referential, its corrections and the per-unit adjustments all live in the
// core, so nothing here has to be kept in step with them.
//
// The days are turned into ordinary all-day `EventInstance`s so that every view
// renders them with no special case: the month grid, the week strip, the year
// view and the schedule list all already know how to draw an all-day event.
// They carry a synthetic calendar id (`holidays:FR`), which is what makes the
// sidebar checkbox work through the same `hiddenCalendarIds` mechanism as a
// real calendar.

import { useQuery } from '@tanstack/react-query'
import { api, i18n } from '@kubuno/sdk'
import type { EventInstance } from './api'

/** Prefix of the synthetic calendar ids. */
export const HOLIDAY_CALENDAR_PREFIX = 'holidays:'
/** Prefix of the synthetic event ids — a click must not open an editor. */
export const HOLIDAY_EVENT_PREFIX = 'holiday:'

/** Green, and the same green for every territory: a holiday is one kind of
 *  thing, and colouring France differently from Belgium would suggest the
 *  difference matters more than it does. */
export const HOLIDAY_COLOR = '#0b8043'

export interface HolidayOccurrence {
  date:          string
  name:          string
  key:           string
  category:      string
  calendar_code: string
  calendar_name: string
  color:         string | null
  observed_from?: string
}

export interface ApplicableCalendars {
  codes:    string[]
  /** `setting` — somebody posted it; `timezone` — deduced; `unknown` — neither. */
  source:   'setting' | 'timezone' | 'unknown'
  timezone: string
  calendars: { code: string; name: string }[]
}

export const holidaysApi = {
  applicable: async (): Promise<ApplicableCalendars> => {
    const { data } = await api.get('/holidays/applicable', { params: { locale: locale() } })
    return data
  },

  feed: async (from: string, to: string, calendars?: string): Promise<HolidayOccurrence[]> => {
    const params: Record<string, string> = { from, to, locale: locale() }
    if (calendars) params.calendars = calendars
    const { data } = await api.get('/holidays', { params })
    return data.holidays ?? []
  },
}

/**
 * The language the names come back in.
 *
 * Sent explicitly rather than left to the server's resolution: the browser knows
 * which language this person is reading right now, while the account's stored
 * locale may simply never have been set — and an instance that was installed in
 * English would otherwise answer "Christmas Day" to a French interface.
 */
function locale(): string {
  return i18n.language || 'en'
}

export const holidayCalendarId = (code: string) => `${HOLIDAY_CALENDAR_PREFIX}${code}`

/** `YYYY-MM-DD`, in local time — the feed speaks calendar days, not instants. */
function isoDay(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/**
 * One occurrence as an all-day event.
 *
 * `ends_at` is the same day and not the next: this product's all-day events are
 * inclusive on both ends (see the month grid), and an exclusive end would paint
 * every holiday over two days.
 */
function toEvent(occurrence: HolidayOccurrence): EventInstance {
  const start = new Date(`${occurrence.date}T00:00:00`)
  const end   = new Date(`${occurrence.date}T23:59:59`)
  const id    = `${HOLIDAY_EVENT_PREFIX}${occurrence.calendar_code}:${occurrence.key}:${occurrence.date}`
  return {
    id,
    event_id:     id,
    calendar_id:  holidayCalendarId(occurrence.calendar_code),
    owner_id:     '',
    title:        occurrence.name,
    // What the day commemorates, when it was moved off a weekend. Written into
    // the description because that is where every view already looks for the
    // one line under a title.
    description:  occurrence.observed_from ? `${occurrence.calendar_name} — ${occurrence.observed_from}` : occurrence.calendar_name,
    location:     null,
    starts_at:    start.toISOString(),
    ends_at:      end.toISOString(),
    all_day:      true,
    is_recurring: false,
    rrule:        null,
    status:       'confirmed',
    visibility:   'public',
    // Free, not busy: a public holiday must never make somebody look booked in
    // a free/busy lookup — it says the office is closed, not that they are in a
    // meeting.
    busy:         false,
    ical_uid:     id,
    etag:         '',
    color:        occurrence.color ?? HOLIDAY_COLOR,
    reminders:    [],
  }
}

/** The territories that apply to the reader — cached, since they change rarely. */
export function useApplicableHolidayCalendars(enabled: boolean) {
  return useQuery({
    queryKey: ['calendar-holidays-applicable'],
    queryFn:  holidaysApi.applicable,
    enabled,
    staleTime: 5 * 60_000,
  })
}

/**
 * The holidays of the visible range, as events.
 *
 * `override` is the module preference: a person who works across a border says
 * so here, and the core's resolution is bypassed. Empty means "follow the core",
 * which is the case for everybody who never had an opinion.
 */
export function useHolidayEvents(
  from: Date,
  to: Date,
  options: { enabled: boolean; override: string },
): EventInstance[] {
  const fromDay = isoDay(from)
  const toDay   = isoDay(to)

  const { data } = useQuery({
    queryKey: ['calendar-holidays', fromDay, toDay, options.override],
    queryFn:  () => holidaysApi.feed(fromDay, toDay, options.override || undefined),
    enabled:  options.enabled,
    staleTime: 5 * 60_000,
  })

  return (data ?? []).map(toEvent)
}
