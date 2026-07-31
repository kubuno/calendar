import { useState, useMemo, useEffect, useCallback, useRef, Fragment } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueries, useMutation, useQueryClient } from '@tanstack/react-query'
import { useCalendarStore, type ViewMode } from './store'
import {
  X, Calendar as CalendarIcon,
  Clock, MapPin, Search, Plus, Edit2, Copy, Trash2, Bell,
  Mail, Share2, AlignLeft, Check, User as UserIcon,
  MoreVertical, Printer, Link2, Lock, Globe,
  Repeat, Users, Briefcase, ChevronDown, Pipette, Video, Tag,
  LayoutGrid, Home, Building, Building2,
} from 'lucide-react'
import { useAuthStore } from '@kubuno/sdk'
import { FloatingWindow, MenuDropdown, type MenuItem, type MenuDropdownPos } from '@ui'
import { Dropdown, Checkbox, Button, DatePicker, Input, RichText, ColorPicker, useAppPickerTheme, useIsMobile } from '@ui'
import {
  format, startOfMonth, endOfMonth, startOfWeek, endOfWeek,
  eachDayOfInterval, isSameMonth, isToday,
  isSameDay, parseISO, addDays, startOfDay, endOfDay,
  startOfYear, endOfYear, getDay, subYears, addYears,
} from 'date-fns'
import DOMPurify from 'dompurify'
import { getDateLocale } from '@kubuno/sdk'
import {
  calendarApi, weatherApi, wmoInfo, weatherIconUrl, appointmentApi,
  type Calendar, type EventInstance, type DailyWeather,
  type EventReminder, type AppointmentSchedule,
} from './api'
import { ExtensionRegistry, ModuleServiceRegistry } from '@kubuno/sdk'
import { CALENDAR_OVERLAY, type CalendarOverlayItem, type CalendarOverlayProvider } from '@kubuno/sdk'
import {
  useCalendarSettings, timePattern, hourPattern, workDayFor, isWorkingHour,
  type CalendarSettings, type WeekStart, type WorkLocation,
} from './calendarSettings'
import { buildRrule, presetFromRrule, describeRrule } from './rrule'
import { copyKubunoData, eventEnvelope, openLabelPicker } from './kubunoData'
import RecurrenceCustomDialog from './RecurrenceCustomDialog'
import { MonoText } from './MonoText'
import {
  MoonIcon, PrincipalMoonIcon, moonPhase, moonIllumination,
  moonPhaseName, principalPhaseOfDay, principalPhaseName,
} from './moon'
import { Link, useParams, useNavigate, useLocation } from 'react-router-dom'
import { APPT_GUTTER, APPT_PREFIX, isBannerEvent, isCalendarLocked, isOffWorkHour, isWeekend, layoutDayEvents, useNowTick } from './calendarUtils'
import { WorkLocationBand } from './WorkLocation'
import { AvailabilityStrip } from './AvailabilityStrip'
import { BannerRow } from './EventBanners'

