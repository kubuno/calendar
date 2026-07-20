import { useState, useMemo, useEffect, type KeyboardEvent } from 'react'
import { useNavigate, useLocation, Link as RouterLink } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueries, useQueryClient } from '@tanstack/react-query'
import {
  ChevronLeft, ChevronRight, CloudSun, Settings2, CalendarDays, Upload,
  Plus, MoreVertical, Pencil, Users, Download, Trash2, Rss, RefreshCw, Eye, Moon,
  CalendarClock, Link2,
} from 'lucide-react'
import { MoonIcon, moonPhase, moonPhaseName, moonIllumination } from './moon'
import { SidebarNavItem, useConfirm } from '@kubuno/sdk'
import { Checkbox, Radio, MenuDropdown, ConfirmDialog, type MenuItem } from '@ui'
import CalendarImportModal from './CalendarImportModal'
import CalendarEditModal from './CalendarEditModal'
import CalendarShareModal from './CalendarShareModal'
import CalendarSubscribeModal from './CalendarSubscribeModal'
import {
  format,
  startOfMonth, endOfMonth,
  startOfWeek, endOfWeek,
  eachDayOfInterval,
  isSameMonth, isSameDay, isToday,
  addMonths, subMonths, addDays,
  getDay,
} from 'date-fns'
import { getDateLocale } from '@kubuno/sdk'
import { calendarApi, appointmentApi, weatherApi, weatherIconUrl, type Calendar as CalendarT, type AppointmentSchedule } from './api'
import { useCalendarStore } from './store'
import { hashTo, hashId } from './hashRoute'
import WeatherSettings from './WeatherSettings'

// Every clickable element of the left sidebar is an anchor carrying a real link.
// Pure in-page actions use href="#" + role="button"; Space is wired manually
// (Enter is native on an anchor).
const ACTION_FOCUS = 'cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-primary'

/**
 * Hover background driven in JavaScript instead of a `hover:bg-*` utility.
 *
 * A module bundle emits its Tailwind utilities inside the `kubuno-module`
 * cascade layer, which loses against the host's `utilities` layer: a
 * `hover:bg-*` class coming from a module simply never paints in the shell's
 * left sidebar (the computed background stays transparent on hover). Static
 * background classes do win, so only the `hover:` variants need this fallback.
 *
 * Resetting to an empty string on leave hands control back to the static
 * active-state class — that is intentional.
 */
const hoverBg = (color: string) => ({
  onMouseEnter: (e: React.MouseEvent<HTMLElement>) => { e.currentTarget.style.backgroundColor = color },
  onMouseLeave: (e: React.MouseEvent<HTMLElement>) => { e.currentTarget.style.backgroundColor = '' },
})

/**
 * Row hover tint. Same value as the core's SidebarNavItem so this module's rows
 * highlight exactly like mail's — the left panel must feel like ONE sidebar.
 */
const ROW_HOVER = 'color-mix(in srgb, var(--color-primary) 12%, white)'


/** Keyboard handler for anchors used as buttons: Space activates like Enter does. */
function spaceActivates(action: () => void) {
  return (e: KeyboardEvent) => {
    if (e.key === ' ') { e.preventDefault(); action() }
  }
}

function buildGrid(month: Date): Date[] {
  return eachDayOfInterval({
    start: startOfWeek(startOfMonth(month), { weekStartsOn: 1 }),
    end:   endOfWeek(endOfMonth(month),     { weekStartsOn: 1 }),
  })
}

function isWeekend(d: Date) {
  const day = getDay(d)
  return day === 0 || day === 6
}

// ── Monthly mini calendar ───────────────────────────────────────────────────

