import { useState, useMemo, useRef, useEffect, useCallback } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { MenuDropdown, type MenuDropdownPos } from '@ui'
import {
  format, addDays, subDays, startOfDay, endOfDay, isToday,
  parseISO, startOfMonth, endOfMonth, startOfWeek, endOfWeek,
  eachDayOfInterval, isSameMonth, isSameDay, addMonths, subMonths,
} from 'date-fns'
import { getDateLocale } from '@kubuno/sdk'
import type { Locale } from 'date-fns/locale'
import {
  ChevronLeft, ChevronRight, ChevronDown, MoreVertical, Check,
  Calendar as CalendarIcon,
} from 'lucide-react'
import { calendarApi, type EventInstance, type Calendar } from './api'
import { useCalendarStore } from './store'

// ── Constants ─────────────────────────────────────────────────────────────────

const HOUR_HEIGHT = 44
const HOURS = Array.from({ length: 24 }, (_, i) => i)

// ── Helpers ───────────────────────────────────────────────────────────────────

function miniCalendarGrid(month: Date): Date[] {
  const start = startOfWeek(startOfMonth(month), { weekStartsOn: 0 })
  const end   = endOfWeek(endOfMonth(month),     { weekStartsOn: 0 })
  return eachDayOfInterval({ start, end })
}

function formatHour(h: number): string {
  if (h === 0)  return ''
  if (h < 12)   return `${h} AM`
  if (h === 12) return '12 PM'
  return `${h - 12} PM`
}

function formatDateHeader(date: Date, locale: Locale): string {
  const raw = format(date, 'EEE d MMM', { locale })
  // "lun. 1 juin" → "Lun., 1 juin"
  const spaceIdx = raw.indexOf(' ')
  return raw.charAt(0).toUpperCase() + raw.slice(1, spaceIdx) + ',' + raw.slice(spaceIdx)
}

// ── MiniCalendar ──────────────────────────────────────────────────────────────

function MiniCalendar({
  month, selected, onSelect, onPrevMonth, onNextMonth,
}: {
  month:       Date
  selected:    Date
  onSelect:    (d: Date) => void
  onPrevMonth: () => void
  onNextMonth: () => void
}) {
  const { i18n } = useTranslation('calendar')
  const days = useMemo(() => miniCalendarGrid(month), [month])
  const weekHeaders = useMemo(() => {
    const loc = getDateLocale(i18n.language)
    const base = startOfWeek(new Date(), { weekStartsOn: 0 })
    return Array.from({ length: 7 }, (_, i) => format(addDays(base, i), 'EEEEE', { locale: loc }))
  }, [i18n.language])

  return (
    <div className="p-3">
      {/* Month header */}
      <div className="flex items-center justify-between mb-1">
        <span className="text-sm font-semibold text-text-primary capitalize">
          {format(month, 'MMMM yyyy', { locale: getDateLocale(i18n.language) })}
        </span>
        <div className="flex gap-0.5">
          <button
            onClick={onPrevMonth}
            className="w-7 h-7 flex items-center justify-center rounded-full hover:bg-surface-2 text-text-secondary"
          >
            <ChevronLeft size={14} />
          </button>
          <button
            onClick={onNextMonth}
            className="w-7 h-7 flex items-center justify-center rounded-full hover:bg-surface-2 text-text-secondary"
          >
            <ChevronRight size={14} />
          </button>
        </div>
      </div>

      {/* Day-of-week headers */}
      <div className="grid grid-cols-7 mb-0.5">
        {weekHeaders.map((d, i) => (
          <div
            key={i}
            className="h-7 flex items-center justify-center text-[11px] font-medium text-text-tertiary"
          >
            {d}
          </div>
        ))}
      </div>

      {/* Day cells */}
      <div className="grid grid-cols-7">
        {days.map((d, i) => {
          const isSel  = isSameDay(d, selected)
          const isCur  = isToday(d)
          const inMonth = isSameMonth(d, month)
          return (
            <button
              key={i}
              onClick={() => onSelect(d)}
              className={`h-8 w-8 mx-auto flex items-center justify-center rounded-full text-xs font-medium transition-colors
                ${isSel
                  ? 'bg-primary text-white'
                  : isCur
                  ? 'border border-primary text-primary hover:bg-primary-light'
                  : inMonth
                  ? 'text-text-primary hover:bg-surface-2'
                  : 'text-text-tertiary hover:bg-surface-2'
                }`}
            >
              {format(d, 'd')}
            </button>
          )
        })}
      </div>
    </div>
  )
}

