/**
 * "Find a time": the calendars, side by side, with the meeting drawn on them.
 *
 * ## Why a grid and not a list of proposals
 *
 * The tab used to answer a different question. It asked for a date range and
 * office hours, then printed a list of slots where everybody happened to be
 * free. That is an answer, but it is not the one an organiser is holding in
 * their head: they are looking at a week, they know Thursday morning is the
 * only moment that works politically, and they want to see what stands in the
 * way of it. A list cannot show that. The grid can — the meeting is a block you
 * move over everyone's calendars until it lands somewhere empty.
 *
 * ## What is drawn
 *
 * - The organiser's own events, as they are in the calendar.
 * - Where a guest is BUSY, as a hatched band across the column. It is a band
 *   rather than a copy of their event on purpose: free/busy is all the instance
 *   is allowed to tell us about someone else's day, and drawing a block that
 *   looks like an event would promise a title we do not have.
 * - The meeting being scheduled, as a movable block. Clicking anywhere in a
 *   column moves it there; dragging it does the same continuously. Its duration
 *   never changes here — the hour is what this tab is for.
 *
 * Guests whose availability the instance will not disclose are counted and
 * named at the foot of the grid: an empty column must never be read as "free".
 */
import { useState, useMemo, useEffect, useRef, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { ChevronLeft, ChevronRight, Check, SlidersHorizontal } from 'lucide-react'
import { MenuDropdown, useMenuDropdown, type MenuItem } from '@ui'
import { useAuthStore, toDate, toISODate, formatDate, addDays, isSameDay, isToday } from '@kubuno/sdk'
import { calendarApi, type Calendar, type EventInstance } from './api'
import { useCalendarSettings } from './calendarSettings'
import { useUserTimezone, tzOffsetLabel, tzTime } from './timezones'
import { isBannerEvent, layoutDayEvents } from './calendarUtils'

/** One hour of grid, in pixels. */
const HOUR_H = 44
/** The grain a dropped meeting snaps to. */
const SNAP_MIN = 15

type Mode = 'day' | 'week'
/**
 * Whose busy time is drawn.
 *
 * Two values, not three. The reference tab also offers "required guests only",
 * and rooms as rows of their own — neither is offered here, because neither
 * exists yet in this product: an attendee is not marked required or optional,
 * and a room answers for one slot at a time rather than for a range. A menu
 * entry that changes nothing is worse than an absent one, so they stay out
 * until the data behind them is real.
 */
type GuestScope = 'none' | 'all'

interface Band { from: number; to: number }

/** Minutes since midnight, for a date read in local time. */
const minutesOf = (d: Date) => d.getHours() * 60 + d.getMinutes()

/** The Monday (or Sunday, or Saturday) of the week `d` falls in. */
function startOfWeek(d: Date, weekStartsOn: number): Date {
  const out = new Date(d)
  out.setHours(0, 0, 0, 0)
  const shift = (out.getDay() - weekStartsOn + 7) % 7
  out.setDate(out.getDate() - shift)
  return out
}

export function ScheduleGrid({ start, end, calendars, eventId, onPick }: {
  /** The meeting as it currently stands. */
  start: Date
  end:   Date
  calendars: Calendar[]
  /** The meeting being edited, if it exists yet — its guest list is what the
   *  busy bands are computed from. A meeting still being composed has guests
   *  that are addresses, not accounts, and an address cannot be cross-referenced
   *  without asking the directory who it belongs to; until that lookup exists,
   *  a new meeting is drawn against the organiser's own calendar alone. */
  eventId?: string
  /** A new hour was chosen. The duration is carried over unchanged. */
  onPick: (start: Date, end: Date) => void
}) {
  const { t } = useTranslation('calendar')
  const settings = useCalendarSettings()
  const tz       = useUserTimezone()
  const me       = useAuthStore(s => s.user)
  const hour12   = settings.timeFormat === '12h'

  const [mode,   setMode]   = useState<Mode>('day')
  const [anchor, setAnchor] = useState<Date>(() => { const d = new Date(start); d.setHours(0, 0, 0, 0); return d })
  const [scope,  setScope]  = useState<GuestScope>('all')
  const filterMenu = useMenuDropdown()

  const durationMs = Math.max(15 * 60_000, end.getTime() - start.getTime())

  // Who the grid answers for. A room is an attendee too, but it has no calendar
  // of its own here — it answers through the room list.
  const attendeesQ = useQuery({
    enabled:  Boolean(eventId),
    queryKey: ['schedule-grid-attendees', eventId],
    queryFn:  () => calendarApi.listAttendees(eventId!),
  })
  const attendeeIds = useMemo(
    () => (attendeesQ.data?.attendees ?? [])
      .filter(a => !a.resource_id && !a.is_organizer)
      .map(a => a.user_id)
      .filter((id): id is string => Boolean(id)),
    [attendeesQ.data],
  )

  const days = useMemo(() => {
    if (mode === 'day') return [anchor]
    const first = startOfWeek(anchor, settings.weekStartsOn)
    return Array.from({ length: 7 }, (_, i) => addDays(first, i))
  }, [mode, anchor, settings.weekStartsOn])

  const from = days[0]
  const to   = addDays(days[days.length - 1], 1)

  // ── What is already on the calendars ───────────────────────────────────────

  const eventsQ = useQuery({
    queryKey: ['schedule-grid-events', from.toISOString(), to.toISOString()],
    queryFn:  () => calendarApi.listEvents(from.toISOString(), to.toISOString()),
  })

  // Free/busy for the guests. The endpoint answers with the ranges where
  // EVERYONE is free, so the busy bands are its complement — which is exactly
  // what an organiser needs to see, and it costs no new endpoint.
  const busyQ = useQuery({
    enabled:  scope !== 'none' && attendeeIds.length > 0 && Boolean(me?.id),
    queryKey: ['schedule-grid-busy', from.toISOString(), to.toISOString(), attendeeIds.join(',')],
    queryFn:  () => calendarApi.findCommonSlots({
      from: from.toISOString(), until: to.toISOString(),
      user_ids: [me!.id, ...attendeeIds],
    }),
  })

  const hiddenCount = busyQ.data?.hidden_user_ids?.length ?? 0

  /** Busy bands per day key, in minutes since that day's midnight. */
  const busyByDay = useMemo(() => {
    const out = new Map<string, Band[]>()
    if (!busyQ.data) return out
    const free = busyQ.data.slots
      .filter(s => s.score >= 0.999)
      .map(s => ({ from: toDate(s.starts_at).getTime(), to: toDate(s.ends_at).getTime() }))
      .sort((a, b) => a.from - b.from)
    for (const day of days) {
      const dayStart = new Date(day).setHours(0, 0, 0, 0)
      const dayEnd   = dayStart + 24 * 3600_000
      const bands: Band[] = []
      let cursor = dayStart
      for (const f of free) {
        if (f.to <= dayStart || f.from >= dayEnd) continue
        const s = Math.max(f.from, dayStart)
        if (s > cursor) bands.push({ from: (cursor - dayStart) / 60_000, to: (s - dayStart) / 60_000 })
        cursor = Math.max(cursor, Math.min(f.to, dayEnd))
      }
      if (cursor < dayEnd) bands.push({ from: (cursor - dayStart) / 60_000, to: 1440 })
      out.set(toISODate(day), bands)
    }
    return out
  }, [busyQ.data, days])

  const calMap = useMemo(() => new Map(calendars.map(c => [c.id, c])), [calendars])
  const timed  = useMemo(
    () => (eventsQ.data?.events ?? []).filter(ev => !isBannerEvent(ev)),
    [eventsQ.data],
  )

  // ── Moving the meeting ─────────────────────────────────────────────────────

  const bodyRef = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<{ day: Date; minutes: number } | null>(null)

  /** Where in the day a pointer landed, snapped. Bounded so a meeting never
   *  starts after the day ends. */
  const minutesAt = useCallback((el: HTMLElement, clientY: number) => {
    const box = el.getBoundingClientRect()
    const raw = ((clientY - box.top) / HOUR_H) * 60
    const snapped = Math.round(raw / SNAP_MIN) * SNAP_MIN
    return Math.max(0, Math.min(1440 - durationMs / 60_000, snapped))
  }, [durationMs])

  const place = (day: Date, minutes: number) => {
    const s = new Date(day)
    s.setHours(0, minutes, 0, 0)
    onPick(s, new Date(s.getTime() + durationMs))
  }

  // Dragging is tracked on the window so the pointer may leave the column
  // without the block being dropped where it was last seen.
  useEffect(() => {
    if (!drag) return
    const move = (e: PointerEvent) => {
      const col = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-day]') as HTMLElement | null
      if (!col) return
      const day = new Date(col.dataset.day!)
      setDrag({ day, minutes: minutesAt(col, e.clientY) })
    }
    const up = () => { setDrag(d => { if (d) place(d.day, d.minutes); return null }) }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up, { once: true })
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag !== null, minutesAt])

  // Open on the meeting, not on midnight: an editor that starts the grid at
  // 00:00 asks the reader to scroll to their own event.
  useEffect(() => {
    const el = bodyRef.current
    if (!el) return
    el.scrollTop = Math.max(0, (minutesOf(start) / 60 - 1) * HOUR_H)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Chrome ─────────────────────────────────────────────────────────────────

  const step = (dir: -1 | 1) => setAnchor(a => addDays(a, mode === 'day' ? dir : 7 * dir))

  const rangeLabel = mode === 'day'
    ? formatDate(anchor, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
    : `${formatDate(days[0], { day: 'numeric', month: 'long' })} – ${formatDate(days[6], { day: 'numeric', month: 'long', year: 'numeric' })}`

  const filterItems: MenuItem[] = [
    { type: 'label', text: t('sched_guests_shown', { defaultValue: 'Disponibilité affichée' }) },
    { type: 'action', label: t('sched_no_guests',  { defaultValue: 'Aucun invité' }),     checked: scope === 'none', onClick: () => setScope('none') },
    { type: 'action', label: t('sched_all_guests', { defaultValue: 'Tous les invités' }), checked: scope === 'all',  onClick: () => setScope('all') },
  ]

  const hours = Array.from({ length: 24 }, (_, i) => i)
  const secondary = settings.secondaryTimezone

  const segment = (value: Mode, label: string) => (
    <button type="button" onClick={() => setMode(value)}
      className={`flex items-center gap-1.5 px-4 h-8 text-sm transition-colors ${
        mode === value ? 'bg-primary/10 text-primary' : 'text-text-secondary hover:bg-surface-1'}`}>
      {mode === value && <Check size={14} />}
      {label}
    </button>
  )

  return (
    <div className="flex flex-col">
      {/* Toolbar */}
      {/* One row, always: the controls on the left, the view on the right. The
          date label is what gives way when the card is narrow — it is the only
          thing here that can be read from the grid itself. */}
      <div className="flex items-center gap-2 px-6 py-3">
        <button type="button"
          onClick={() => { const d = new Date(); d.setHours(0, 0, 0, 0); setAnchor(d) }}
          className="h-9 rounded-full border border-border px-4 text-sm text-text-primary hover:bg-surface-1">
          {t('today', { defaultValue: 'Aujourd’hui' })}
        </button>
        <button type="button" onClick={() => step(-1)} aria-label={t('previous', { defaultValue: 'Précédent' })}
          className="grid h-8 w-8 place-items-center rounded-full text-text-secondary hover:bg-surface-1">
          <ChevronLeft size={18} />
        </button>
        <button type="button" onClick={() => step(1)} aria-label={t('next', { defaultValue: 'Suivant' })}
          className="grid h-8 w-8 place-items-center rounded-full text-text-secondary hover:bg-surface-1">
          <ChevronRight size={18} />
        </button>
        <span className="min-w-0 truncate text-sm text-text-primary first-letter:uppercase">{rangeLabel}</span>

        <span className="ms-auto flex shrink-0 items-center gap-2">
          <span className="flex overflow-hidden rounded-full border border-border">
            {segment('day',  t('view_day',  { defaultValue: 'Jour' }))}
            {segment('week', t('view_week', { defaultValue: 'Semaine' }))}
          </span>
          <button type="button" onClick={filterMenu.open}
            title={t('sched_filter_view', { defaultValue: 'Filtrer et afficher' })}
            className="grid h-8 w-8 place-items-center rounded-full text-text-secondary hover:bg-surface-1">
            <SlidersHorizontal size={17} />
          </button>
          {filterMenu.pos && <MenuDropdown pos={filterMenu.pos} onClose={filterMenu.close} items={filterItems} />}
        </span>
      </div>

      {/* Day headers, held above the scroll so they stay legible while reading
          down the hours. */}
      <div className="flex px-6">
        <div className="shrink-0 pb-1" style={{ width: secondary ? 108 : 58 }}>
          <div className="flex gap-2 text-[10.5px] leading-none text-text-tertiary">
            <span className="w-12 text-end">{tzOffsetLabel(tz)}</span>
            {secondary && <span className="w-12 text-end">{tzOffsetLabel(secondary)}</span>}
          </div>
        </div>
        {days.map(d => (
          <div key={d.toISOString()} className="flex-1 pb-2 text-center">
            <div className="text-[10.5px] uppercase tracking-wide text-text-tertiary">
              {formatDate(d, 'weekdayShort')}
            </div>
            <div className={`text-xl leading-tight ${isToday(d) ? 'text-primary' : 'text-text-primary'}`}>
              {d.getDate()}
            </div>
          </div>
        ))}
      </div>

      {/* The grid */}
      <div ref={bodyRef} className="overflow-y-auto px-6 pb-4" style={{ maxHeight: 460 }}>
        <div className="flex">
          {/* Hour gutter — one column per zone the reader asked for. */}
          <div className="shrink-0" style={{ width: secondary ? 108 : 58 }}>
            {hours.map(h => {
              const at = new Date(days[0]); at.setHours(h, 0, 0, 0)
              return (
                <div key={h} className="relative flex gap-2 text-[11px] text-text-tertiary" style={{ height: HOUR_H }}>
                  <span className="w-12 -translate-y-1.5 text-end">{tzTime(tz, at, hour12)}</span>
                  {secondary && <span className="w-12 -translate-y-1.5 text-end">{tzTime(secondary, at, hour12)}</span>}
                </div>
              )
            })}
          </div>

          {days.map(day => {
            const key    = toISODate(day)
            const dayEvs = timed.filter(ev => isSameDay(toDate(ev.starts_at), day))
            const lay    = layoutDayEvents(dayEvs)
            const bands  = busyByDay.get(key) ?? []
            const ghost  = drag && isSameDay(drag.day, day) ? drag.minutes
              : !drag && isSameDay(start, day) ? minutesOf(start) : null
            return (
              <div key={key} data-day={day.toISOString()}
                onPointerDown={e => {
                  if ((e.target as HTMLElement).closest('[data-ghost]')) return
                  const col = e.currentTarget
                  setDrag({ day, minutes: minutesAt(col, e.clientY) })
                }}
                className="relative flex-1 border-s border-border"
                style={{ height: 24 * HOUR_H }}>
                {/* Hour rules */}
                {hours.map(h => (
                  <div key={h} className="absolute inset-x-0 border-t border-border/70" style={{ top: h * HOUR_H }} />
                ))}
                {/* Guests' busy time — free/busy, not their events. */}
                {bands.map((b, i) => (
                  <div key={i} className="kb-sched-busy absolute inset-x-0"
                    style={{ top: (b.from / 60) * HOUR_H, height: Math.max(2, ((b.to - b.from) / 60) * HOUR_H) }} />
                ))}
                {/* The organiser's own events */}
                {dayEvs.map(ev => {
                  const s = toDate(ev.starts_at), e = toDate(ev.ends_at)
                  const top = (minutesOf(s) / 60) * HOUR_H
                  const h   = Math.max(16, ((e.getTime() - s.getTime()) / 3600_000) * HOUR_H)
                  const col = ev.color ?? calMap.get(ev.calendar_id)?.color ?? '#1a73e8'
                  const pos = lay.get(ev.event_id)
                  return (
                    <div key={ev.event_id}
                      className="absolute overflow-hidden rounded-e-sm px-1.5 text-[11px] leading-tight text-text-primary"
                      style={{
                        top, height: h,
                        left:  `${pos?.leftPct ?? 0}%`,
                        width: `${pos?.widthPct ?? 100}%`,
                        borderInlineStart: `3px solid ${col}`,
                        background: `${col}1f`,
                      }}>
                      <span className="truncate">{ev.title}, {formatDate(s, 'time')}</span>
                    </div>
                  )
                })}
                {/* The meeting being scheduled */}
                {ghost !== null && (
                  <div data-ghost
                    onPointerDown={e => { e.stopPropagation(); setDrag({ day, minutes: ghost }) }}
                    className="kb-sched-ghost absolute inset-x-1 cursor-grab rounded-sm px-2 text-[11px] leading-tight active:cursor-grabbing"
                    style={{ top: (ghost / 60) * HOUR_H, height: Math.max(18, (durationMs / 3600_000) * HOUR_H) }}>
                    {(() => { const s = new Date(day); s.setHours(0, ghost, 0, 0); return formatDate(s, 'time') })()}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>

      {hiddenCount > 0 && (
        <p className="px-6 pb-4 text-xs text-text-secondary">
          {t('sched_hidden_guests', {
            count: hiddenCount,
            defaultValue: '{{count}} invité(s) dont la disponibilité n’est pas visible : les plages libres ne les incluent pas.',
          })}
        </p>
      )}
    </div>
  )
}
