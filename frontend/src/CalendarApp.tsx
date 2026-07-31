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
import { APPT_PREFIX, buildAvailabilityEvents, keepPerSettings, VIEW_SHORTCUTS, type CtxMenuState } from './calendarUtils'
import { CreateEventModal, EditEventModal } from './EventEditor'
import { EventDetail } from './EventDetail'
import { DayView } from './DayView'
import { WeekView } from './WeekView'
import { MonthView } from './MonthView'
import { YearView } from './YearView'
import { ScheduleView } from './ScheduleView'
import { SearchResultsView } from './SearchResultsView'

// ── Main ─────────────────────────────────────────────────────────────────────

export default function CalendarApp() {
  const { t } = useTranslation('calendar')
  const {
    viewMode, setViewMode,
    currentDate, setCurrentDate,
    hiddenCalendarIds,
    pendingCreateDate, setPendingCreate,
    searchQuery, searchApplied,
    weatherEnabled, weatherLocationId,
  } = useCalendarStore()

  const qc = useQueryClient()
  const settings = useCalendarSettings()

  // ── Synchro vue ↔ URL (/calendar/day, /week, /month, /year, /schedule) ──
  const { view }   = useParams()
  const navigate   = useNavigate()
  const location   = useLocation()
  const VIEW_PATHS: ViewMode[] = ['day', 'week', 'month', 'year', 'schedule', 'custom']

  // URL → store : applique la vue de l'URL ; redirige /calendar (ou vue inconnue) vers la vue courante.
  useEffect(() => {
    if (view) {
      if ((VIEW_PATHS as string[]).includes(view)) {
        if (view !== viewMode) setViewMode(view as ViewMode)
      } else {
        navigate(`/calendar/${viewMode}`, { replace: true })   // vue inconnue → corrige l'URL
      }
    } else if (location.pathname.replace(/\/+$/, '') === '/calendar') {
      // Bare /calendar: land on the user's preferred view (once the settings
      // are known), then keep reflecting whatever view is active.
      const target = defaultViewApplied.current ? viewMode : (settings.defaultView as ViewMode)
      defaultViewApplied.current = true
      if (target !== viewMode) setViewMode(target)
      navigate(`/calendar/${target}`, { replace: true })
    }
  }, [view, location.pathname, settings.defaultView]) // eslint-disable-line react-hooks/exhaustive-deps

  // store → URL: a view change (toolbar, year→month drill-down…) updates the URL.
  // The 1st render is ignored so a deep URL (e.g. direct access to /calendar/day)
  // is not clobbered before the URL→store effect has synced the store.
  const viewSyncMounted = useRef(false)
  useEffect(() => {
    if (!viewSyncMounted.current) { viewSyncMounted.current = true; return }
    if (view && (VIEW_PATHS as string[]).includes(view) && view !== viewMode) {
      navigate(`/calendar/${viewMode}`)
    }
  }, [viewMode]) // eslint-disable-line react-hooks/exhaustive-deps

  // Deep link `?date=YYYY-MM-DD` (used by the `calendar.event` data card and the
  // `openDate` service): position the view on that day, then drop the param so a
  // later navigation inside the module isn't stuck on it.
  useEffect(() => {
    const dateStr = new URLSearchParams(location.search).get('date')
    if (!dateStr) return
    const d = new Date(`${dateStr}T00:00:00`)
    if (!Number.isNaN(d.getTime())) setCurrentDate(d)
    navigate(location.pathname, { replace: true })
  }, [location.search]) // eslint-disable-line react-hooks/exhaustive-deps

  // The preferred default view is applied once, on the first bare /calendar hit.
  const defaultViewApplied = useRef(false)

  const [createDay,     setCreateDay]     = useState<Date | null>(null)
  // Preselected range end (creation by dragging on the grid).
  const [createEnd,     setCreateEnd]     = useState<Date | null>(null)
  const [selectedEvent, setSelectedEvent] = useState<EventInstance | null>(null)
  const [editingEvent,  setEditingEvent]  = useState<EventInstance | null>(null)
  const [ctxMenu,       setCtxMenu]       = useState<CtxMenuState | null>(null)

  // Creation by dragging on the day/week views: opens the prefilled editor.
  const handleRangeCreate = useCallback((start: Date, end: Date) => {
    setCreateEnd(end)
    setCreateDay(start)
  }, [])

  // ── Keyboard shortcuts ───────────────────────────────────────────────────────
  // T = today · ←/→ = previous/next period · 1-5 = views · X = custom view ·
  // C = create. Disabled entirely by the "keyboard shortcuts" preference.
  useEffect(() => {
    if (!settings.keyboardShortcuts) return
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return
      const el = document.activeElement as HTMLElement | null
      const tag = (el?.tagName || '').toLowerCase()
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || el?.isContentEditable) return
      // An open editor already captures the keyboard (autofocused title field);
      // as a safety net, also ignore while the create/edit modal is mounted.
      if (createDay !== null || editingEvent) return
      const k = e.key.toLowerCase()
      const step = (dir: 1 | -1) => {
        const d = viewMode === 'day' ? addDays(currentDate, dir)
          : viewMode === 'custom' ? addDays(currentDate, settings.customViewDays * dir)
          : viewMode === 'week' ? addDays(currentDate, 7 * dir)
          : viewMode === 'month' ? addDays(startOfMonth(currentDate), dir * 32)
          : addYears(currentDate, dir)
        setCurrentDate(viewMode === 'month' ? startOfMonth(d) : d)
      }
      if (k === 't') { e.preventDefault(); setCurrentDate(new Date()) }
      else if (e.key === 'ArrowLeft')  { e.preventDefault(); step(-1) }
      else if (e.key === 'ArrowRight') { e.preventDefault(); step(1) }
      else if (k === 'c') { e.preventDefault(); setCreateDay(currentDate) }
      // View shortcuts, Google-style: D/W/M/Y day-week-month-year, A schedule
      // (agenda), X custom N-day. The 1-5 digits stay as aliases.
      else if (VIEW_SHORTCUTS[k]) { e.preventDefault(); setViewMode(VIEW_SHORTCUTS[k]) }
      else if (['1', '2', '3', '4', '5'].includes(k)) {
        e.preventDefault()
        setViewMode((['day', 'week', 'month', 'year', 'schedule'] as ViewMode[])[+k - 1])
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [viewMode, currentDate, setCurrentDate, setViewMode, createDay, editingEvent, settings.keyboardShortcuts])

  // Open the creation modal when an external trigger (e.g. sidebar) requests it
  useEffect(() => {
    if (pendingCreateDate) {
      setCreateDay(pendingCreateDate)
      setPendingCreate(null)
    }
  }, [pendingCreateDate, setPendingCreate])

  const handleEventContextMenu = useCallback((e: React.MouseEvent, ev: EventInstance) => {
    e.preventDefault()
    if (ev.event_id.startsWith(APPT_PREFIX)) return   // availability blocks aren't editable events
    setCtxMenu({ x: e.clientX, y: e.clientY, event: ev })
  }, [])

  const handleCtxEdit = useCallback(() => {
    if (!ctxMenu) return
    setSelectedEvent(null)
    setEditingEvent(ctxMenu.event)
  }, [ctxMenu])

  const handleCtxDuplicate = useCallback(() => {
    if (!ctxMenu) return
    const ev = ctxMenu.event
    calendarApi.createEvent({
      calendar_id: ev.calendar_id,
      title:       t('copy_suffix', { title: ev.title }),
      description: ev.description ?? undefined,
      location:    ev.location    ?? undefined,
      starts_at:   ev.starts_at,
      ends_at:     ev.ends_at,
      all_day:     ev.all_day,
      reminders:   ev.reminders?.length ? ev.reminders : undefined,
    }).then(() => {
      qc.invalidateQueries({ queryKey: ['calendar-events'] })
    })
  }, [ctxMenu, qc, t])

  // Deleting a series from the context menu: ask for the scope.
  const [pendingDelete, setPendingDelete] = useState<EventInstance | null>(null)

  const doDelete = useCallback((ev: EventInstance, scope: 'this' | 'following' | 'all') => {
    calendarApi.deleteEvent(ev.event_id, scope, scope !== 'all' ? ev.starts_at : undefined).then(() => {
      qc.invalidateQueries({ queryKey: ['calendar-events'] })
      if (selectedEvent?.event_id === ev.event_id) setSelectedEvent(null)
    })
  }, [qc, selectedEvent])

  const handleCtxDelete = useCallback(() => {
    if (!ctxMenu) return
    if (ctxMenu.event.is_recurring) setPendingDelete(ctxMenu.event)
    else doDelete(ctxMenu.event, 'all')
  }, [ctxMenu, doDelete])

  // ── Event drag-and-drop / resize (time changes) ──────────────────────────────
  // Explicit newStart + newEnd: covers moving (duration preserved) AND resizing
  // (start and/or end changed independently).
  const [pendingMove, setPendingMove] = useState<{ ev: EventInstance; newStart: Date; newEnd: Date } | null>(null)

  const applyMove = useCallback((ev: EventInstance, newStart: Date, newEnd: Date, scope: 'this' | 'following') => {
    calendarApi.updateEvent(ev.event_id, {
      starts_at: newStart.toISOString(),
      ends_at:   newEnd.toISOString(),
      // On a series, `occurrence` is the moved occurrence: this = detach it,
      // following = truncate the series starting at it.
      ...(ev.is_recurring ? { scope, occurrence: ev.starts_at } : {}),
    }).then(() => qc.invalidateQueries({ queryKey: ['calendar-events'] }))
  }, [qc])

  const handleEventDrop = useCallback((ev: EventInstance, newStart: Date) => {
    if (ev.event_id.startsWith(APPT_PREFIX)) return  // availability blocks are read-only
    if (Math.abs(newStart.getTime() - parseISO(ev.starts_at).getTime()) < 60000) return  // pas de changement
    const durationMs = parseISO(ev.ends_at).getTime() - parseISO(ev.starts_at).getTime()
    const newEnd = new Date(newStart.getTime() + durationMs)
    if (ev.is_recurring) setPendingMove({ ev, newStart, newEnd })   // ask for the scope
    else                 applyMove(ev, newStart, newEnd, 'this')
  }, [applyMove])

  const handleEventResize = useCallback((ev: EventInstance, newStart: Date, newEnd: Date) => {
    if (ev.event_id.startsWith(APPT_PREFIX)) return  // availability blocks are read-only
    const sameStart = Math.abs(newStart.getTime() - parseISO(ev.starts_at).getTime()) < 60000
    const sameEnd   = Math.abs(newEnd.getTime()   - parseISO(ev.ends_at).getTime())   < 60000
    if (sameStart && sameEnd) return  // pas de changement
    if (ev.is_recurring) setPendingMove({ ev, newStart, newEnd })
    else                 applyMove(ev, newStart, newEnd, 'this')
  }, [applyMove])

  const { data: calData, isLoading: loadingCals } = useQuery({
    queryKey: ['calendar-calendars'],
    queryFn:  calendarApi.listCalendars,
  })
  const calendars = calData?.calendars ?? []

  const rangeStart = useMemo(() => {
    if (viewMode === 'day')      return startOfDay(currentDate)
    if (viewMode === 'custom')   return startOfDay(currentDate)
    if (viewMode === 'week')     return startOfWeek(currentDate, { weekStartsOn: settings.weekStartsOn })
    if (viewMode === 'year')     return startOfYear(currentDate)
    if (viewMode === 'schedule') return startOfMonth(currentDate)
    return startOfWeek(startOfMonth(currentDate), { weekStartsOn: settings.weekStartsOn })
  }, [viewMode, currentDate, settings.weekStartsOn])

  const rangeEnd = useMemo(() => {
    if (viewMode === 'day')      return endOfDay(currentDate)
    if (viewMode === 'custom')   return endOfDay(addDays(currentDate, settings.customViewDays - 1))
    if (viewMode === 'week')     return endOfWeek(currentDate, { weekStartsOn: settings.weekStartsOn })
    if (viewMode === 'year')     return endOfYear(currentDate)
    if (viewMode === 'schedule') return endOfMonth(currentDate)
    return endOfWeek(endOfMonth(currentDate), { weekStartsOn: settings.weekStartsOn })
  }, [viewMode, currentDate, settings.weekStartsOn, settings.customViewDays])

  const { data: evData } = useQuery({
    queryKey: ['calendar-events', rangeStart.toISOString(), rangeEnd.toISOString()],
    queryFn:  () => calendarApi.listEvents(rangeStart.toISOString(), rangeEnd.toISOString()),
    enabled:  !loadingCals,
  })
  // Hide events of the calendars unchecked in the sidebar, then apply the
  // display preferences (declined invitations).
  const events = keepPerSettings(
    (evData?.events ?? []).filter((ev) => !hiddenCalendarIds.includes(ev.calendar_id)),
    settings,
  )

  // ── Appointment schedules → overlaid availability blocks ──
  const { data: apptData } = useQuery({
    queryKey: ['appointment-schedules'],
    queryFn:  appointmentApi.list,
    enabled:  !loadingCals,
  })
  const scheduleList = apptData?.schedules ?? []
  // Full detail (with availability rules) per schedule — the list omits rules.
  const scheduleDetails = useQueries({
    queries: scheduleList.map(s => ({
      queryKey: ['appointment-schedule', s.id],
      queryFn:  () => appointmentApi.get(s.id),
    })),
  })
  const scheduleSig = scheduleDetails.map(q => `${q.data?.schedule.id ?? ''}:${q.data?.schedule.updated_at ?? ''}`).join('|')
  const availabilityEvents = useMemo(() => {
    const full = scheduleDetails.map(q => q.data?.schedule).filter(Boolean) as AppointmentSchedule[]
    return buildAvailabilityEvents(full, rangeStart, rangeEnd)
      .filter(ev => !hiddenCalendarIds.includes(ev.calendar_id))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scheduleSig, rangeStart.getTime(), rangeEnd.getTime(), hiddenCalendarIds])
  const events2 = useMemo(() => [...events, ...availabilityEvents], [events, availabilityEvents])

  // Clicking an availability block opens its schedule editor rather than the
  // event detail popover (synthetic events have no backing event).
  const handleEventClick = (ev: EventInstance) => {
    if (ev.event_id.startsWith(APPT_PREFIX)) {
      const id = ev.event_id.slice(APPT_PREFIX.length)
      navigate(`/calendar/booking/${id}`)   // edit the schedule on its dedicated page
      return
    }
    setSelectedEvent(ev)
  }

  // ── Overlays provided by other modules (generic extension point) ──
  // Calendar knows no module in particular: it aggregates the registered
  // providers (e.g. tasks overlays its due dates). See core/registry/calendarOverlay.
  const overlayProviders = ExtensionRegistry.getAll<CalendarOverlayProvider>(CALENDAR_OVERLAY)
  const { data: overlayItems = [] } = useQuery({
    queryKey: ['calendar-overlay', rangeStart.toISOString(), rangeEnd.toISOString(), overlayProviders.length],
    queryFn:  async () => {
      const lists = await Promise.all(
        overlayProviders.map(p => p.fetch(rangeStart.toISOString(), rangeEnd.toISOString()).catch(() => [])),
      )
      return lists.flat()
    },
    enabled:  !loadingCals && overlayProviders.length > 0,
  })
  const overlayByDate = useMemo(() => {
    // Each overlay provider filters its own items (e.g. tasks hides completed
    // tasks through its own view-menu toggle) — the calendar just groups by day.
    const map = new Map<string, CalendarOverlayItem[]>()
    for (const it of overlayItems) {
      const arr = map.get(it.date) ?? []
      arr.push(it)
      map.set(it.date, arr)
    }
    return map
  }, [overlayItems])

  // ── Weather ──
  const { data: locData } = useQuery({
    queryKey: ['weather-locations'],
    queryFn:  weatherApi.listLocations,
    enabled:  weatherEnabled,
  })
  const activeLoc = useMemo(() => {
    const locs = locData?.locations ?? []
    return locs.find(l => l.id === weatherLocationId)
        ?? locs.find(l => l.is_default)
        ?? locs[0]
        ?? null
  }, [locData, weatherLocationId])

  const { data: forecastData } = useQuery({
    queryKey:  ['weather-forecast', activeLoc?.id, rangeStart.toISOString().slice(0, 10)],
    queryFn:   () => weatherApi.getForecast(activeLoc!.latitude, activeLoc!.longitude, activeLoc!.timezone),
    enabled:   weatherEnabled && !!activeLoc,
    staleTime: 3_600_000,
  })

  const weatherByDate = useMemo<Map<string, DailyWeather>>(() => {
    const map = new Map<string, DailyWeather>()
    forecastData?.forecast.days.forEach(d => map.set(d.date, d))
    return map
  }, [forecastData])

  const handleMonthClick = (month: Date) => {
    setCurrentDate(month)
    setViewMode('month')
  }

  const isSearchMode = searchApplied || searchQuery.trim().length > 0

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Search results or calendar views */}
      {isSearchMode ? (
        <SearchResultsView calendars={calendars} onEventClick={setSelectedEvent} />
      ) : (
        <>
          {viewMode === 'day' && (
            <DayView date={currentDate} events={events2} calendars={calendars}
              onEventClick={handleEventClick}
              onEventContextMenu={handleEventContextMenu}
              onEventDrop={handleEventDrop}
              onEventResize={handleEventResize}
              onRangeCreate={handleRangeCreate}
              weatherByDate={weatherByDate} />
          )}
          {viewMode === 'custom' && (
            <WeekView date={currentDate} events={events2} calendars={calendars}
              dayCount={settings.customViewDays}
              onEventClick={handleEventClick}
              onEventContextMenu={handleEventContextMenu}
              onEventDrop={handleEventDrop}
              onEventResize={handleEventResize}
              onRangeCreate={handleRangeCreate}
              weatherByDate={weatherByDate} />
          )}
          {viewMode === 'week' && (
            <WeekView date={currentDate} events={events2} calendars={calendars}
              onEventClick={handleEventClick}
              onEventContextMenu={handleEventContextMenu}
              onEventDrop={handleEventDrop}
              onEventResize={handleEventResize}
              onRangeCreate={handleRangeCreate}
              weatherByDate={weatherByDate} />
          )}
          {viewMode === 'month' && (
            <MonthView month={currentDate} events={events2} calendars={calendars}
              onDayClick={setCreateDay}
              onDayOpen={(day) => { setCurrentDate(day); setViewMode('day') }}
              onEventClick={handleEventClick}
              onEventContextMenu={handleEventContextMenu}
              onEventDrop={handleEventDrop}
              weatherByDate={weatherByDate}
              overlayByDate={overlayByDate} />
          )}
          {viewMode === 'schedule' && (
            <ScheduleView rangeStart={rangeStart} rangeEnd={rangeEnd}
              events={events2} calendars={calendars}
              overlayByDate={overlayByDate}
              onEventClick={handleEventClick}
              onEventContextMenu={handleEventContextMenu}
              onDayOpen={(day) => { setCurrentDate(day); setViewMode('day') }}
              onDayCreate={setCreateDay} />
          )}
          {viewMode === 'year' && (
            <YearView year={currentDate} events={events2} overlayByDate={overlayByDate}
              onMonthClick={handleMonthClick} onEventClick={handleEventClick}
              onDayCreate={setCreateDay} />
          )}
        </>
      )}

      {/* Context menu (right click on an event) */}
      {ctxMenu && (
        <MenuDropdown
          pos={{ top: ctxMenu.y, left: ctxMenu.x }}
          onClose={() => setCtxMenu(null)}
          items={[
            { type: 'action', label: t('edit'),      icon: <Edit2 size={14} />, onClick: handleCtxEdit },
            { type: 'action', label: t('duplicate'), icon: <Copy size={14} />,  onClick: handleCtxDuplicate },
            { type: 'separator' },
            { type: 'action', label: t('delete'),    icon: <Trash2 size={14} />, onClick: handleCtxDelete },
          ]}
        />
      )}

      {/* Scope choice when moving a recurring event */}
      {pendingMove && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center" onClick={() => setPendingMove(null)}>
          <div className="absolute inset-0 bg-black/30" />
          <div className="relative bg-surface-0 rounded-2xl shadow-xl w-full max-w-sm p-5" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-sm font-semibold text-text-primary mb-1">{t('move_recurring_title')}</h3>
            <p className="text-xs text-text-secondary mb-4">{t('move_recurring_desc')}</p>
            <div className="flex flex-col gap-2">
              <button onClick={() => { applyMove(pendingMove.ev, pendingMove.newStart, pendingMove.newEnd, 'this'); setPendingMove(null) }}
                className="w-full text-sm px-3 py-2 rounded-lg border border-border hover:bg-surface-1 text-left">
                {t('move_this_only')}
              </button>
              <button onClick={() => { applyMove(pendingMove.ev, pendingMove.newStart, pendingMove.newEnd, 'following'); setPendingMove(null) }}
                className="w-full text-sm px-3 py-2 rounded-lg bg-primary text-white hover:bg-primary-hover text-left">
                {t('move_this_following')}
              </button>
              <button onClick={() => setPendingMove(null)} className="w-full text-sm px-3 py-1.5 text-text-secondary">
                {t('cancel')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Scope choice when deleting a recurring event (context menu) */}
      {pendingDelete && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center" onClick={() => setPendingDelete(null)}>
          <div className="absolute inset-0 bg-black/30" />
          <div className="relative bg-surface-0 rounded-2xl shadow-xl w-full max-w-sm p-5" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-sm font-semibold text-text-primary mb-1">
              {t('delete_recurring_title', { defaultValue: 'Supprimer l’événement récurrent' })}
            </h3>
            <p className="text-xs text-text-secondary mb-4">
              {t('delete_recurring_desc', { defaultValue: 'Quels événements de la série supprimer ?' })}
            </p>
            <div className="flex flex-col gap-2">
              <button onClick={() => { doDelete(pendingDelete, 'this'); setPendingDelete(null) }}
                className="w-full text-sm px-3 py-2 rounded-lg border border-border hover:bg-surface-1 text-left">
                {t('move_this_only', { defaultValue: 'Cet événement seulement' })}
              </button>
              <button onClick={() => { doDelete(pendingDelete, 'following'); setPendingDelete(null) }}
                className="w-full text-sm px-3 py-2 rounded-lg border border-border hover:bg-surface-1 text-left">
                {t('move_this_following', { defaultValue: 'Celui-ci et les suivants' })}
              </button>
              <button onClick={() => { doDelete(pendingDelete, 'all'); setPendingDelete(null) }}
                className="w-full text-sm px-3 py-2 rounded-lg bg-danger text-white hover:opacity-90 text-left">
                {t('delete_all_events', { defaultValue: 'Tous les événements' })}
              </button>
              <button onClick={() => setPendingDelete(null)} className="w-full text-sm px-3 py-1.5 text-text-secondary">
                {t('cancel')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modals */}
      {createDay !== null && (
        <CreateEventModal initialDate={createDay} initialEnd={createEnd} calendars={calendars}
          onClose={() => { setCreateDay(null); setCreateEnd(null) }} />
      )}
      {selectedEvent && !editingEvent && (
        <EventDetail event={selectedEvent} calendars={calendars}
          onClose={() => setSelectedEvent(null)}
          onDelete={() => setSelectedEvent(null)}
          onEdit={() => { setEditingEvent(selectedEvent); setSelectedEvent(null) }}
        />
      )}
      {editingEvent && (
        <EditEventModal event={editingEvent} calendars={calendars}
          onClose={() => setEditingEvent(null)} />
      )}
    </div>
  )
}