function MiniCalendar() {
  const { t, i18n } = useTranslation('calendar')
  const { currentDate, setCurrentDate, setViewMode } = useCalendarStore()
  const [miniMonth, setMiniMonth] = useState(() => new Date())
  const days = useMemo(() => buildGrid(miniMonth), [miniMonth])
  const weekdays = useMemo(() => {
    const loc = getDateLocale(i18n.language)
    const base = startOfWeek(new Date(), { weekStartsOn: 1 })
    return Array.from({ length: 7 }, (_, i) => format(addDays(base, i), 'EEEEE', { locale: loc }))
  }, [i18n.language])
  const navigate = useNavigate()

  const handleDayClick = (day: Date) => {
    setCurrentDate(day)
    setViewMode('day')
    navigate('/calendar')
  }

  return (
    <div className="px-2 pt-3 pb-1">
      {/* Month navigation */}
      <div className="flex items-center justify-between px-1 mb-1">
        <a
          href="#" role="button"
          onClick={(e) => { e.preventDefault(); setMiniMonth(startOfMonth(new Date())) }}
          onKeyDown={spaceActivates(() => setMiniMonth(startOfMonth(new Date())))}
          className={`text-sm font-semibold text-text-secondary hover:text-primary capitalize transition-colors ${ACTION_FOCUS}`}
        >
          {format(miniMonth, 'MMMM yyyy', { locale: getDateLocale(i18n.language) })}
        </a>
        <div className="flex gap-0.5">
          <a
            href="#" role="button"
            onClick={(e) => { e.preventDefault(); setMiniMonth((m) => subMonths(m, 1)) }}
            onKeyDown={spaceActivates(() => setMiniMonth((m) => subMonths(m, 1)))}
            {...hoverBg('var(--color-surface-2)')}
            className={`w-5 h-5 flex items-center justify-center rounded
                       text-text-tertiary transition-colors ${ACTION_FOCUS}`}
            aria-label={t('prev_month')}
          >
            <ChevronLeft size={12} />
          </a>
          <a
            href="#" role="button"
            onClick={(e) => { e.preventDefault(); setMiniMonth((m) => addMonths(m, 1)) }}
            onKeyDown={spaceActivates(() => setMiniMonth((m) => addMonths(m, 1)))}
            {...hoverBg('var(--color-surface-2)')}
            className={`w-5 h-5 flex items-center justify-center rounded
                       text-text-tertiary transition-colors ${ACTION_FOCUS}`}
            aria-label={t('next_month')}
          >
            <ChevronRight size={12} />
          </a>
        </div>
      </div>

      {/* Weekday headers */}
      <div className="grid grid-cols-7">
        {weekdays.map((d, i) => (
          <div
            key={i}
            className={`text-center text-[11px] font-semibold uppercase tracking-wider py-0.5
                        ${i >= 5 ? 'text-text-tertiary/60' : 'text-text-tertiary'}`}
          >
            {d}
          </div>
        ))}
      </div>

      {/* Day grid */}
      <div className="grid grid-cols-7">
        {days.map((day) => {
          const inMonth  = isSameMonth(day, miniMonth)
          const today    = isToday(day)
          const selected = isSameDay(day, currentDate) && !today
          const weekend  = isWeekend(day)

          return (
            <button
              key={day.toISOString()}
              onClick={() => handleDayClick(day)}
              title={format(day, 'd MMMM yyyy', { locale: getDateLocale(i18n.language) })}
              className="flex items-center justify-center py-0.5"
            >
              <span
                className={`
                  w-7 h-7 flex items-center justify-center text-xs rounded-full transition-colors
                  ${today
                    ? 'bg-primary text-white font-bold'
                    : selected
                    ? 'bg-primary-light text-primary font-semibold ring-1 ring-primary'
                    : !inMonth
                    ? 'text-text-tertiary/25'
                    : weekend
                    ? 'text-text-tertiary hover:bg-surface-2'
                    : 'text-text-primary hover:bg-surface-2'}
                `}
              >
                {format(day, 'd')}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

// ── Calendar list ─────────────────────────────────────────────────────────

function CalendarList() {
  const { t } = useTranslation('calendar')
  const qc = useQueryClient()
  const { hiddenCalendarIds, toggleCalendar } = useCalendarStore()
  const { confirm, confirmState, handleConfirm, handleCancel } = useConfirm()
  const [showImport, setShowImport] = useState(false)
  const [showCreate, setShowCreate] = useState(false)
  const [showSubscribe, setShowSubscribe] = useState(false)
  const [editing, setEditing] = useState<CalendarT | null>(null)
  const [sharing, setSharing] = useState<CalendarT | null>(null)
  const [refreshingId, setRefreshingId] = useState<string | null>(null)
  // Context menus (header « + » trigger and per-calendar « ⋮ » trigger)
  const [addMenu, setAddMenu] = useState<{ x: number; y: number } | null>(null)
  const [calMenu, setCalMenu] = useState<{ x: number; y: number; cal: CalendarT } | null>(null)

  const { data, isLoading } = useQuery({
    queryKey: ['calendar-calendars'],
    queryFn:  calendarApi.listCalendars,
  })
  const calendars = data?.calendars ?? []

  const refreshSubscription = async (cal: CalendarT) => {
    setRefreshingId(cal.id)
    try {
      await calendarApi.refreshCalendar(cal.id)
      qc.invalidateQueries({ queryKey: ['calendar-events'] })
      qc.invalidateQueries({ queryKey: ['calendar-calendars'] })
    } finally { setRefreshingId(null) }
  }

  const deleteCalendar = async (cal: CalendarT) => {
    const ok = await confirm({
      title:        t('cal_delete_title', { defaultValue: 'Supprimer l’agenda ?' }),
      message:      t('cal_delete_msg', { defaultValue: '« {{name}} » et tous ses événements seront définitivement supprimés.', name: cal.name }),
      confirmLabel: t('common_delete', { defaultValue: 'Supprimer' }),
      cancelLabel:  t('common_cancel', { defaultValue: 'Annuler' }),
      variant:      'danger',
    })
    if (!ok) return
    await calendarApi.deleteCalendar(cal.id)
    qc.invalidateQueries({ queryKey: ['calendar-calendars'] })
    qc.invalidateQueries({ queryKey: ['calendar-events'] })
  }

  if (isLoading) {
    return (
      <div className="px-3 space-y-2">
        {[1, 2, 3].map((i) => (
          <div key={i} className="flex items-center gap-2 py-1">
            <div className="w-3.5 h-3.5 rounded bg-surface-3 animate-pulse" />
            <div className="h-2.5 bg-surface-3 rounded animate-pulse flex-1" />
          </div>
        ))}
      </div>
    )
  }

  return (
    <div className="space-y-0.5">
      {/* Header: title + add trigger */}
      <div className="flex items-center justify-between px-2 pb-0.5">
        <span className="text-[9px] font-bold text-text-tertiary uppercase tracking-widest">
          {t('my_calendars')}
        </span>
        <a
          href="#" role="button"
          onClick={(e) => { e.preventDefault(); const r = e.currentTarget.getBoundingClientRect(); setAddMenu({ x: r.left, y: r.bottom + 4 }) }}
          onKeyDown={(e) => { if (e.key === ' ') { e.preventDefault(); const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); setAddMenu({ x: r.left, y: r.bottom + 4 }) } }}
          title={t('cal_add', { defaultValue: 'Ajouter un agenda' })}
          {...hoverBg('var(--color-surface-2)')}
          className={`w-5 h-5 flex items-center justify-center rounded
                     text-text-tertiary hover:text-primary transition-colors ${ACTION_FOCUS}`}
        >
          <Plus size={13} />
        </a>
      </div>

      {calendars.length === 0 ? (
        <p className="px-3 text-xs text-text-tertiary italic">{t('no_calendars')}</p>
      ) : (
        calendars.map((cal) => {
          const visible  = !hiddenCalendarIds.includes(cal.id)
          const readOnly = cal.my_permission === 'read'
          const isSub    = !!cal.subscription_url
          return (
            <div
              key={cal.id}
              className="group flex items-center gap-1 px-2 py-1 rounded-lg transition-colors" {...hoverBg(ROW_HOVER)}
            >
              <Checkbox
                checked={visible}
                onChange={() => toggleCalendar(cal.id)}
                color={cal.color}
                label={cal.name}
                className="flex-1 min-w-0 items-center"
                labelClassName={`text-xs truncate ${visible ? 'text-text-primary' : 'text-text-tertiary'}`}
              />
              {/* Badges: subscription / shared with me (read-only) */}
              {isSub && (
                <Rss size={11} className="shrink-0 text-text-tertiary"
                  aria-label={t('cal_badge_subscription', { defaultValue: 'Abonnement' })} />
              )}
              {readOnly && !isSub && (
                <Eye size={11} className="shrink-0 text-text-tertiary"
                  aria-label={t('cal_badge_readonly', { defaultValue: 'Lecture seule' })} />
              )}
              <a
                href="#" role="button"
                onClick={(e) => { e.preventDefault(); e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); setCalMenu({ x: r.left, y: r.bottom + 4, cal }) }}
                onKeyDown={(e) => { if (e.key === ' ') { e.preventDefault(); const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); setCalMenu({ x: r.left, y: r.bottom + 4, cal }) } }}
                title={t('cal_options', { defaultValue: 'Options de l’agenda' })}
                className={`w-5 h-5 shrink-0 flex items-center justify-center rounded opacity-0 group-hover:opacity-100
                           hover:bg-surface-3 text-text-tertiary transition-all ${ACTION_FOCUS}`}
              >
                {refreshingId === cal.id
                  ? <RefreshCw size={12} className="animate-spin" />
                  : <MoreVertical size={13} />}
              </a>
            </div>
          )
        })
      )}

      {/* « + » menu: new calendar / subscription / import */}
      {addMenu && (
        <MenuDropdown
          items={[
            { type: 'action', label: t('cal_create_title', { defaultValue: 'Nouvel agenda' }), icon: <Plus size={14} />, onClick: () => setShowCreate(true) },
            { type: 'action', label: t('sub_title', { defaultValue: 'S’abonner à un agenda' }), icon: <Rss size={14} />, onClick: () => setShowSubscribe(true) },
            { type: 'separator' },
            { type: 'action', label: t('import_sidebar_button', { defaultValue: 'Importer un fichier .ics' }), icon: <Upload size={14} />, onClick: () => setShowImport(true) },
          ] as MenuItem[]}
          pos={{ top: addMenu.y, left: addMenu.x }}
          onClose={() => setAddMenu(null)}
        />
      )}

      {/* Per-calendar « ⋮ » menu */}
      {calMenu && (() => {
        const cal = calMenu.cal
        const isOwner = cal.my_permission == null || cal.my_permission === 'owner'
        const items: MenuItem[] = []
        if (isOwner) {
          items.push({ type: 'action', label: t('cal_edit_title', { defaultValue: 'Modifier l’agenda' }), icon: <Pencil size={14} />, onClick: () => setEditing(cal) })
          items.push({ type: 'action', label: t('share_action', { defaultValue: 'Partager…' }), icon: <Users size={14} />, onClick: () => setSharing(cal) })
        }
        if (cal.subscription_url && isOwner) {
          items.push({ type: 'action', label: t('sub_refresh', { defaultValue: 'Actualiser maintenant' }), icon: <RefreshCw size={14} />, onClick: () => refreshSubscription(cal) })
        }
        items.push({ type: 'action', label: t('cal_export', { defaultValue: 'Exporter (.ics)' }), icon: <Download size={14} />, onClick: () => calendarApi.exportCalendar(cal.id, cal.name) })
        if (isOwner && !cal.is_default) {
          items.push({ type: 'separator' })
          items.push({ type: 'action', label: t('common_delete', { defaultValue: 'Supprimer' }), icon: <Trash2 size={14} />, danger: true, onClick: () => deleteCalendar(cal) })
        }
        return (
          <MenuDropdown
            items={items}
            pos={{ top: calMenu.y, left: calMenu.x }}
            onClose={() => setCalMenu(null)}
          />
        )
      })()}

      {showImport    && <CalendarImportModal onClose={() => setShowImport(false)} />}
      {showCreate    && <CalendarEditModal onClose={() => setShowCreate(false)} />}
      {showSubscribe && <CalendarSubscribeModal onClose={() => setShowSubscribe(false)} />}
      {editing       && <CalendarEditModal calendar={editing} onClose={() => setEditing(null)} />}
      {sharing       && <CalendarShareModal calendar={sharing} onClose={() => setSharing(null)} />}
      {confirmState  && <ConfirmDialog {...confirmState} onConfirm={handleConfirm} onCancel={handleCancel} />}
    </div>
  )
}

// ── Weather section ─────────────────────────────────────────────────────────────

function WeatherSection() {
  const { t } = useTranslation('calendar')
  const {
    weatherEnabled, setWeatherEnabled,
    weatherLocationId, setWeatherLocationId,
  } = useCalendarStore()
  const [showSettings, setShowSettings] = useState(false)
  const todayStr = format(new Date(), 'yyyy-MM-dd')

  const { data: locData } = useQuery({
    queryKey: ['weather-locations'],
    queryFn:  weatherApi.listLocations,
    enabled:  weatherEnabled,
  })
  const locations = locData?.locations ?? []

  // The selected location is an addressable view without a route: it lives in
  // the URL hash (/calendar/#weather/<id>) so direct links and Back work.
  const { hash } = useLocation()
  const hashLocationId = hashId(hash, 'weather')
  useEffect(() => {
    if (hashLocationId && hashLocationId !== weatherLocationId) setWeatherLocationId(hashLocationId)
  }, [hashLocationId, weatherLocationId, setWeatherLocationId])

  // Determine active location id (fallback: default, then first)
  const activeId = hashLocationId
    ?? weatherLocationId
    ?? locations.find(l => l.is_default)?.id
    ?? locations[0]?.id
    ?? null

  // Fetch forecasts for ALL locations in parallel
  const forecasts = useQueries({
    queries: locations.map(loc => ({
      queryKey:  ['weather-forecast', loc.id],
      queryFn:   () => weatherApi.getForecast(loc.latitude, loc.longitude, loc.timezone),
      enabled:   weatherEnabled,
      staleTime: 3_600_000,
    })),
  })

  return (
    <>
      <div className="px-2 py-2">
        {/* Header */}
        <div className="flex items-center justify-between mb-1.5">
          <p className="text-[11px] font-bold text-text-tertiary uppercase tracking-widest flex items-center gap-1.5">
            <CloudSun size={12} /> {t('weather')}
          </p>
          <div className="flex items-center gap-1.5">
            <a
              href="#" role="button"
              onClick={(e) => { e.preventDefault(); setShowSettings(true) }}
              onKeyDown={spaceActivates(() => setShowSettings(true))}
              className={`p-1 rounded text-text-tertiary hover:text-primary hover:bg-primary/10 transition-colors ${ACTION_FOCUS}`}
              title={t('weather_configure_locations')}
            >
              <Settings2 size={14} />
            </a>
            <button
              type="button"
              role="switch"
              aria-checked={weatherEnabled}
              aria-label={weatherEnabled ? t('weather_disable') : t('weather_enable')}
              onClick={() => setWeatherEnabled(!weatherEnabled)}
              className={`flex items-center flex-shrink-0 h-5 w-9 rounded-full px-[2px] transition-colors
                ${weatherEnabled ? 'bg-primary justify-end' : 'bg-[#bdc1c6] justify-start'}`}
            >
              <span className="h-4 w-4 rounded-full bg-white shadow-[0_1px_2px_rgba(0,0,0,0.35)]" />
            </button>
          </div>
        </div>

        {weatherEnabled && (
          locations.length === 0 ? (
            <a
              href="#" role="button"
              onClick={(e) => { e.preventDefault(); setShowSettings(true) }}
              onKeyDown={spaceActivates(() => setShowSettings(true))}
              className={`block w-full text-xs text-primary hover:text-primary-hover py-1 px-2 text-left transition-colors ${ACTION_FOCUS}`}
            >
              {t('weather_add_location')}
            </a>
          ) : (
            <ul className="space-y-0.5">
              {locations.map((loc, i) => {
                const today   = forecasts[i]?.data?.forecast.days.find(d => d.date === todayStr) ?? null
                const loading = forecasts[i]?.isLoading
                const isActive = loc.id === activeId

                return (
                  <li key={loc.id}>
                    <div
                      className={`relative flex items-center gap-2 px-2 py-1.5 rounded-lg cursor-pointer transition-colors
                        ${isActive ? 'bg-primary/8 ring-1 ring-primary/20' : ''}`}
                        {...(isActive ? {} : hoverBg(ROW_HOVER))}
                    >
                      {/* Stretched real link: the whole row is an anchor with a hash
                          target, and the visual content stays non-interactive
                          (an anchor must not contain interactive elements). */}
                      <RouterLink
                        to={hashTo('weather', loc.id)}
                        aria-label={loc.name}
                        aria-current={isActive ? 'true' : undefined}
                        className={`absolute inset-0 rounded-lg ${ACTION_FOCUS}`}
                      />
                      {/* Radio (circle only; selection is driven by the row link) */}
                      <Radio
                        checked={isActive}
                        onChange={() => setWeatherLocationId(loc.id)}
                        color="var(--color-primary)"
                        className="pointer-events-none shrink-0"
                      />

                      {/* Location + weather */}
                      <div className="flex-1 min-w-0">
                        <span className={`text-sm font-medium leading-tight truncate block ${
                          isActive ? 'text-primary' : 'text-text-primary'
                        }`}>
                          {loc.name.split(',')[0]}
                        </span>
                        {loading ? (
                          <span className="text-xs text-text-tertiary italic">{t('loading')}</span>
                        ) : today ? (
                          <span className="text-xs text-text-tertiary leading-tight inline-flex items-center gap-1">
                            <img src={weatherIconUrl(today.weather_code, true)} alt="" width={18} height={18} style={{ width: 18, height: 18 }} draggable={false} />
                            {Math.round(today.temp_max)}° / {Math.round(today.temp_min)}°
                            {today.precip_prob_max > 10 && (
                              <> · <img src="/weather-icons/drop.svg" alt="" width={14} height={14} style={{ width: 14, height: 14, display: 'inline', verticalAlign: '-2px' }} draggable={false} />{today.precip_prob_max}%</>
                            )}
                          </span>
                        ) : null}
                      </div>
                    </div>
                  </li>
                )
              })}
            </ul>
          )
        )}
      </div>

      {showSettings && <WeatherSettings onClose={() => setShowSettings(false)} />}
    </>
  )
}

// ── Main component ───────────────────────────────────────────────────────

// ── Booking pages (appointment schedules) ──────────────────────────
function BookingPagesSection() {
  const { t } = useTranslation('calendar')
  const qc = useQueryClient()
  const navigate = useNavigate()
  const { confirm, confirmState, handleConfirm, handleCancel } = useConfirm()
  const [menu, setMenu] = useState<{ x: number; y: number; s: AppointmentSchedule } | null>(null)

  const { data } = useQuery({ queryKey: ['appointment-schedules'], queryFn: appointmentApi.list })
  const schedules = data?.schedules ?? []

  const remove = async (s: AppointmentSchedule) => {
    const ok = await confirm({
      title:        t('appt_delete_title', { defaultValue: 'Supprimer le planning ?' }),
      message:      t('appt_delete_msg', { defaultValue: '« {{name}} » et sa page de réservation seront supprimés.', name: s.title || t('appt_untitled', { defaultValue: 'Sans titre' }) }),
      confirmLabel: t('common_delete', { defaultValue: 'Supprimer' }),
    })
    if (!ok) return
    await appointmentApi.remove(s.id)
    qc.invalidateQueries({ queryKey: ['appointment-schedules'] })
    qc.invalidateQueries({ queryKey: ['calendar-events'] })
  }

  return (
    <div className="px-3 pb-3">
      <div className="flex items-center justify-between mb-1.5">
        <p className="text-[11px] font-bold text-text-tertiary uppercase tracking-widest">
          {t('appt_section', { defaultValue: 'Pages de réservation' })}
        </p>
        <RouterLink to="/calendar/booking/new"
          aria-label={t('appt_new', { defaultValue: 'Nouveau planning' })}
          {...hoverBg('var(--color-surface-2)')} className={`p-1 rounded-full text-text-secondary ${ACTION_FOCUS}`}><Plus size={15} /></RouterLink>
      </div>
      {schedules.length === 0 ? (
        <p className="text-xs text-text-tertiary px-2 py-1">{t('appt_empty', { defaultValue: 'Aucun planning' })}</p>
      ) : schedules.map(s => (
        <div key={s.id} className="group flex items-center gap-2 px-2 py-1.5 rounded-lg cursor-pointer" {...hoverBg(ROW_HOVER)}>
          {/* Real route link; the options trigger stays a sibling (no nested anchors). */}
          <RouterLink to={`/calendar/booking/${s.id}`}
            className={`flex items-center gap-2 flex-1 min-w-0 self-stretch -my-1.5 py-1.5 rounded ${ACTION_FOCUS}`}>
            <CalendarClock size={16} className="shrink-0 text-primary" />
            <span className="flex-1 min-w-0 truncate text-sm text-text-primary">{s.title || t('appt_untitled', { defaultValue: 'Sans titre' })}</span>
          </RouterLink>
          <a href="#" role="button"
            title={t('appt_options', { defaultValue: 'Options du planning' })}
            {...hoverBg('var(--color-surface-3)')} className={`p-1 rounded-full text-text-tertiary opacity-100 lg:opacity-0 lg:group-hover:opacity-100 ${ACTION_FOCUS}`}
            onClick={e => { e.preventDefault(); e.stopPropagation(); const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); setMenu({ x: r.left, y: r.bottom + 4, s }) }}
            onKeyDown={e => { if (e.key === ' ') { e.preventDefault(); const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); setMenu({ x: r.left, y: r.bottom + 4, s }) } }}>
            <MoreVertical size={14} />
          </a>
        </div>
      ))}
      {menu && (
        <MenuDropdown pos={{ top: menu.y, left: menu.x }} onClose={() => setMenu(null)} items={[
          { type: 'action', label: t('appt_edit', { defaultValue: 'Modifier' }), icon: <Pencil size={14} />, onClick: () => navigate(`/calendar/booking/${menu.s.id}`) },
          { type: 'action', label: t('appt_copy_link', { defaultValue: 'Copier le lien de réservation' }), icon: <Link2 size={14} />, onClick: () => { navigator.clipboard?.writeText(appointmentApi.bookingPageUrl(menu.s.public_token)).catch(() => {}) } },
          { type: 'separator' },
          { type: 'action', label: t('common_delete', { defaultValue: 'Supprimer' }), icon: <Trash2 size={14} />, danger: true, onClick: () => remove(menu.s) },
        ] as MenuItem[]} />
      )}
      {confirmState && <ConfirmDialog {...confirmState} onConfirm={handleConfirm} onCancel={handleCancel} />}
    </div>
  )
}

export default function CalendarSidebarBody({ collapsed = false }: { collapsed?: boolean }) {
  const { t } = useTranslation('calendar')
  // Collapsed: the mini calendar does not fit → a single icon linking to the calendar.
  if (collapsed) {
    return (
      <nav className="flex flex-col items-center px-2 py-2 gap-1">
        <SidebarNavItem collapsed active
          label={t('nav_calendar', { defaultValue: 'Calendar' })}
          icon={<CalendarDays size={20} />}
          to="/calendar" />
      </nav>
    )
  }
  return (
    <div className="flex flex-col overflow-y-auto flex-1 min-h-0">
      <MiniCalendar />

      <div className="mx-3 my-2 h-px bg-border" />

      <div className="px-1 pb-3">
        <CalendarList />
      </div>

      <div className="mx-3 my-2 h-px bg-border" />

      <BookingPagesSection />

      <div className="mx-3 my-2 h-px bg-border" />

      <WeatherSection />

      <div className="mx-3 my-2 h-px bg-border" />

      <MoonSection />
    </div>
  )
}

// ── Moon — today's phase + toggle for the markers on views ───────────────────
function MoonSection() {
  const { t } = useTranslation('calendar')
  const { moonEnabled, setMoonEnabled } = useCalendarStore()
  const today = new Date(); today.setHours(12, 0, 0, 0)

  return (
    <div className="px-3 pb-3">
      <div className="flex items-center justify-between mb-1.5">
        <p className="text-[11px] font-bold text-text-tertiary uppercase tracking-widest flex items-center gap-1.5">
          <Moon size={12} /> {t('moon_section', { defaultValue: 'Lune' })}
        </p>
        <button
          type="button"
          role="switch"
          aria-checked={moonEnabled}
          aria-label={moonEnabled ? t('moon_disable', { defaultValue: 'Masquer les phases de la lune' }) : t('moon_enable', { defaultValue: 'Afficher les phases de la lune' })}
          onClick={() => setMoonEnabled(!moonEnabled)}
          className={`flex items-center flex-shrink-0 h-5 w-9 rounded-full px-[2px] transition-colors
            ${moonEnabled ? 'bg-primary justify-end' : 'bg-[#bdc1c6] justify-start'}`}
        >
          <span className="h-4 w-4 rounded-full bg-white shadow-[0_1px_2px_rgba(0,0,0,0.35)]" />
        </button>
      </div>
      {moonEnabled && (
        <div className="flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs text-text-secondary">
          <MoonIcon phase={moonPhase(today)} size={18} />
          <span className="flex-1 truncate">{moonPhaseName(today, t)}</span>
          <span className="text-text-tertiary tabular-nums">{Math.round(moonIllumination(today) * 100)} %</span>
        </div>
      )}
    </div>
  )
}
