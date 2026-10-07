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
import { useAuthStore, toISODate, isoWeek, toDate, formatDate, addDays, startOfDay, startOfWeek, isSameDay, isToday, ExtensionRegistry, ModuleServiceRegistry, CALENDAR_OVERLAY, type CalendarOverlayItem, type CalendarOverlayProvider } from '@kubuno/sdk'
import { FloatingWindow, MenuDropdown, type MenuItem, type MenuDropdownPos } from '@ui'
import { Dropdown, Checkbox, Button, DatePicker, Input, RichText, ColorPicker, useAppPickerTheme, useIsMobile } from '@ui'
import DOMPurify from 'dompurify'
import {
  calendarApi, weatherApi, wmoInfo, weatherIconUrl, appointmentApi,
  type Calendar, type EventInstance, type DailyWeather,
  type EventReminder, type AppointmentSchedule,
} from './api'
import {
  useCalendarSettings, timePattern, hourPattern, workDayFor, isWorkingHour,
  type CalendarSettings, type WeekStart, type WorkLocation,
} from './calendarSettings'
import { buildRrule, presetFromRrule, describeRrule } from './rrule'
import { copyKubunoData, eventEnvelope, openLabelPicker } from './kubunoData'
import RecurrenceCustomDialog from './RecurrenceCustomDialog'
import { MonoText } from './MonoText'
import { useUserTimezone } from './timezones'
import {
  MoonIcon, PrincipalMoonIcon, moonPhase, moonIllumination,
  moonPhaseName, principalPhaseOfDay, principalPhaseName,
} from './moon'
import { Link, useParams, useNavigate, useLocation } from 'react-router-dom'
import { APPT_GUTTER, APPT_PREFIX, isBannerEvent, isCalendarLocked, isOffWorkHour, isWeekend, layoutDayEvents, useNowTick } from './calendarUtils'
import { WorkLocationBand } from './WorkLocation'
import { AvailabilityStrip } from './AvailabilityStrip'
import { BannerRow } from './EventBanners'

