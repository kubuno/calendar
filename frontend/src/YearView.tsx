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
import { useAuthStore, toISODate, toISOMonth, toDate, formatDate, addDays, startOfWeek, isSameDay, isSameMonth, isToday, ExtensionRegistry, ModuleServiceRegistry, CALENDAR_OVERLAY, type CalendarOverlayItem, type CalendarOverlayProvider } from '@kubuno/sdk'
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
import { calendarGrid, isWeekend } from './calendarUtils'

// ── Year view — mini-calendrier mensuel ───────────────────────────────────────

function MiniMonth({ month, events, overlayByDate, onMonthClick, selectedDay, onSelectDay }: {
  month: Date; events: EventInstance[]; overlayByDate: Map<string, CalendarOverlayItem[]>
  onMonthClick: (m: Date) => void
  selectedDay: Date | null
  onSelectDay: (d: Date, rect: DOMRect) => void
}) {
  const { t, i18n } = useTranslation('calendar')
  const settings = useCalendarSettings()
  const days = useMemo(() => calendarGrid(month, settings.weekStartsOn), [month, settings.weekStartsOn])
  // Day letters (localized) — enough at the scale of a year card.
  const weekdayLetters = useMemo(() => {
    const base = startOfWeek(new Date(), settings.weekStartsOn )
    return Array.from({ length: 7 }, (_, i) => formatDate(addDays(base, i), 'weekdayNarrow'))
  }, [i18n.language, settings.weekStartsOn])
  // Indicator colors (events + tasks) per day, deduplicated: one dot per
  // CALENDAR/source, not per event.
  const colorsByDay = useMemo(() => {
    const m = new Map<string, string[]>()
    const add = (k: string, c: string) => {
      const a = m.get(k)
      if (!a) m.set(k, [c])
      else if (!a.includes(c)) a.push(c)
    }
    events.forEach(ev => { if (isSameMonth(toDate(ev.starts_at), month)) add(toISODate(toDate(ev.starts_at)), ev.color ?? '#4D38DB') })
    overlayByDate.forEach((items, k) => { if (k.startsWith(toISOMonth(month))) items.forEach(it => add(k, it.color ?? '#80868b')) })
    return m
  }, [events, overlayByDate, month])

  const monthEventCount = useMemo(
    () => events.filter(ev => isSameMonth(toDate(ev.starts_at), month)).length,
    [events, month])
  const isCurrentMonth = isSameMonth(new Date(), month)

  return (
    <div className="px-2.5 pt-2.5 pb-1.5 flex flex-col h-full min-h-0">
      {/* Header: month (→ month view) + month workload */}
      <button onClick={() => onMonthClick(month)}
        title={t('year_open_month', { defaultValue: 'Ouvrir la vue mensuelle' })}
        className="group/mm flex items-baseline justify-between gap-2 mb-1 px-1 w-full text-left shrink-0">
        <span className={`text-[15px] font-semibold capitalize transition-colors
          ${isCurrentMonth ? 'text-primary' : 'text-text-primary group-hover/mm:text-primary'}`}>
          {formatDate(month, 'month')}
        </span>
        {monthEventCount > 0 && (
          <span className="text-[10px] tabular-nums px-1.5 py-px rounded-full bg-surface-2 text-text-secondary
                           group-hover/mm:bg-primary/10 group-hover/mm:text-primary transition-colors">
            {monthEventCount}
          </span>
        )}
      </button>
      <div className="grid grid-cols-7 mb-0.5 shrink-0">
        {weekdayLetters.map((d, i) => (
          <div key={i} className={`text-center text-[10px] font-medium uppercase ${i >= 5 ? 'text-text-tertiary/50' : 'text-text-tertiary'}`}>
            {d}
          </div>
        ))}
      </div>
      {/* Days: out-of-month days hidden (airy grid, classic year-view style);
          number + color dots (one per calendar/source). The detail opens in a
          FLOATING box (see YearView), so the grid fills the card. */}
      <div className="grid grid-cols-7 flex-1 auto-rows-fr min-h-0">
        {days.map(day => {
          const inMonth = isSameMonth(day, month)
          if (!inMonth) return <span key={day.toISOString()} aria-hidden />
          const today   = isToday(day)
          const weekend = isWeekend(day)
          const isSel   = selectedDay != null && isSameDay(day, selectedDay)
          const dots    = colorsByDay.get(toISODate(day)) ?? []
          return (
            <button key={day.toISOString()} type="button"
              onClick={e => onSelectDay(day, e.currentTarget.getBoundingClientRect())}
              className="flex flex-col items-center justify-center min-h-0 outline-none group/day">
              <span className={`text-xs w-6 h-6 flex items-center justify-center rounded-full transition-colors
                ${today   ? 'bg-primary text-white font-bold shadow-sm'
                  : isSel   ? 'ring-2 ring-primary text-primary font-semibold'
                  : weekend ? 'text-text-tertiary group-hover/day:bg-surface-2'
                  : 'text-text-primary group-hover/day:bg-surface-2'}`}>
                {formatDate(day, { day: 'numeric' })}
              </span>
              <span className="flex items-center justify-center gap-[3px] h-1">
                {dots.slice(0, 3).map((c, i) => (
                  <span key={i} className="w-1 h-1 rounded-full" style={{ backgroundColor: c }} />
                ))}
                {dots.length > 3 && <span className="text-[10px] leading-none text-text-tertiary">+</span>}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

// FLOATING box (portal) listing the events and tasks of a day selected in the Year view.
function DayPopover({ day, rect, events, overlayByDate, onClose, onEventClick, onCreate }: {
  day: Date; rect: DOMRect
  events: EventInstance[]
  overlayByDate: Map<string, CalendarOverlayItem[]>
  onClose: () => void
  onEventClick: (ev: EventInstance) => void
  onCreate?: (day: Date) => void
}) {
  const { t, i18n } = useTranslation('calendar')
  const tPattern = timePattern(useCalendarSettings().timeFormat)
  const dayEvents = events.filter(ev => isSameDay(toDate(ev.starts_at), day))
    .sort((a, b) => a.starts_at.localeCompare(b.starts_at))
  const tasks = overlayByDate.get(toISODate(day)) ?? []

  const W = 264
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1280
  const vh = typeof window !== 'undefined' ? window.innerHeight : 800
  const placeAbove = rect.bottom + 240 > vh
  const left = Math.max(8, Math.min(rect.left + rect.width / 2 - W / 2, vw - W - 8))
  const arrowLeft = Math.max(12, Math.min(rect.left + rect.width / 2 - left, W - 12))
  const pos: React.CSSProperties = placeAbove
    ? { bottom: vh - rect.top + 8, left, width: W }
    : { top: rect.bottom + 8, left, width: W }

  return createPortal(
    <>
      <div className="fixed inset-0 z-[55]" onClick={onClose} />
      <div className="cal-details fixed z-[56] bg-surface-0 rounded-xl shadow-xl border border-border p-3"
        style={pos} onClick={e => e.stopPropagation()}>
        <span className={`cal-arrow absolute w-2.5 h-2.5 rotate-45 bg-surface-0 ${placeAbove ? '-bottom-1.5 border-r border-b' : '-top-1.5 border-l border-t'} border-border`}
          style={{ left: arrowLeft - 5 }} />
        {/* Header: big number + day, and quick creation on the right */}
        <div className="flex items-center gap-2 mb-2">
          <span className={`w-9 h-9 shrink-0 flex items-center justify-center rounded-full text-base font-bold
            ${isToday(day) ? 'bg-primary text-white' : 'bg-surface-1 text-text-primary'}`}>
            {formatDate(day, { day: 'numeric' })}
          </span>
          <div className="flex-1 min-w-0 leading-tight">
            <div className="text-xs font-semibold text-text-primary capitalize truncate">
              {formatDate(day, 'weekday')}
            </div>
            <div className="text-[11px] text-text-tertiary capitalize truncate">
              {formatDate(day, 'monthYear')}
            </div>
          </div>
          {onCreate && (
            <button
              onClick={() => { onCreate(day); onClose() }}
              title={t('year_create_here', { defaultValue: 'Créer un événement ce jour' })}
              className="w-7 h-7 shrink-0 flex items-center justify-center rounded-full text-text-tertiary
                         hover:bg-primary/10 hover:text-primary transition-colors">
              <Plus size={15} />
            </button>
          )}
        </div>
        <div className="space-y-1 max-h-56 overflow-y-auto">
          {dayEvents.length === 0 && tasks.length === 0 && (
            <div className="text-xs text-text-tertiary italic">{t('year_no_events', { defaultValue: 'Aucun événement' })}</div>
          )}
          {dayEvents.map((ev, i) => (
            <button key={ev.id} onClick={() => { onEventClick(ev); onClose() }}
              className="cal-event w-full flex items-center gap-1.5 text-xs text-left rounded px-1 py-0.5 hover:bg-surface-1"
              style={{ ['--i' as string]: i } as React.CSSProperties}>
              <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: ev.color ?? '#4D38DB' }} />
              {!ev.all_day && <span className="text-text-tertiary shrink-0"><MonoText>{formatDate(toDate(ev.starts_at), tPattern)}</MonoText></span>}
              <span className="truncate text-text-primary">{ev.title}</span>
            </button>
          ))}
          {tasks.map((it, i) => {
            const row = (
              <div className="cal-event flex items-center gap-1.5 text-xs rounded px-1 py-0.5 hover:bg-surface-1"
                style={{ ['--i' as string]: (dayEvents.length + i) } as React.CSSProperties}>
                <span className="w-1.5 h-1.5 rounded-[2px] shrink-0" style={{ backgroundColor: it.color ?? '#80868b' }} />
                <span className={`truncate ${it.done ? 'line-through text-text-tertiary' : 'text-text-primary'}`}>{it.title}</span>
              </div>
            )
            return it.link
              ? <Link key={it.id} to={it.link} onClick={onClose} className="block">{row}</Link>
              : <div key={it.id}>{row}</div>
          })}
        </div>
      </div>
    </>,
    document.body,
  )
}

export function YearView({ year, events, overlayByDate, onMonthClick, onEventClick, onDayCreate }: {
  year: Date; events: EventInstance[]
  overlayByDate: Map<string, CalendarOverlayItem[]>
  onMonthClick: (month: Date) => void
  onEventClick: (ev: EventInstance) => void
  onDayCreate?: (day: Date) => void
}) {
  const months = useMemo(
    () => Array.from({ length: 12 }, (_, i) => new Date(year.getFullYear(), i, 1)),
    [year],
  )
  // Selected day + anchor (button rect) to position the floating box.
  const [sel, setSel] = useState<{ day: Date; rect: DOMRect } | null>(null)
  const selectDay = (day: Date, rect: DOMRect) =>
    setSel(prev => (prev && isSameDay(prev.day, day) ? null : { day, rect }))
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') setSel(null) }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [])
  return (
    <div className="flex-1 overflow-y-auto p-4 md:p-6 bg-surface-1/40">
      {/* h-full + auto-rows-fr: the months fill the height (the detail box
          floats above through a portal, so it doesn't disturb this grid). */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4 h-full auto-rows-fr min-h-[560px]">
        {months.map(m => {
          const current = isSameMonth(new Date(), m)
          return (
            <div key={m.toISOString()}
              className={`rounded-2xl bg-surface-0 flex flex-col min-h-0 overflow-hidden transition-shadow hover:shadow-md
                ${current ? 'border border-primary/40 ring-1 ring-primary/20 shadow-sm' : 'border border-border'}`}>
              <MiniMonth month={m} events={events} overlayByDate={overlayByDate} onMonthClick={onMonthClick}
                selectedDay={sel?.day ?? null} onSelectDay={selectDay} />
            </div>
          )
        })}
      </div>
      {sel && (
        <DayPopover day={sel.day} rect={sel.rect} events={events} overlayByDate={overlayByDate}
          onClose={() => setSel(null)} onEventClick={onEventClick} onCreate={onDayCreate} />
      )}
    </div>
  )
}

// ── Schedule ("Planning") view — vertical per-day event list ─────────────────
// The flagship mobile view (default tab of the shell's bottom nav), also served
// at /calendar/schedule on desktop: the visible month's events grouped by day,
// empty days skipped, Google-Agenda style.