// ── AllDayChip ────────────────────────────────────────────────────────────────

function AllDayChip({
  event, onClick, continues,
}: { event: EventInstance; onClick: () => void; continues: boolean }) {
  const color = event.color ?? '#d93025'
  return (
    <button
      onClick={onClick}
      title={event.title}
      className="relative w-full flex items-center text-white text-[11px] font-semibold leading-none
                 hover:brightness-110 transition-[filter] overflow-hidden"
      style={{
        backgroundColor: color,
        borderRadius: continues ? '3px 0 3px 3px' : '3px',
        height: 20,
      }}
    >
      <span className="px-2 truncate">{event.title}</span>
      {continues && (
        <svg
          className="absolute right-0 top-0 shrink-0"
          width="10"
          height="20"
          viewBox="0 0 10 20"
          style={{ fill: color, filter: 'brightness(0.85)' }}
        >
          <polygon points="0,0 10,10 0,20" />
        </svg>
      )}
    </button>
  )
}

// ── DayView ───────────────────────────────────────────────────────────────────

function DayView({
  selectedDate, allDayEvents, timedEvents, calMap, goToFull,
}: {
  selectedDate: Date
  allDayEvents: EventInstance[]
  timedEvents:  EventInstance[]
  calMap:       Map<string, Calendar>
  goToFull:     () => void
}) {
  const now               = new Date()
  const currentTimeOffset = (now.getHours() + now.getMinutes() / 60) * HOUR_HEIGHT
  const showNow           = isToday(selectedDate)

  const scrollRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = showNow
      ? Math.max(0, currentTimeOffset - 80)
      : 8 * HOUR_HEIGHT - 40
  }, [selectedDate]) // eslint-disable-line react-hooks/exhaustive-deps

  // Timezone label (e.g. "GMT+2")
  const tzLabel = useMemo(() => {
    try {
      const parts = new Intl.DateTimeFormat('fr', { timeZoneName: 'short' }).formatToParts(now)
      return parts.find(p => p.type === 'timeZoneName')?.value ?? ''
    } catch {
      return ''
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Group all-day events by calendar
  const calGroups = useMemo(() => {
    const map = new Map<string, EventInstance[]>()
    for (const ev of allDayEvents) {
      if (!map.has(ev.calendar_id)) map.set(ev.calendar_id, [])
      map.get(ev.calendar_id)!.push(ev)
    }
    return Array.from(map.entries())
  }, [allDayEvents])

  const dayEnd = endOfDay(selectedDate)

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* All-day strip */}
      {allDayEvents.length > 0 && (
        <div className="border-b border-border px-2 py-1.5 shrink-0 space-y-1.5">
          {calGroups.map(([calId, evs]) => {
            const cal = calMap.get(calId)
            return (
              <div key={calId} className="space-y-0.5">
                {cal && (
                  <div className="flex items-center gap-1 mb-0.5">
                    <CalendarIcon size={9} style={{ color: cal.color }} />
                    <span className="text-[10px] text-text-tertiary truncate">{cal.name}</span>
                  </div>
                )}
                {evs.map(ev => (
                  <AllDayChip
                    key={ev.id}
                    event={ev}
                    onClick={goToFull}
                    continues={parseISO(ev.ends_at) > dayEnd}
                  />
                ))}
              </div>
            )
          })}
        </div>
      )}

      {/* Scrollable time grid */}
      <div className="flex-1 overflow-y-auto" ref={scrollRef}>
        <div className="relative" style={{ height: `${24 * HOUR_HEIGHT}px` }}>

          {/* Timezone label pinned to the top-left */}
          {tzLabel && (
            <div
              className="absolute left-0 w-11 z-10 flex justify-end pr-1.5 pt-1 pointer-events-none"
              style={{ top: 0 }}
            >
              <span className="text-[8px] text-text-tertiary leading-none">{tzLabel}</span>
            </div>
          )}

          {/* Hour rows */}
          {HOURS.map(h => (
            <div
              key={h}
              className="absolute w-full flex items-start"
              style={{ top: `${h * HOUR_HEIGHT}px`, height: `${HOUR_HEIGHT}px` }}
            >
              <div className="w-11 shrink-0 flex justify-end pr-1.5 pt-0.5">
                {h > 0 && (
                  <span className="text-[9px] text-text-tertiary leading-none whitespace-nowrap">
                    {formatHour(h)}
                  </span>
                )}
              </div>
              <div className="flex-1 border-t border-border/40" />
            </div>
          ))}

          {/* Current time indicator */}
          {showNow && (
            <div
              className="absolute left-11 right-0 flex items-center z-20 pointer-events-none"
              style={{ top: `${currentTimeOffset}px` }}
            >
              <div className="w-2 h-2 rounded-full bg-danger -ml-1 shrink-0" />
              <div className="flex-1 h-px bg-danger" />
            </div>
          )}

          {/* Timed events */}
          {timedEvents.map(ev => {
            const start  = parseISO(ev.starts_at)
            const end    = parseISO(ev.ends_at)
            const top    = (start.getHours() + start.getMinutes() / 60) * HOUR_HEIGHT
            const height = Math.max(((end.getTime() - start.getTime()) / 3_600_000) * HOUR_HEIGHT, 18)
            const color  = ev.color ?? calMap.get(ev.calendar_id)?.color ?? '#4D38DB'
            return (
              <button
                key={ev.id}
                onClick={goToFull}
                style={{
                  top,
                  height,
                  left: '46px',
                  right: '4px',
                  backgroundColor: color + '25',
                  borderLeft: `3px solid ${color}`,
                  borderRadius: '0 4px 4px 0',
                }}
                className="absolute px-1.5 py-0.5 cursor-pointer hover:opacity-80 overflow-hidden text-left"
              >
                <p className="text-[10px] font-semibold leading-tight truncate" style={{ color }}>
                  {ev.title}
                  {height >= 22 && `, ${format(start, 'HH:mm')}`}
                </p>
                {height >= 34 && (
                  <p className="text-[9px] leading-none" style={{ color: color + 'bb' }}>
                    {format(start, 'HH:mm')} – {format(end, 'HH:mm')}
                  </p>
                )}
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}

// ── PlanningView ──────────────────────────────────────────────────────────────

function PlanningView({
  planGroups, calMap, goToFull,
}: {
  planGroups: [string, EventInstance[]][]
  calMap:     Map<string, Calendar>
  goToFull:   () => void
}) {
  const { t, i18n } = useTranslation('calendar')
  if (planGroups.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-xs text-text-tertiary">{t('no_upcoming_events')}</p>
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-y-auto">
      {planGroups.map(([dateStr, evs]) => {
        const d = parseISO(dateStr + 'T00:00:00')
        const label = format(d, 'EEEE d MMMM', { locale: getDateLocale(i18n.language) })
        const labelCap = label.charAt(0).toUpperCase() + label.slice(1)
        return (
          <div key={dateStr}>
            <div className="px-3 py-1.5 bg-surface-1 border-b border-border sticky top-0 z-10">
              <span className="text-[11px] font-semibold text-text-secondary">
                {labelCap}
              </span>
            </div>
            <div className="divide-y divide-border/40">
              {evs.map(ev => {
                const color = ev.color ?? calMap.get(ev.calendar_id)?.color ?? '#4D38DB'
                const start = parseISO(ev.starts_at)
                return (
                  <button
                    key={ev.id}
                    onClick={goToFull}
                    className="w-full flex items-start gap-2 px-3 py-2 hover:bg-surface-1 transition-colors text-left"
                  >
                    <div
                      className="w-0.5 self-stretch rounded-full shrink-0 mt-0.5"
                      style={{ backgroundColor: color }}
                    />
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium text-text-primary truncate">{ev.title}</p>
                      {!ev.all_day && (
                        <p className="text-[10px] text-text-tertiary">{format(start, 'HH:mm')}</p>
                      )}
                    </div>
                  </button>
                )
              })}
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ── CalendarSelector ──────────────────────────────────────────────────────────

function CalendarSelector({
  calendars, hidden, onToggle, onClose,
}: {
  calendars: Calendar[]
  hidden:    string[]
  onToggle:  (id: string) => void
  onClose:   () => void
}) {
  const { t } = useTranslation('calendar')
  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border shrink-0">
        <span className="text-xs font-semibold text-text-primary">{t('calendars')}</span>
        <button
          onClick={onClose}
          className="text-xs text-primary hover:underline"
        >
          {t('back')}
        </button>
      </div>
      <div className="flex-1 overflow-y-auto py-1">
        {calendars.map(cal => {
          const isHidden = hidden.includes(cal.id)
          return (
            <button
              key={cal.id}
              onClick={() => onToggle(cal.id)}
              className="w-full flex items-center gap-3 px-3 py-2 hover:bg-surface-1 transition-colors"
            >
              <div
                className="w-4 h-4 rounded flex items-center justify-center shrink-0"
                style={{
                  backgroundColor: isHidden ? 'transparent' : cal.color,
                  border: `2px solid ${cal.color}`,
                }}
              >
                {!isHidden && <Check size={10} className="text-white" />}
              </div>
              <span className="text-xs text-text-primary truncate">{cal.name}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

// ── Main ──────────────────────────────────────────────────────────────────────

export default function CalendarMiniPanel() {
  const navigate = useNavigate()
  const { t, i18n } = useTranslation('calendar')
  const { setCurrentDate, setViewMode: setCalendarViewMode, toggleCalendar, hiddenCalendarIds } = useCalendarStore()

  const [selectedDate,    setSelectedDate]    = useState(() => new Date())
  const [pickerOpen,      setPickerOpen]      = useState(false)
  const [pickerMonth,     setPickerMonth]     = useState(() => new Date())
  const [viewMode,        setViewMode]        = useState<'day' | 'planning'>('day')
  const [menuPos,         setMenuPos]         = useState<MenuDropdownPos | null>(null)
  const [calSelectorOpen, setCalSelectorOpen] = useState(false)

  const pickerRef = useRef<HTMLDivElement>(null)

  // Close picker popover on outside click (le menu ⋮ gère lui-même sa fermeture)
  useEffect(() => {
    if (!pickerOpen) return
    const handler = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) setPickerOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [pickerOpen])

  // Day events query
  const from = useMemo(() => startOfDay(selectedDate).toISOString(), [selectedDate])
  const to   = useMemo(() => endOfDay(selectedDate).toISOString(),   [selectedDate])
  const { data: dayData } = useQuery({
    queryKey: ['calendar-mini-day', from],
    queryFn:  () => calendarApi.listEvents(from, to),
    staleTime: 60_000,
  })
  const dayEvents   = dayData?.events ?? []
  const allDayEvents = useMemo(() => dayEvents.filter(ev => ev.all_day),  [dayEvents])
  const timedEvents  = useMemo(() => dayEvents.filter(ev => !ev.all_day), [dayEvents])

  // Planning events (next 30 days)
  const planFrom = useMemo(() => startOfDay(selectedDate).toISOString(), [selectedDate])
  const planTo   = useMemo(() => endOfDay(addDays(selectedDate, 30)).toISOString(), [selectedDate])
  const { data: planData } = useQuery({
    queryKey: ['calendar-mini-plan', planFrom],
    queryFn:  () => calendarApi.listEvents(planFrom, planTo),
    staleTime: 60_000,
    enabled:   viewMode === 'planning',
  })
  const planEvents: EventInstance[] = planData?.events ?? []

  // Calendars
  const { data: calsData } = useQuery({
    queryKey: ['calendar-calendars'],
    queryFn:  calendarApi.listCalendars,
    staleTime: 300_000,
  })
  const calendars: Calendar[] = calsData?.calendars ?? []
  const calMap = useMemo(() => new Map(calendars.map(c => [c.id, c])), [calendars])

  // Planning groups
  const planGroups = useMemo<[string, EventInstance[]][]>(() => {
    const map = new Map<string, EventInstance[]>()
    for (const ev of planEvents) {
      const key = ev.starts_at.slice(0, 10)
      if (!map.has(key)) map.set(key, [])
      map.get(key)!.push(ev)
    }
    return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b))
  }, [planEvents])

  const goToFull = useCallback(() => {
    setCurrentDate(selectedDate)
    setCalendarViewMode('day')
    navigate('/calendar')
  }, [selectedDate, navigate, setCurrentDate, setCalendarViewMode])

  const navigateDay = (delta: number) =>
    setSelectedDate(d => delta > 0 ? addDays(d, 1) : subDays(d, 1))

  const goToToday = () => {
    const today = new Date()
    setSelectedDate(today)
    setPickerMonth(today)
  }

  const dateText = useMemo(
    () => formatDateHeader(selectedDate, getDateLocale(i18n.language)),
    [selectedDate, i18n.language],
  )

  if (calSelectorOpen) {
    return (
      <CalendarSelector
        calendars={calendars}
        hidden={hiddenCalendarIds}
        onToggle={toggleCalendar}
        onClose={() => setCalSelectorOpen(false)}
      />
    )
  }

  return (
    <div className="flex flex-col h-full overflow-hidden select-none">

      {/* ── Date row ──────────────────────────────────────────────────────── */}
      <div className="relative shrink-0 px-3 pt-2.5 pb-1">
        <button
          onClick={() => { setPickerMonth(selectedDate); setPickerOpen(p => !p) }}
          className="flex items-center gap-0.5 text-sm font-medium text-primary hover:text-primary-hover transition-colors"
        >
          {dateText}
          <ChevronDown size={14} className="mt-px" />
        </button>

        {/* Mini-calendar popover */}
        {pickerOpen && (
          <div
            ref={pickerRef}
            className="absolute left-0 top-full mt-0.5 z-50 bg-white rounded-2xl shadow-2xl border border-border"
            style={{ width: 276 }}
          >
            <MiniCalendar
              month={pickerMonth}
              selected={selectedDate}
              onSelect={d => { setSelectedDate(d); setPickerOpen(false) }}
              onPrevMonth={() => setPickerMonth(m => subMonths(m, 1))}
              onNextMonth={() => setPickerMonth(m => addMonths(m, 1))}
            />
          </div>
        )}
      </div>

      {/* ── Controls row ──────────────────────────────────────────────────── */}
      <div className="flex items-center gap-1 px-3 pb-2 shrink-0">
        <button
          onClick={goToToday}
          className="px-3 h-7 rounded-full border border-border text-xs font-medium text-text-primary
                     hover:bg-surface-1 transition-colors"
        >
          {t('today')}
        </button>
        <button
          onClick={() => navigateDay(-1)}
          className="w-7 h-7 flex items-center justify-center rounded-full hover:bg-surface-2 text-text-secondary"
        >
          <ChevronLeft size={14} />
        </button>
        <button
          onClick={() => navigateDay(1)}
          className="w-7 h-7 flex items-center justify-center rounded-full hover:bg-surface-2 text-text-secondary"
        >
          <ChevronRight size={14} />
        </button>
        <div className="flex-1" />

        {/* 3-dot menu */}
        <button
          onClick={e => { const r = e.currentTarget.getBoundingClientRect(); setMenuPos(m => m ? null : { top: r.bottom + 4, left: r.right - 200 }) }}
          className="w-7 h-7 flex items-center justify-center rounded-full hover:bg-surface-2 text-text-secondary"
        >
          <MoreVertical size={14} />
        </button>
      </div>

      {menuPos && (
        <MenuDropdown
          pos={menuPos}
          onClose={() => setMenuPos(null)}
          items={[
            { type: 'action', label: t('day'),      checked: viewMode === 'day',      onClick: () => setViewMode('day') },
            { type: 'action', label: t('planning'), checked: viewMode === 'planning', onClick: () => setViewMode('planning') },
            { type: 'separator' },
            { type: 'action', label: t('select_calendars'), onClick: () => setCalSelectorOpen(true) },
          ]}
        />
      )}

      {/* ── Content ───────────────────────────────────────────────────────── */}
      <div className="border-t border-border/60 flex-1 min-h-0 flex flex-col">
        {viewMode === 'day' ? (
          <DayView
            selectedDate={selectedDate}
            allDayEvents={allDayEvents}
            timedEvents={timedEvents}
            calMap={calMap}
            goToFull={goToFull}
          />
        ) : (
          <PlanningView
            planGroups={planGroups}
            calMap={calMap}
            goToFull={goToFull}
          />
        )}
      </div>
    </div>
  )
}