export function DayView({ date, events, calendars, onEventClick, onEventContextMenu, onEventDrop, onEventResize, onRangeCreate, weatherByDate }: {
  date: Date; events: EventInstance[]; calendars: Calendar[]
  onEventClick: (ev: EventInstance) => void
  onEventContextMenu: (e: React.MouseEvent, ev: EventInstance) => void
  onEventDrop: (ev: EventInstance, newStart: Date) => void
  onEventResize: (ev: EventInstance, newStart: Date, newEnd: Date) => void
  onRangeCreate: (start: Date, end: Date) => void
  weatherByDate: Map<string, DailyWeather>
}) {
  const { t, i18n } = useTranslation('calendar')
  const settings = useCalendarSettings()
  const tPattern = timePattern(settings.timeFormat)
  const hours    = Array.from({ length: 24 }, (_, i) => i)
  const calMap   = useMemo(() => new Map(calendars.map(c => [c.id, c])), [calendars])
  const weekend  = isWeekend(date)
  const dayEvs0  = events.filter(ev => !isBannerEvent(ev) && isSameDay(parseISO(ev.starts_at), date))
  const apptEvs  = dayEvs0.filter(ev => ev.event_id.startsWith(APPT_PREFIX))
  const dayEvs   = dayEvs0.filter(ev => !ev.event_id.startsWith(APPT_PREFIX))
  const apptPad  = apptEvs.length ? APPT_GUTTER : 0
  const dateKey  = format(date, 'yyyy-MM-dd')
  const wx       = weatherByDate.get(dateKey) ?? null
  const [dragging, setDragging] = useState<EventInstance | null>(null)
  const [ghostMin, setGhostMin] = useState<number | null>(null)
  // Synchronous ref: onDragOver/onDrop don't depend on `dragging` re-render timing
  // (otherwise the first dragovers see null, skip preventDefault, and the drop never lands).
  const draggingRef = useRef<EventInstance | null>(null)
  const ghostHeight = dragging ? Math.max(((parseISO(dragging.ends_at).getTime() - parseISO(dragging.starts_at).getTime()) / 3600000) * 40, 20) : 0

  // Vertical resize of an event (top/bottom handles → start/end).
  const PX_PER_HOUR = 40
  const [resize, setResize] = useState<{ id: string; startMin: number; endMin: number } | null>(null)
  const resizingRef = useRef(false)   // bloque le drag HTML5 pendant un resize
  const minOf = (iso: string) => { const d = parseISO(iso); return d.getHours() * 60 + d.getMinutes() }
  const startResize = (ev: EventInstance, edge: 'top' | 'bottom') => (e: React.PointerEvent) => {
    e.stopPropagation(); e.preventDefault()
    resizingRef.current = true
    const s0 = minOf(ev.starts_at), e0 = minOf(ev.ends_at)
    let cur = { startMin: s0, endMin: e0 }
    setResize({ id: ev.id, ...cur })
    const move = (me: PointerEvent) => {
      const deltaMin = Math.round(((me.clientY - e.clientY) / PX_PER_HOUR * 60) / 15) * 15
      if (edge === 'top') cur = { startMin: Math.max(0, Math.min(e0 - 15, s0 + deltaMin)), endMin: e0 }
      else                cur = { startMin: s0, endMin: Math.min(24 * 60, Math.max(s0 + 15, e0 + deltaMin)) }
      setResize({ id: ev.id, ...cur })
    }
    const up = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up)
      resizingRef.current = false
      setResize(null)
      if (cur.startMin !== s0 || cur.endMin !== e0) {
        const ns = new Date(date); ns.setHours(Math.floor(cur.startMin / 60), cur.startMin % 60, 0, 0)
        const ne = new Date(date); ne.setHours(Math.floor(cur.endMin / 60), cur.endMin % 60, 0, 0)
        onEventResize(ev, ns, ne)
      }
    }
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up)
  }
  const fmtMin = (m: number) => {
    const d = new Date(date); d.setHours(Math.floor(m / 60), m % 60, 0, 0)
    return format(d, tPattern)
  }

  // Creation by dragging on an empty grid area (single click = 1 h).
  const [creating, setCreating] = useState<{ startMin: number; endMin: number } | null>(null)
  const startCreate = (e: React.PointerEvent) => {
    if (e.button !== 0 || resizingRef.current) return
    if ((e.target as Element).closest('[data-event]')) return   // click on an event
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const m0 = Math.max(0, Math.min(24 * 60 - 15, Math.round(((e.clientY - rect.top) / PX_PER_HOUR * 60) / 15) * 15))
    let cur = { startMin: m0, endMin: m0 + 15 }
    let moved = false
    setCreating(cur)
    const move = (me: PointerEvent) => {
      const m = Math.max(0, Math.min(24 * 60, Math.round(((me.clientY - rect.top) / PX_PER_HOUR * 60) / 15) * 15))
      moved = true
      cur = m >= m0 + 15 ? { startMin: m0, endMin: m } : { startMin: Math.min(m, m0), endMin: m0 + 15 }
      setCreating(cur)
    }
    const up = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up)
      setCreating(null)
      const endMin = moved ? cur.endMin : Math.min(24 * 60, m0 + 60)
      const s = new Date(date); s.setHours(0, cur.startMin, 0, 0)
      const en = new Date(date); en.setHours(0, endMin, 0, 0)
      onRangeCreate(s, en)
    }
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up)
  }

  // Side-by-side layout of the overlaps.
  const layout = useMemo(() => layoutDayEvents(dayEvs), [dayEvs])

  // Secondary timezone (personal preference) + local timezone for the dual hour column.
  const secondaryTimezone = settings.secondaryTimezone
  const localTz = useMemo(() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone } catch { return 'UTC' } }, [])
  const tzOffsetLabel = (tz: string) => {
    try {
      const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' }).formatToParts(date)
      return parts.find(p => p.type === 'timeZoneName')?.value ?? ''
    } catch { return '' }
  }
  const tzHourLabel = (tz: string, h: number) => {
    const inst = new Date(date); inst.setHours(h, 0, 0, 0)
    try { return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: settings.timeFormat === '12h' }).format(inst) }
    catch { return '' }
  }

  // "Now" line (today only) — evolves in real time via the tick.
  const now     = useNowTick()
  const showNow = isToday(date)
  const nowTop  = (now.getHours() + now.getMinutes() / 60 + now.getSeconds() / 3600) * 40

  // Times (gutters + events) in DM Sans, digits aligned via `tabular-nums`.
  const MONO = "'DM Sans', ui-sans-serif, system-ui, sans-serif"

  // On mount / day change: snap the scroll to the current hour (today) or to
  // the early morning — instead of opening on midnight.
  const scrollRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const sc = scrollRef.current
    if (!sc) return
    const target = showNow
      ? Math.max(0, nowTop - sc.clientHeight / 2.5)
      : settings.dayStartHour * PX_PER_HOUR
    sc.scrollTop = target
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date.getTime(), settings.dayStartHour])

  // Render one hour-gutter column (hours of a given timezone). `withNow` adds
  // the red dot of the current time (local gutter only).
  const gutter = (labelFor: (h: number) => string, withNow = false) => (
    <div className="border-r border-border relative">
      {hours.map(h => (
        <div key={h} className="h-10 flex items-start justify-end pr-2 -mt-px pt-0.5">
          {h > 0 && <span className="text-[11px] text-text-tertiary -translate-y-1/2" style={{ fontFamily: MONO }}><MonoText>{labelFor(h)}</MonoText></span>}
        </div>
      ))}
      {withNow && showNow && (
        <div className="absolute right-1 z-30 -translate-y-1/2 px-1 py-px rounded bg-danger text-white text-[10px] font-semibold pointer-events-none"
          style={{ top: nowTop, fontFamily: MONO }}>
          <MonoText>{format(now, tPattern)}</MonoText>
        </div>
      )}
    </div>
  )

  // Moon: preference + stable reference date (local noon of the displayed day).
  const moonOn = useCalendarStore(s => s.moonEnabled)
  const moonRefDate = useMemo(() => { const d = new Date(date); d.setHours(12, 0, 0, 0); return d }, [date])

  return (
    <div className="flex-1 overflow-hidden flex flex-col">
      {/* Header */}
      <div className={`border-b border-border shrink-0 py-3 text-center ${weekend ? 'bg-surface-1' : ''}`}>
        <div className={`text-sm font-medium capitalize ${isToday(date) ? 'text-primary' : weekend ? 'text-text-tertiary' : 'text-text-primary'}`}>
          {format(date, 'EEEE d MMMM yyyy', { locale: getDateLocale(i18n.language) })}
        </div>
        {/* Today's weather + moon */}
        {(wx || moonOn) && (
          <div className="flex items-center justify-center gap-2 mt-1 text-sm text-text-secondary">
            {wx && (<>
              <img src={weatherIconUrl(wx.weather_code, true)} alt="" width={24} height={24} style={{ width: 24, height: 24 }} draggable={false} />
              <span>{wmoInfo(wx.weather_code).label}</span>
              <span className="text-text-primary font-medium">{Math.round(wx.temp_max)}°</span>
              <span className="text-text-tertiary">/ {Math.round(wx.temp_min)}°</span>
              {wx.precip_prob_max > 10 && (
                <span className="text-blue-500 text-xs inline-flex items-center gap-0.5">
                  <img src="/weather-icons/drop.svg" alt="" width={15} height={15} style={{ width: 15, height: 15 }} draggable={false} />
                  {wx.precip_prob_max}%
                </span>
              )}
            </>)}
            {/* Today's moon phase (local computation, at noon for stability) */}
            {moonOn && (<>
              {wx && <span className="text-text-tertiary/50">·</span>}
              <MoonIcon phase={moonPhase(moonRefDate)} size={17} />
              <span className="text-xs">{moonPhaseName(moonRefDate, t)}</span>
              <span className="text-text-tertiary text-xs tabular-nums">{Math.round(moonIllumination(moonRefDate) * 100)} %</span>
            </>)}
          </div>
        )}
      </div>

      {/* All-day / multi-day events as continuous bars (with an arrow end when
          the event runs beyond this day) */}
      <BannerRow days={[date]} events={events} calendars={calendars}
        gridCols={secondaryTimezone ? '52px 52px 1fr' : '60px 1fr'} leadingGutters={secondaryTimezone ? 2 : 1}
        onEventClick={onEventClick} onEventContextMenu={onEventContextMenu} />

      {/* Work-location band (thin all-day-style line under the header) */}
      <WorkLocationBand days={[date]} leadingGutters={secondaryTimezone ? 2 : 1} settings={settings}
        gridCols={secondaryTimezone ? '52px 52px 1fr' : '60px 1fr'} />

      {/* Grille horaire */}
      <div ref={scrollRef} className={`flex-1 overflow-y-auto ${weekend ? 'bg-surface-1/30' : ''}`}>
        {/* Timezone-label strip (only when a secondary timezone is set) */}
        {secondaryTimezone && (
          <div className="grid sticky top-0 z-30 bg-surface-0 border-b border-border"
            style={{ gridTemplateColumns: '52px 52px 1fr' }}>
            <div className="text-[10px] text-text-tertiary text-center py-1 truncate" title={secondaryTimezone}>{tzOffsetLabel(secondaryTimezone)}</div>
            <div className="text-[10px] text-text-tertiary text-center py-1 truncate" title={localTz}>{tzOffsetLabel(localTz)}</div>
            <div />
          </div>
        )}
        <div className="grid" style={{ minHeight: '960px', gridTemplateColumns: secondaryTimezone ? '52px 52px 1fr' : '60px 1fr' }}>
          {/* Secondary-timezone column (left) */}
          {secondaryTimezone && gutter(h => tzHourLabel(secondaryTimezone, h))}
          {/* Local-timezone column (adjacent to the grid) */}
          {gutter(h => { const d = new Date(date); d.setHours(h, 0, 0, 0); return format(d, hourPattern(settings.timeFormat)) }, true)}
          <div className="relative"
            onPointerDown={startCreate}
            onDragOver={e => { if (!draggingRef.current) return; e.preventDefault(); const rect = e.currentTarget.getBoundingClientRect(); const y = e.clientY - rect.top; let m = Math.round((y / 40 * 60) / 15) * 15; m = Math.max(0, Math.min(24 * 60 - 15, m)); setGhostMin(m) }}
            onDrop={e => { const drag = draggingRef.current; if (drag && ghostMin !== null) { e.preventDefault(); const ns = new Date(date); ns.setHours(Math.floor(ghostMin / 60), ghostMin % 60, 0, 0); onEventDrop(drag, ns) } draggingRef.current = null; setDragging(null); setGhostMin(null) }}>
            {/* Hour lines + half-hour dotted line. Hours outside the day's
                working ranges are shaded (opt-in preference). */}
            {hours.map(h => (
              <div key={h}
                className={`h-10 border-b border-border/60 relative
                            ${isOffWorkHour(date, h, settings) ? 'bg-surface-2/70' : ''}`}>
                <div className="absolute left-0 right-0 top-1/2 border-b border-dashed border-border/40" />
              </div>
            ))}
            {dragging && ghostMin !== null && (
              <div className="absolute left-1 right-1 rounded bg-primary/20 border border-dashed border-primary pointer-events-none z-20"
                style={{ top: ghostMin * 40 / 60, height: ghostHeight }}>
                <div className="text-xs font-medium text-primary px-2" style={{ fontFamily: MONO }}><MonoText>{fmtMin(ghostMin)}</MonoText></div>
              </div>
            )}
            {/* Range being created (dragging on an empty area) */}
            {creating && (
              <div className="absolute left-1 right-1 rounded bg-primary/15 border border-primary pointer-events-none z-20"
                style={{ top: creating.startMin * PX_PER_HOUR / 60, height: Math.max((creating.endMin - creating.startMin) / 60 * PX_PER_HOUR, 10) }}>
                <div className="text-xs font-medium text-primary px-2" style={{ fontFamily: MONO }}>
                  <MonoText>{fmtMin(creating.startMin)}</MonoText> – <MonoText>{fmtMin(creating.endMin)}</MonoText>
                </div>
              </div>
            )}
            {dayEvs.map(ev => {
              const start  = parseISO(ev.starts_at)
              const end    = parseISO(ev.ends_at)
              const cal    = calMap.get(ev.calendar_id)
              const color  = ev.color ?? cal?.color ?? '#4D38DB'
              const past   = settings.dimPastEvents && end < now
              // During a resize, preview with the minutes being edited.
              const isResizing = resize?.id === ev.id
              const sMin   = isResizing ? resize!.startMin : start.getHours() * 60 + start.getMinutes()
              const eMin   = isResizing ? resize!.endMin   : end.getHours()   * 60 + end.getMinutes()
              const top    = sMin / 60 * PX_PER_HOUR
              // "Short events at the size of a 30-minute one" raises the floor.
              const height = Math.max((eMin - sMin) / 60 * PX_PER_HOUR, settings.minEventHeight ? PX_PER_HOUR / 2 : 20)
              // Overlaps: each event takes its own column within the cluster.
              const pos     = layout.get(ev.id) ?? { leftPct: 0, widthPct: 100 }
              const compact = height < 38   // short block → single line "Title · 09:00"
              const locked  = isCalendarLocked(cal)   // lecture seule / abonnement
              return (
                <div key={ev.id}
                  data-event
                  draggable={!locked}
                  onDragStart={e => { if (locked || resizingRef.current) { e.preventDefault(); return } draggingRef.current = ev; setDragging(ev) }}
                  onDragEnd={() => { draggingRef.current = null; setDragging(null); setGhostMin(null) }}
                  onClick={() => { if (!isResizing) onEventClick(ev) }}
                  onContextMenu={e => onEventContextMenu(e, ev)}
                  title={`${ev.title} · ${fmtMin(sMin)} – ${fmtMin(eMin)}`}
                  style={{
                    top, height,
                    // Past: light tint + colored text (instead of the solid block).
                    backgroundColor: past ? color + '2b' : color,
                    color: past ? color : '#ffffff',
                    opacity: dragging?.id === ev.id ? 0.4 : 1,
                    left: `calc(${pos.leftPct}% + ${4 + apptPad}px)`, width: `calc(${pos.widthPct}% - ${8 + apptPad}px)`,
                  }}
                  className="absolute rounded-md px-2 py-0.5 cursor-pointer overflow-hidden group
                             shadow-sm ring-1 ring-surface-0/60 transition-[box-shadow,filter] duration-100
                             hover:shadow-md hover:brightness-[1.04] hover:z-10 active:cursor-grabbing">
                  {/* Resize handle — top (start time) */}
                  {!locked && <div onPointerDown={startResize(ev, 'top')} onClick={e => e.stopPropagation()} draggable={false}
                    className="absolute top-0 left-0 right-0 h-2 cursor-ns-resize z-10" />}
                  <div className="text-xs font-semibold truncate leading-snug">
                    {ev.title}
                    {compact && <span className="font-normal opacity-85 text-xs" style={{ fontFamily: MONO }}> · <MonoText>{fmtMin(sMin)}</MonoText></span>}
                  </div>
                  {!compact && (
                    <div className="text-xs truncate opacity-85" style={{ fontFamily: MONO }}>
                      <MonoText>{fmtMin(sMin)}</MonoText> – <MonoText>{fmtMin(eMin)}</MonoText>
                    </div>
                  )}
                  {!compact && ev.location && <div className="text-xs truncate opacity-80">{ev.location}</div>}
                  {/* Resize handle — bottom (end time) */}
                  {!locked && <div onPointerDown={startResize(ev, 'bottom')} onClick={e => e.stopPropagation()} draggable={false}
                    className="absolute bottom-0 left-0 right-0 h-2 cursor-ns-resize z-10" />}
                </div>
              )
            })}
            {/* Availability bands (appointment schedules) — read-only */}
            {apptEvs.map(ev => {
              const start = parseISO(ev.starts_at), end = parseISO(ev.ends_at)
              const sMin = start.getHours() * 60 + start.getMinutes()
              const eMin = end.getHours() * 60 + end.getMinutes()
              return <AvailabilityStrip key={ev.id} ev={ev} sMin={sMin}
                top={sMin / 60 * PX_PER_HOUR} height={Math.max((eMin - sMin) / 60 * PX_PER_HOUR, 20)}
                onClick={() => onEventClick(ev)} />
            })}
            {/* "Now" line — dot and line vertically centered on the current time */}
            {showNow && (
              <div className="absolute left-0 right-0 z-20 pointer-events-none flex items-center"
                style={{ top: nowTop, transform: 'translateY(-50%)' }}>
                <div className="w-2.5 h-2.5 rounded-full bg-danger -ml-1.5 shrink-0" />
                <div className="flex-1 h-0.5 bg-danger" />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Week view ─────────────────────────────────────────────────────────────────

