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
  startOfYear, endOfYear, getDay, subYears, addYears, differenceInCalendarDays,
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
import { useNowTick, isBannerEvent, bannerStartDay, bannerEndDay } from './calendarUtils'
import { WorkLocationLabel, workLocationOf, customLocationOf } from './WorkLocation'

export function ScheduleView({ rangeStart, rangeEnd, events, calendars, overlayByDate, onEventClick, onEventContextMenu, onDayOpen, onDayCreate }: {
  rangeStart: Date; rangeEnd: Date
  events: EventInstance[]; calendars: Calendar[]
  overlayByDate: Map<string, CalendarOverlayItem[]>
  onEventClick: (ev: EventInstance) => void
  onEventContextMenu: (e: React.MouseEvent, ev: EventInstance) => void
  onDayOpen: (day: Date) => void
  onDayCreate: (day: Date) => void
}) {
  const { t, i18n } = useTranslation('calendar')
  const loc = getDateLocale(i18n.language)
  const settings = useCalendarSettings()
  const tPattern = timePattern(settings.timeFormat)
  const calMap = useMemo(() => new Map(calendars.map(c => [c.id, c])), [calendars])
  const now = useNowTick(60_000)

  // One entry per day carrying its events, overlay items and work location. A
  // multi-day / all-day event appears on EVERY day it spans (not just its start),
  // and a working day shows its location — so days with only work are kept too.
  const days = useMemo(() =>
    eachDayOfInterval({ start: rangeStart, end: rangeEnd }).map(day => {
      const d0 = startOfDay(day).getTime()
      return {
        day,
        evs: events
          .filter(ev => isBannerEvent(ev)
            ? d0 >= bannerStartDay(ev).getTime() && d0 <= bannerEndDay(ev).getTime()
            : isSameDay(parseISO(ev.starts_at), day))
          .sort((a, b) => (a.all_day === b.all_day ? a.starts_at.localeCompare(b.starts_at) : a.all_day ? -1 : 1)),
        overlays: overlayByDate.get(format(day, 'yyyy-MM-dd')) ?? [],
        work: workLocationOf(day, settings),
      }
    }).filter(d => d.evs.length > 0 || d.overlays.length > 0 || d.work != null),
  [rangeStart, rangeEnd, events, overlayByDate, settings])

  // Land on today when the visible month contains it.
  const todayRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => { todayRef.current?.scrollIntoView({ block: 'start' }) }, [rangeStart, days.length])

  return (
    <div className="flex-1 overflow-y-auto">
      {days.length === 0 && (
        <div className="flex flex-col items-center justify-center py-20 text-text-tertiary">
          <CalendarIcon size={40} className="opacity-20 mb-3" />
          <p className="text-xs">{t('schedule_empty')}</p>
          <button onClick={() => onDayCreate(rangeStart)}
            className="mt-4 inline-flex items-center gap-1.5 px-4 py-2 rounded-md bg-primary/10 text-primary text-xs font-medium hover:bg-primary/20 transition-colors">
            <Plus size={15} /> {t('create')}
          </button>
        </div>
      )}
      <div className="max-w-3xl mx-auto w-full px-3 py-1">
        {days.map(({ day, evs, overlays, work }) => {
          const today = isToday(day)
          const d0    = startOfDay(day).getTime()
          return (
            <div key={day.toISOString()} ref={today ? todayRef : undefined}
              className="flex items-start gap-2 py-2 border-b border-border/60 last:border-b-0">
              {/* Date badge — tap opens that day's view */}
              <button onClick={() => onDayOpen(day)} className="w-12 shrink-0 flex flex-col items-center pt-0.5">
                <span className="text-[10px] uppercase text-text-tertiary leading-none">
                  {format(day, 'EEE', { locale: loc })}
                </span>
                <span className={`mt-0.5 w-8 h-8 flex items-center justify-center rounded-full text-base font-medium
                  ${today ? 'bg-primary text-white' : 'text-text-primary hover:bg-surface-2'}`}>
                  {format(day, 'd')}
                </span>
              </button>
              <div className="flex-1 min-w-0 space-y-1.5 pt-0.5">
                {/* Working day marker (location), shown on every concerned day. */}
                {work && (
                  <WorkLocationLabel location={work} text={customLocationOf(day, settings)} />
                )}
                {evs.map(ev => {
                  const cal   = calMap.get(ev.calendar_id)
                  const color = ev.color ?? cal?.color ?? '#4D38DB'
                  const past  = settings.dimPastEvents && parseISO(ev.ends_at) < now
                  const start = parseISO(ev.starts_at)
                  const end   = parseISO(ev.ends_at)
                  // Multi-day banner event: show which day of the run this is (X/N).
                  const spanTotal = isBannerEvent(ev)
                    ? differenceInCalendarDays(bannerEndDay(ev), bannerStartDay(ev)) + 1
                    : 1
                  const dayNum = spanTotal > 1
                    ? differenceInCalendarDays(new Date(d0), bannerStartDay(ev)) + 1
                    : 0
                  // Same solid/tinted convention as the other views.
                  return (
                    <button key={ev.id} onClick={() => onEventClick(ev)}
                      onContextMenu={e => onEventContextMenu(e, ev)}
                      style={{ backgroundColor: past ? color + '2b' : color, color: past ? color : '#fff' }}
                      className="w-full text-left rounded-lg px-3 py-2 shadow-sm cursor-pointer
                                 hover:brightness-[1.05] hover:shadow transition-[filter,box-shadow]">
                      <div className="text-xs font-medium truncate">
                        {ev.title}
                        {dayNum > 0 && (
                          <span className="font-normal opacity-80">
                            {' '}({t('day_x_of_n', { defaultValue: 'Jour {{x}}/{{n}}', x: dayNum, n: spanTotal })})
                          </span>
                        )}
                      </div>
                      <div className="text-xs opacity-85 flex items-center gap-1.5 mt-0.5 min-w-0">
                        {ev.all_day
                          ? <span>{t('all_day')}</span>
                          : <span className="shrink-0"><MonoText>{format(start, tPattern)}</MonoText> – <MonoText>{format(end, tPattern)}</MonoText></span>}
                        {ev.location && <span className="truncate">· {ev.location}</span>}
                      </div>
                    </button>
                  )
                })}
                {overlays.map(it => {
                  const tcolor = it.color ?? '#80868b'
                  const row = (
                    <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-border text-xs hover:bg-surface-1 transition-colors">
                      <Check size={13} strokeWidth={3} className="shrink-0" style={{ color: tcolor }} />
                      <span className={`truncate ${it.done ? 'line-through text-text-tertiary' : 'text-text-primary'}`}>{it.title}</span>
                    </div>
                  )
                  return it.link
                    ? <Link key={it.id} to={it.link} className="block">{row}</Link>
                    : <div key={it.id}>{row}</div>
                })}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Search results view ───────────────────────────────────────────────────────