export function WeekView({ date, events, calendars, onEventClick, onEventContextMenu, onEventDrop, onEventResize, onRangeCreate, weatherByDate, dayCount }: {
  date: Date; events: EventInstance[]; calendars: Calendar[]
  onEventClick: (ev: EventInstance) => void
  onEventContextMenu: (e: React.MouseEvent, ev: EventInstance) => void
  onEventDrop: (ev: EventInstance, newStart: Date) => void
  onEventResize: (ev: EventInstance, newStart: Date, newEnd: Date) => void
  onRangeCreate: (start: Date, end: Date) => void
  weatherByDate: Map<string, DailyWeather>
  /** N-day "custom view": the strip starts on `date` instead of the week. */
  dayCount?: number
}) {
  const { t, i18n } = useTranslation('calendar')
  const settings  = useCalendarSettings()
  const tPattern  = timePattern(settings.timeFormat)
  const weekStart = dayCount ? startOfDay(date) : startOfWeek(date, settings.weekStartsOn )
  const days      = useMemo(() => {
    const all = Array.from({ length: dayCount ?? 7 }, (_, i) => addDays(weekStart, i))
    // Hiding week-ends only makes sense for the full week strip.
    return dayCount || settings.showWeekends ? all : all.filter(d => !isWeekend(d))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weekStart.getTime(), dayCount, settings.showWeekends])
  const hours     = Array.from({ length: 24 }, (_, i) => i)
  const calMap    = useMemo(() => new Map(calendars.map(c => [c.id, c])), [calendars])

  // Timed grid excludes banner events (all-day / multi-day): those render in the
  // continuous banner row under the headers instead.
  const eventsForDay = (day: Date) =>
    events.filter(ev => !isBannerEvent(ev) && isSameDay(toDate(ev.starts_at), day))

  const [dragging, setDragging] = useState<EventInstance | null>(null)
  const [ghost, setGhost] = useState<{ dayKey: string; min: number } | null>(null)
  const draggingRef = useRef<EventInstance | null>(null)   // ref synchrone (cf. DayView)
  const ghostHeight = dragging ? Math.max(((toDate(dragging.ends_at).getTime() - toDate(dragging.starts_at).getTime()) / 3600000) * 40, 20) : 0

  // Helpers shared with the Day view: timezones, font (DM Sans), real-time current time.
  const PX_PER_HOUR = 40
  const MONO = "'DM Sans', ui-sans-serif, system-ui, sans-serif"
  const now = useNowTick()
  const isMobile = useIsMobile()
  const secondaryTimezone = settings.secondaryTimezone
  const localTz = useUserTimezone()
  const tzOffsetLabel = (tz: string) => { try { return new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' }).formatToParts(date).find(p => p.type === 'timeZoneName')?.value ?? '' } catch { return '' } }
  const tzHourLabel = (tz: string, h: number) => { const inst = new Date(date); inst.setHours(h, 0, 0, 0); try { return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: settings.timeFormat === '12h' }).format(inst) } catch { return '' } }
  const fmtMin = (m: number) => {
    const d = new Date(date); d.setHours(Math.floor(m / 60), m % 60, 0, 0)
    return formatDate(d, tPattern)
  }
  const minOf = (iso: string) => { const d = toDate(iso); return d.getHours() * 60 + d.getMinutes() }
  const nowTop = (now.getHours() + now.getMinutes() / 60 + now.getSeconds() / 3600) * PX_PER_HOUR

  // Vertical resize (top/bottom handles → start/end) — per day.
  const [resize, setResize] = useState<{ id: string; startMin: number; endMin: number } | null>(null)
  const resizingRef = useRef(false)
  const startResize = (ev: EventInstance, day: Date, edge: 'top' | 'bottom') => (e: React.PointerEvent) => {
    e.stopPropagation(); e.preventDefault(); resizingRef.current = true
    const s0 = minOf(ev.starts_at), e0 = minOf(ev.ends_at)
    let cur = { startMin: s0, endMin: e0 }
    setResize({ id: ev.id, ...cur })
    const move = (me: PointerEvent) => {
      const d = Math.round(((me.clientY - e.clientY) / PX_PER_HOUR * 60) / 15) * 15
      if (edge === 'top') cur = { startMin: Math.max(0, Math.min(e0 - 15, s0 + d)), endMin: e0 }
      else                cur = { startMin: s0, endMin: Math.min(24 * 60, Math.max(s0 + 15, e0 + d)) }
      setResize({ id: ev.id, ...cur })
    }
    const up = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up)
      resizingRef.current = false; setResize(null)
      if (cur.startMin !== s0 || cur.endMin !== e0) {
        const ns = new Date(day); ns.setHours(Math.floor(cur.startMin / 60), cur.startMin % 60, 0, 0)
        const ne = new Date(day); ne.setHours(Math.floor(cur.endMin / 60), cur.endMin % 60, 0, 0)
        onEventResize(ev, ns, ne)
      }
    }
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up)
  }

  // Creation by dragging on an empty column area (single click = 1 h).
  const [creating, setCreating] = useState<{ dayKey: string; startMin: number; endMin: number } | null>(null)
  const startCreate = (day: Date) => (e: React.PointerEvent) => {
    if (e.button !== 0 || resizingRef.current) return
    if ((e.target as Element).closest('[data-event]')) return
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const dayKey = day.toISOString()
    const m0 = Math.max(0, Math.min(24 * 60 - 15, Math.round(((e.clientY - rect.top) / PX_PER_HOUR * 60) / 15) * 15))
    let cur = { startMin: m0, endMin: m0 + 15 }
    let moved = false
    setCreating({ dayKey, ...cur })
    const move = (me: PointerEvent) => {
      const m = Math.max(0, Math.min(24 * 60, Math.round(((me.clientY - rect.top) / PX_PER_HOUR * 60) / 15) * 15))
      moved = true
      cur = m >= m0 + 15 ? { startMin: m0, endMin: m } : { startMin: Math.min(m, m0), endMin: m0 + 15 }
      setCreating({ dayKey, ...cur })
    }
    const up = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up)
      setCreating(null)
      const endMin = moved ? cur.endMin : Math.min(24 * 60, m0 + 60)
      const s = new Date(day); s.setHours(0, cur.startMin, 0, 0)
      const en = new Date(day); en.setHours(0, endMin, 0, 0)
      onRangeCreate(s, en)
    }
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up)
  }

  const gutterCols = secondaryTimezone ? '52px 52px' : '60px'
  const gridCols = `${gutterCols} repeat(${days.length}, minmax(0, 1fr))`
  const showNowWeek = days.some(d => isToday(d))
  // Moon: principal-phase marker on the header of the day concerned.
  const moonOn = useCalendarStore(s => s.moonEnabled)
  const moonDay = (d: Date) => (moonOn ? principalPhaseOfDay(d) : null)
  const gutter = (labelFor: (h: number) => string, withNow = false) => (
    <div className="border-r border-border relative">
      {hours.map(h => (
        <div key={h} className="h-10 flex items-start justify-end pr-2 -mt-px pt-0.5">
          {h > 0 && <span className="text-[11px] text-text-tertiary -translate-y-1/2" style={{ fontFamily: MONO }}><MonoText>{labelFor(h)}</MonoText></span>}
        </div>
      ))}
      {withNow && showNowWeek && (
        <div className="absolute right-1 z-30 -translate-y-1/2 px-1 py-px rounded bg-danger text-white text-[10px] font-semibold pointer-events-none"
          style={{ top: nowTop, fontFamily: MONO }}>
          <MonoText>{formatDate(now, tPattern)}</MonoText>
        </div>
      )}
    </div>
  )

  // Initial scroll: current time (when the week contains today), otherwise the
  // configured start of day.
  const scrollRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const sc = scrollRef.current
    if (!sc) return
    sc.scrollTop = showNowWeek
      ? Math.max(0, nowTop - sc.clientHeight / 2.5)
      : settings.dayStartHour * PX_PER_HOUR
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weekStart.getTime(), settings.dayStartHour])

  return (
    <div className="flex-1 overflow-hidden flex flex-col">
      {/* Day headers (+ timezone labels in the gutter(s)) */}
      <div className="grid border-b border-border shrink-0" style={{ gridTemplateColumns: gridCols }}>
        {secondaryTimezone && (
          <div className="text-[10px] text-text-tertiary text-center self-end pb-2 truncate" title={secondaryTimezone}>{tzOffsetLabel(secondaryTimezone)}</div>
        )}
        <div className="text-[10px] text-text-tertiary text-center self-end pb-2 truncate" title={localTz}>
          {settings.showWeekNumbers
            ? t('week_number_short', { defaultValue: 'S{{n}}', n: isoWeek(days[0] ?? weekStart) })
            : tzOffsetLabel(localTz)}
        </div>
        {days.map(day => {
          const weekend = isWeekend(day)
          const wx      = weatherByDate.get(toISODate(day)) ?? null
          return (
            <div key={day.toISOString()}
              className={`py-2 text-center ${weekend ? 'bg-surface-1' : ''}`}>
              <div className={`text-xs uppercase ${weekend ? 'text-text-tertiary' : 'text-text-secondary'}`}>
                {formatDate(day, 'weekdayShort')}
              </div>
              <div className={`w-8 h-8 mx-auto flex items-center justify-center rounded-full text-sm font-medium
                               ${isToday(day) ? 'bg-primary text-white' : weekend ? 'text-text-tertiary' : 'text-text-primary'}`}>
                {formatDate(day, { day: 'numeric' })}
              </div>
              {/* Compact weather + moon-phase marker (principal-phase days) */}
              {(wx || moonDay(day)) && (
                <div className="flex items-center justify-center gap-1 mt-0.5">
                  {wx && (<>
                    <img src={weatherIconUrl(wx.weather_code, true)} alt="" width={20} height={20} style={{ width: 20, height: 20 }} draggable={false} />
                    <span className="text-[10px] text-text-secondary">{Math.round(wx.temp_max)}°/{Math.round(wx.temp_min)}°</span>
                  </>)}
                  {(() => { const ph = moonDay(day); return ph
                    ? <PrincipalMoonIcon phase={ph} size={14} title={principalPhaseName(ph, t)} className="shrink-0" />
                    : null })()}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* All-day / multi-day events as continuous bars spanning their days */}
      <BannerRow days={days} events={events} calendars={calendars}
        gridCols={gridCols} leadingGutters={secondaryTimezone ? 2 : 1}
        onEventClick={onEventClick} onEventContextMenu={onEventContextMenu} />

      {/* Work-location band (thin all-day-style line under the headers) */}
      <WorkLocationBand days={days} leadingGutters={secondaryTimezone ? 2 : 1} gridCols={gridCols} settings={settings} />

      {/* Grille horaire */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        <div className="grid" style={{ minHeight: '960px', gridTemplateColumns: gridCols }}>
          {secondaryTimezone && gutter(h => tzHourLabel(secondaryTimezone, h))}
          {gutter(h => { const d = new Date(date); d.setHours(h, 0, 0, 0); return formatDate(d, hourPattern(settings.timeFormat)) }, true)}
          {days.map(day => {
            const weekend  = isWeekend(day)
            const dayEvs0  = eventsForDay(day)
            const apptEvs  = dayEvs0.filter(ev => ev.event_id.startsWith(APPT_PREFIX))
            const dayEvs   = dayEvs0.filter(ev => !ev.event_id.startsWith(APPT_PREFIX))
            const apptPad  = apptEvs.length ? APPT_GUTTER : 0
            const layout   = layoutDayEvents(dayEvs)
            return (
              <div key={day.toISOString()}
                onPointerDown={startCreate(day)}
                onDragOver={e => { if (!draggingRef.current) return; e.preventDefault(); const rect = e.currentTarget.getBoundingClientRect(); const y = e.clientY - rect.top; let m = Math.round((y / 40 * 60) / 15) * 15; m = Math.max(0, Math.min(24 * 60 - 15, m)); setGhost({ dayKey: day.toISOString(), min: m }) }}
                onDrop={e => { const drag = draggingRef.current; if (drag && ghost) { e.preventDefault(); const ns = new Date(day); ns.setHours(Math.floor(ghost.min / 60), ghost.min % 60, 0, 0); onEventDrop(drag, ns) } draggingRef.current = null; setDragging(null); setGhost(null) }}
                className={`border-r border-border relative ${weekend ? 'bg-surface-1/40' : ''}`}>
                {/* Hour lines + half-hour dotted line. Outside the day's working
                    ranges the band is shaded (opt-in preference). */}
                {hours.map(h => (
                  <div key={h}
                    className={`h-10 border-b border-border/60 relative
                                ${isOffWorkHour(day, h, settings) ? 'bg-surface-2/70' : ''}`}>
                    <div className="absolute left-0 right-0 top-1/2 border-b border-dashed border-border/40" />
                  </div>
                ))}
                {dragging && ghost?.dayKey === day.toISOString() && (
                  <div className="absolute left-0.5 right-0.5 rounded bg-primary/20 border border-dashed border-primary pointer-events-none z-20"
                    style={{ top: ghost.min * 40 / 60, height: ghostHeight }}>
                    <div className="text-[10px] font-medium text-primary px-1" style={{ fontFamily: MONO }}><MonoText>{fmtMin(ghost.min)}</MonoText></div>
                  </div>
                )}
                {/* Range being created (dragging on an empty area) */}
                {creating?.dayKey === day.toISOString() && (
                  <div className="absolute left-0.5 right-0.5 rounded bg-primary/15 border border-primary pointer-events-none z-20"
                    style={{ top: creating.startMin * PX_PER_HOUR / 60, height: Math.max((creating.endMin - creating.startMin) / 60 * PX_PER_HOUR, 10) }}>
                    <div className="text-[10px] font-medium text-primary px-1" style={{ fontFamily: MONO }}>
                      <MonoText>{fmtMin(creating.startMin)}</MonoText> – <MonoText>{fmtMin(creating.endMin)}</MonoText>
                    </div>
                  </div>
                )}
                {dayEvs.map(ev => {
                  const start  = toDate(ev.starts_at)
                  const end    = toDate(ev.ends_at)
                  const cal    = calMap.get(ev.calendar_id)
                  const color  = ev.color ?? cal?.color ?? '#1a73e8'
                  const past   = settings.dimPastEvents && end < now
                  const isResizing = resize?.id === ev.id
                  const sMin   = isResizing ? resize!.startMin : start.getHours() * 60 + start.getMinutes()
                  const eMin   = isResizing ? resize!.endMin   : end.getHours()   * 60 + end.getMinutes()
                  const top    = sMin / 60 * PX_PER_HOUR
                  // "Short events at the size of a 30-minute one" raises the floor.
                  const minPx  = settings.minEventHeight ? PX_PER_HOUR / 2 : 20
                  const height = Math.max((eMin - sMin) / 60 * PX_PER_HOUR, minPx)
                  const pos     = layout.get(ev.id) ?? { leftPct: 0, widthPct: 100 }
                  const compact = height < 34   // bloc court → une seule ligne
                  const locked  = isCalendarLocked(cal)   // lecture seule / abonnement
                  return (
                    <div key={ev.id}
                      data-event
                      draggable={!locked}
                      onDragStart={e => { if (locked || resizingRef.current) { e.preventDefault(); return } draggingRef.current = ev; setDragging(ev) }}
                      onDragEnd={() => { draggingRef.current = null; setDragging(null); setGhost(null) }}
                      onClick={() => { if (!isResizing) onEventClick(ev) }}
                      onContextMenu={e => onEventContextMenu(e, ev)}
                      title={`${ev.title} · ${fmtMin(sMin)} – ${fmtMin(eMin)}`}
                      style={{
                        top, height,
                        backgroundColor: past ? color + '2b' : color,
                        color: past ? color : '#ffffff',
                        opacity: dragging?.id === ev.id ? 0.4 : 1,
                        left: `calc(${pos.leftPct}% + ${2 + apptPad}px)`, width: `calc(${pos.widthPct}% - ${4 + apptPad}px)`,
                      }}
                      className="absolute rounded-md px-1.5 py-0.5 cursor-pointer overflow-hidden
                                 shadow-sm ring-1 ring-surface-0/60 transition-[box-shadow,filter] duration-100
                                 hover:shadow-md hover:brightness-[1.04] hover:z-10 active:cursor-grabbing">
                      {!locked && <div onPointerDown={startResize(ev, day, 'top')} onClick={e => e.stopPropagation()} draggable={false}
                        className="absolute top-0 left-0 right-0 h-1.5 cursor-ns-resize z-10" />}
                      <div className="text-xs font-semibold truncate leading-snug">
                        {ev.title}
                        {compact && <span className="font-normal opacity-85 text-[10px]" style={{ fontFamily: MONO }}> · <MonoText>{fmtMin(sMin)}</MonoText></span>}
                      </div>
                      {!compact && (
                        <div className="text-[10px] truncate opacity-85" style={{ fontFamily: MONO }}><MonoText>{fmtMin(sMin)}</MonoText> – <MonoText>{fmtMin(eMin)}</MonoText></div>
                      )}
                      {!locked && <div onPointerDown={startResize(ev, day, 'bottom')} onClick={e => e.stopPropagation()} draggable={false}
                        className="absolute bottom-0 left-0 right-0 h-1.5 cursor-ns-resize z-10" />}
                    </div>
                  )
                })}
                {/* Availability bands (appointment schedules) — read-only */}
                {apptEvs.map(ev => {
                  const start = toDate(ev.starts_at), end = toDate(ev.ends_at)
                  const sMin = start.getHours() * 60 + start.getMinutes()
                  const eMin = end.getHours() * 60 + end.getMinutes()
                  return <AvailabilityStrip key={ev.id} ev={ev} sMin={sMin} compact={isMobile}
                    top={sMin / 60 * PX_PER_HOUR} height={Math.max((eMin - sMin) / 60 * PX_PER_HOUR, 20)}
                    onClick={() => onEventClick(ev)} />
                })}
                {/* "Now" line in the current day's column */}
                {isToday(day) && (
                  <div className="absolute left-0 right-0 z-20 pointer-events-none flex items-center"
                    style={{ top: nowTop, transform: 'translateY(-50%)' }}>
                    <div className="w-2 h-2 rounded-full bg-danger -ml-1 shrink-0" />
                    <div className="flex-1 h-0.5 bg-danger" />
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

