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
import { useAuthStore, toISODate, isoWeek, toDate, formatDate, addDays, startOfWeek, isSameDay, isSameMonth, isToday, ExtensionRegistry, ModuleServiceRegistry, CALENDAR_OVERLAY, type CalendarOverlayItem, type CalendarOverlayProvider } from '@kubuno/sdk'
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
import {
  MoonIcon, PrincipalMoonIcon, moonPhase, moonIllumination,
  moonPhaseName, principalPhaseOfDay, principalPhaseName,
} from './moon'
import { Link, useParams, useNavigate, useLocation } from 'react-router-dom'
import { calendarGrid, isBannerEvent, layoutBanners, isCalendarLocked, isWeekend, useNowTick } from './calendarUtils'
import { customLocationOf, workBarStyle, WorkLocationLabel, workLocationOf } from './WorkLocation'
import { BannerBar } from './EventBanners'

// ── Month view ────────────────────────────────────────────────────────────────

export function MonthView({ month, events, calendars, onDayClick, onDayOpen, onEventClick, onEventContextMenu, onEventDrop, weatherByDate, overlayByDate }: {
  month: Date; events: EventInstance[]; calendars: Calendar[]
  onDayClick: (day: Date) => void
  onDayOpen: (day: Date) => void
  onEventClick: (ev: EventInstance) => void
  onEventContextMenu: (e: React.MouseEvent, ev: EventInstance) => void
  onEventDrop: (ev: EventInstance, newStart: Date) => void
  weatherByDate: Map<string, DailyWeather>
  overlayByDate: Map<string, CalendarOverlayItem[]>
}) {
  const { t, i18n } = useTranslation('calendar')
  // Mobile: ~55px-wide cells — compact chips (no time), no weather/moon markers,
  // and tapping a day OPENS it (day view) instead of creating an event there.
  const isMobile = useIsMobile()
  const settings = useCalendarSettings()
  const tPattern = timePattern(settings.timeFormat)
  // Week-ends can be hidden: the grid then holds 5 columns instead of 7.
  const allDays = useMemo(() => calendarGrid(month, settings.weekStartsOn), [month, settings.weekStartsOn])
  const days    = useMemo(() => settings.showWeekends ? allDays : allDays.filter(d => !isWeekend(d)),
    [allDays, settings.showWeekends])
  const perWeek = settings.showWeekends ? 7 : 5
  const weeks   = Math.max(1, Math.ceil(days.length / perWeek))
  const calMap  = useMemo(() => new Map(calendars.map(c => [c.id, c])), [calendars])
  const weekdaysShort = useMemo(() => {
    const base = startOfWeek(new Date(), settings.weekStartsOn )
    return Array.from({ length: 7 }, (_, i) => addDays(base, i))
      .filter(d => settings.showWeekends || !isWeekend(d))
      .map(d => formatDate(d, 'weekdayShort'))
  }, [i18n.language, settings.weekStartsOn, settings.showWeekends])
  // Week number of each rendered row, when the display option asks for it.
  const monthCols = `${settings.showWeekNumbers ? '2.25rem ' : ''}repeat(${perWeek}, minmax(0, 1fr))`
  const weekNumbers = useMemo(() =>
    Array.from({ length: weeks }, (_, r) => days[r * perWeek])
      .filter(Boolean)
      .map(d => isoWeek(d)),
    [days, weeks, perWeek])

  // Banner events (all-day / multi-day) are drawn as continuous bars spanning the
  // week; they are excluded from the per-day chip list to avoid a double render.
  const eventsForDay = (day: Date) =>
    events.filter(ev => !isBannerEvent(ev) && isSameDay(toDate(ev.starts_at), day))

  // Per-week banner layout: each week's banner events laid into rows. Each segment
  // is rendered as ONE element spanning its columns (in an overlay above the day
  // cells), so the vertical cell borders never cut through it — the bar reads as a
  // single continuous band. `rowsPerWeek` sizes the reserved band in each cell.
  const weekBanners = useMemo(() => {
    const segsPerWeek: Array<Array<{
      ev: EventInstance; color: string; startCol: number; endCol: number
      row: number; continuesBefore: boolean; continuesAfter: boolean
    }>> = []
    const rowsPerWeek: number[] = []
    for (let w = 0; w < weeks; w++) {
      const weekDays = days.slice(w * perWeek, w * perWeek + perWeek)
      const { segs, rows } = layoutBanners(events, weekDays)
      rowsPerWeek[w] = rows
      segsPerWeek[w] = segs.map(seg => {
        const cal = calMap.get(seg.ev.calendar_id)
        return {
          ev:              seg.ev,
          color:           seg.ev.color ?? cal?.color ?? '#4D38DB',
          startCol:        seg.startCol, endCol: seg.endCol, row: seg.row,
          continuesBefore: seg.continuesBefore,
          continuesAfter:  seg.continuesAfter,
        }
      })
    }
    return { segsPerWeek, rowsPerWeek }
  }, [events, days, weeks, perWeek, calMap])

  // Banner-band geometry (kept in sync between the per-cell spacer and the overlay).
  const BANNER_BAR_H = 18
  const BANNER_ROW_H = 20                  // bar height + 2px gap
  const BANNER_TOP   = 34                  // below the day-number row (4 pad + 28 + 2)
  const bannerLead   = settings.showWeekNumbers ? 1 : 0   // leading week-number column

  // Work-location zone reserved per week: if ANY in-month day of the week shows a
  // work location, EVERY cell of that week reserves the zone height (band on days
  // that have one, empty spacer otherwise) so the day content below stays aligned.
  // A week with no work location reserves nothing. (Not shown on mobile.)
  const WORK_ZONE_H = 20
  const showWork = !isMobile
  const weekHasWork = useMemo(() => {
    if (!showWork) return [] as boolean[]
    return Array.from({ length: weeks }, (_, w) =>
      Array.from({ length: perWeek }, (_, c) => days[w * perWeek + c])
        .some(d => d && isSameMonth(d, month) && workLocationOf(d, settings)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showWork, days, weeks, perWeek, month, settings])

  // "Now" reference (real time) to dim events already past.
  const now = useNowTick(60_000)

  // Moon: principal-phase marker on the day concerned (paper-calendar style).
  const moonOn = useCalendarStore(s => s.moonEnabled)
  const moonDay = (d: Date) => (moonOn ? principalPhaseOfDay(d) : null)

  return (
    <div className="flex-1 overflow-hidden flex flex-col">
      {/* Month title — visible ONLY in print (the toolbar, which carries the
          title on screen, is hidden when printing). */}
      <div className="print-only mb-2 text-center text-xl font-bold text-black">
        {formatDate(month, 'monthYear')}
      </div>
      {/* Weekday headers (preceded by the week-number gutter when enabled) */}
      <div className="grid border-b border-border" style={{ gridTemplateColumns: monthCols }}>
        {settings.showWeekNumbers && <div />}
        {weekdaysShort.map((d, i) => (
          <div key={i} className="py-2 text-center text-xs uppercase text-text-tertiary">
            {d}
          </div>
        ))}
      </div>

      {/* Day grid — dynamic row count (4, 5 or 6 weeks) to fill the whole height */}
      <div className="flex-1 grid overflow-hidden relative"
        style={{ gridTemplateColumns: monthCols, gridTemplateRows: `repeat(${weeks}, minmax(0, 1fr))` }}>
        {days.map((day, idx) => {
          // Week number opens each row when the display option is on.
          const weekCell = settings.showWeekNumbers && idx % perWeek === 0
            ? (
              <div key={`w-${idx}`} className="flex items-start justify-center pt-1.5 border-r border-b
                                               border-border text-[11px] text-text-tertiary bg-surface-1/40">
                {weekNumbers[Math.floor(idx / perWeek)]}
              </div>
            )
            : null
          const dayEvs  = eventsForDay(day)
          const inMonth = isSameMonth(day, month)
          const today   = isToday(day)
          const weekend = isWeekend(day)
          const wx      = inMonth ? (weatherByDate.get(toISODate(day)) ?? null) : null

          return (
            <Fragment key={day.toISOString()}>
            {weekCell}
            <div onClick={() => (isMobile ? onDayOpen(day) : onDayClick(day))}
              onDragOver={e => e.preventDefault()}
              onDrop={e => { const id = e.dataTransfer.getData('text/plain'); const found = events.find(x => x.id === id); if (found) { const os = toDate(found.starts_at); const ns = new Date(day); ns.setHours(os.getHours(), os.getMinutes(), 0, 0); onEventDrop(found, ns) } }}
              className={`border-r border-b border-border p-1 cursor-pointer min-h-0 overflow-hidden
                          transition-colors hover:bg-primary/5 print:min-h-[96px] print:break-inside-avoid
                          ${!inMonth ? 'bg-surface-2' : weekend ? 'bg-surface-1/60' : ''}`}>
              <div className={`flex items-center ${isMobile ? 'justify-center' : 'justify-between'} mb-0.5`}>
                <span className={`${isMobile ? 'w-6 h-6 text-sm' : 'w-7 h-7 text-sm'} flex items-center justify-center rounded-full font-medium
                                  ${today
                                    ? 'bg-primary text-white'
                                    : !inMonth
                                    ? 'text-text-tertiary/40'
                                    : weekend
                                    ? 'text-text-tertiary'
                                    : 'text-text-primary'}`}>
                  {formatDate(day, { day: 'numeric' })}
                </span>
                {/* Moon-phase marker + compact weather in the cell (desktop only) */}
                {!isMobile && (wx || (inMonth && moonDay(day))) && (
                  <span className="flex items-center gap-1 text-[10px] text-text-tertiary leading-none pr-0.5">
                    {inMonth && (() => { const ph = moonDay(day); return ph
                      ? <PrincipalMoonIcon phase={ph} size={13} title={principalPhaseName(ph, t)} className="shrink-0" />
                      : null })()}
                    {wx && (<>
                      <img src={weatherIconUrl(wx.weather_code, true)} alt="" width={16} height={16} style={{ width: 16, height: 16 }} draggable={false} />
                      <span>{Math.round(wx.temp_max)}°</span>
                    </>)}
                  </span>
                )}
              </div>
              {/* Reserve the height of the week's banner band; the bars are drawn
                  in the overlay below as single spanning elements so the vertical
                  cell borders never cut through them. */}
              {(() => {
                const bRows = weekBanners.rowsPerWeek[Math.floor(idx / perWeek)] ?? 0
                return bRows > 0 ? <div className="mb-0.5" style={{ height: bRows * BANNER_ROW_H }} /> : null
              })()}
              {/* Work-location zone — reserved uniformly across the week: the band
                  where the day has a location, an empty spacer of the same height
                  otherwise, so day content aligns across all cells of the week. */}
              {showWork && weekHasWork[Math.floor(idx / perWeek)] && (() => {
                const loc = inMonth ? workLocationOf(day, settings) : null
                if (!loc) return <div className="mb-0.5" style={{ height: WORK_ZONE_H }} />
                const runStart = idx % perWeek === 0 || !isSameMonth(days[idx - 1], month)
                  || workLocationOf(days[idx - 1], settings) !== loc
                const runEnd = idx % perWeek === perWeek - 1 || !days[idx + 1] || !isSameMonth(days[idx + 1], month)
                  || workLocationOf(days[idx + 1], settings) !== loc
                return (
                  // -mx-1 cancels the cell padding so the bar touches the edges
                  // and joins the neighbouring day's bar seamlessly.
                  <div className="relative -mx-1 flex items-center mb-0.5" style={{ height: WORK_ZONE_H }}>
                    <span className="absolute left-0 right-0 top-1/2 -translate-y-1/2"
                      style={{ ...workBarStyle(runStart, runEnd), right: runEnd ? 10 : undefined }} />
                    {runStart && <WorkLocationLabel location={loc} text={customLocationOf(day, settings)} className="relative z-10" />}
                  </div>
                )
              })()}
              <div className="space-y-0.5 overflow-hidden">
                {dayEvs.slice(0, isMobile ? 3 : 4).map(ev => {
                  const cal    = calMap.get(ev.calendar_id)
                  const color  = ev.color ?? cal?.color ?? '#4D38DB'
                  const past   = settings.dimPastEvents && toDate(ev.ends_at) < now
                  const locked = isCalendarLocked(cal)
                  // Same block style as the day/week views: solid (white text)
                  // for upcoming, tinted (colored text) for past.
                  return (
                    <div key={ev.id}
                      draggable={!locked && !isMobile}
                      onDragStart={e => { if (locked) { e.preventDefault(); return } e.stopPropagation(); e.dataTransfer.setData('text/plain', ev.id); e.dataTransfer.effectAllowed = 'move' }}
                      onClick={e => { e.stopPropagation(); onEventClick(ev) }}
                      onContextMenu={e => { e.stopPropagation(); onEventContextMenu(e, ev) }}
                      title={ev.title}
                      style={{ backgroundColor: past ? color + '2b' : color, color: past ? color : '#fff' }}
                      className={`flex items-center gap-1 rounded-md cursor-pointer truncate shadow-sm
                                 hover:brightness-[1.05] hover:shadow transition-[filter,box-shadow]
                                 ${isMobile ? 'text-[10px] px-1 py-px' : 'text-xs px-1.5 py-0.5'}`}>
                      {!ev.all_day && !isMobile && (
                        <span className="shrink-0 opacity-85 text-[11px]">
                          <MonoText>{formatDate(toDate(ev.starts_at), tPattern)}</MonoText>
                        </span>
                      )}
                      <span className="truncate min-w-0 font-medium">{ev.title}</span>
                    </div>
                  )
                })}
                {dayEvs.length > (isMobile ? 3 : 4) && (
                  <div className={`text-text-tertiary px-1 ${isMobile ? 'text-[10px]' : 'text-xs'}`}>
                    {isMobile ? `+${dayEvs.length - 3}` : t('more_events', { count: dayEvs.length - 4 })}
                  </div>
                )}
                {/* Items overlaid by other modules (generic extension point) —
                    same block style as events: solid (to do) or tinted +
                    colored text (done). */}
                {(overlayByDate.get(toISODate(day)) ?? []).slice(0, 2).map(it => {
                  const tcolor = it.color ?? '#80868b'
                  const chip = (
                    <div
                      style={{ backgroundColor: it.done ? tcolor + '2b' : tcolor, color: it.done ? tcolor : '#fff' }}
                      className="flex items-center gap-1 text-xs px-1.5 py-0.5 rounded-md truncate font-medium
                                 shadow-sm hover:brightness-[1.05] hover:shadow transition-[filter,box-shadow]"
                      title={it.title}>
                      <Check size={11} className={`shrink-0 ${it.done ? '' : 'opacity-70'}`} strokeWidth={3} />
                      <span className={`truncate min-w-0 ${it.done ? 'line-through' : ''}`}>{it.title}</span>
                    </div>
                  )
                  return it.link
                    ? <Link key={it.id} to={it.link} onClick={(e) => e.stopPropagation()} className="block">{chip}</Link>
                    : <div key={it.id}>{chip}</div>
                })}
              </div>
            </div>
            </Fragment>
          )
        })}

        {/* Banner overlay: same grid, laid over the day cells. Each multi-day /
            all-day event is ONE element spanning its columns, so it covers the
            vertical cell borders and reads as a single continuous bar. */}
        <div className="absolute inset-0 grid pointer-events-none"
          style={{ gridTemplateColumns: monthCols, gridTemplateRows: `repeat(${weeks}, minmax(0, 1fr))` }}>
          {weekBanners.segsPerWeek.flatMap((segs, wk) =>
            segs.map(seg => (
              // Arrow tip ONLY where the event runs past the visible MONTH (first
              // week's left / last week's right); a same-month week-wrap keeps a
              // rounded cap. The true end (event stops this week) is shortened 10px.
              <BannerBar key={`${wk}-${seg.ev.id}-${seg.row}`}
                title={seg.ev.title}
                color={seg.color}
                arrowLeft={wk === 0 && seg.continuesBefore}
                arrowRight={wk === weeks - 1 && seg.continuesAfter}
                shortenRight={!seg.continuesAfter}
                onClick={e => { e.stopPropagation(); onEventClick(seg.ev) }}
                onContextMenu={e => { e.stopPropagation(); onEventContextMenu(e, seg.ev) }}
                style={{
                  gridColumn: `${bannerLead + seg.startCol + 1} / ${bannerLead + seg.endCol + 2}`,
                  gridRow:    wk + 1,
                  alignSelf:  'start',
                  marginTop:  BANNER_TOP + seg.row * BANNER_ROW_H,
                  height:     BANNER_BAR_H,
                }}
              />
            )),
          )}
        </div>
      </div>
    </div>
  )
}

