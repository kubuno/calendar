import { useState, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueries } from '@tanstack/react-query'
import { ChevronLeft, ChevronRight, CloudSun, Settings2, CalendarDays } from 'lucide-react'
import { SidebarNavItem } from '@kubuno/sdk'
import { Checkbox, Radio } from '@ui'
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
import { calendarApi, weatherApi, weatherIconUrl } from './api'
import { useCalendarStore } from './store'
import WeatherSettings from './WeatherSettings'

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

// ── Mini calendrier mensuel ───────────────────────────────────────────────────

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
      {/* Navigation mois */}
      <div className="flex items-center justify-between px-1 mb-1">
        <button
          onClick={() => setMiniMonth(startOfMonth(new Date()))}
          className="text-sm font-semibold text-text-secondary hover:text-primary capitalize transition-colors"
        >
          {format(miniMonth, 'MMMM yyyy', { locale: getDateLocale(i18n.language) })}
        </button>
        <div className="flex gap-0.5">
          <button
            onClick={() => setMiniMonth((m) => subMonths(m, 1))}
            className="w-5 h-5 flex items-center justify-center rounded hover:bg-surface-2
                       text-text-tertiary transition-colors"
            aria-label={t('prev_month')}
          >
            <ChevronLeft size={12} />
          </button>
          <button
            onClick={() => setMiniMonth((m) => addMonths(m, 1))}
            className="w-5 h-5 flex items-center justify-center rounded hover:bg-surface-2
                       text-text-tertiary transition-colors"
            aria-label={t('next_month')}
          >
            <ChevronRight size={12} />
          </button>
        </div>
      </div>

      {/* En-têtes des jours */}
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

      {/* Grille des jours */}
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

// ── Liste des calendars ─────────────────────────────────────────────────────────

function CalendarList() {
  const { t } = useTranslation('calendar')
  const { hiddenCalendarIds, toggleCalendar } = useCalendarStore()

  const { data, isLoading } = useQuery({
    queryKey: ['calendar-calendars'],
    queryFn:  calendarApi.listCalendars,
  })
  const calendars = data?.calendars ?? []

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

  if (calendars.length === 0) {
    return (
      <p className="px-3 text-xs text-text-tertiary italic">{t('no_calendars')}</p>
    )
  }

  return (
    <div className="space-y-0.5">
      {calendars.map((cal) => {
        const visible = !hiddenCalendarIds.includes(cal.id)
        return (
          <div
            key={cal.id}
            className="px-2 py-1 rounded-lg hover:bg-surface-2 transition-colors"
          >
            <Checkbox
              checked={visible}
              onChange={() => toggleCalendar(cal.id)}
              color={cal.color}
              label={cal.name}
              className="w-full items-center"
              labelClassName={`text-xs truncate ${visible ? 'text-text-primary' : 'text-text-tertiary'}`}
            />
          </div>
        )
      })}
    </div>
  )
}

// ── Section météo ─────────────────────────────────────────────────────────────

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

  // Determine active location id (fallback: default, then first)
  const activeId = weatherLocationId
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
            <button
              onClick={() => setShowSettings(true)}
              className="p-1 rounded text-text-tertiary hover:text-primary hover:bg-primary/10 transition-colors"
              title={t('weather_configure_locations')}
            >
              <Settings2 size={14} />
            </button>
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
            <button
              onClick={() => setShowSettings(true)}
              className="w-full text-xs text-primary hover:text-primary-hover py-1 px-2 text-left transition-colors"
            >
              {t('weather_add_location')}
            </button>
          ) : (
            <ul className="space-y-0.5">
              {locations.map((loc, i) => {
                const today   = forecasts[i]?.data?.forecast.days.find(d => d.date === todayStr) ?? null
                const loading = forecasts[i]?.isLoading
                const isActive = loc.id === activeId

                return (
                  <li key={loc.id}>
                    <div
                      onClick={() => setWeatherLocationId(loc.id)}
                      className={`flex items-center gap-2 px-2 py-1.5 rounded-lg cursor-pointer transition-colors
                        ${isActive ? 'bg-primary/8 ring-1 ring-primary/20' : 'hover:bg-surface-2'}`}
                    >
                      {/* Radio (cercle seul ; la sélection est gérée par le conteneur) */}
                      <Radio
                        checked={isActive}
                        onChange={() => setWeatherLocationId(loc.id)}
                        color="var(--color-primary)"
                        className="pointer-events-none shrink-0"
                      />

                      {/* Lieu + météo */}
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

// ── Composant principal ───────────────────────────────────────────────────────

export default function CalendarSidebarBody({ collapsed = false }: { collapsed?: boolean }) {
  const { t } = useTranslation('calendar')
  const navigate = useNavigate()
  // Replié : le mini-calendrier ne tient pas → une icône vers l'calendar.
  if (collapsed) {
    return (
      <nav className="flex flex-col items-center px-2 py-2 gap-1">
        <SidebarNavItem collapsed active
          label={t('nav_calendar', { defaultValue: 'Calendar' })}
          icon={<CalendarDays size={20} />}
          onClick={() => navigate('/calendar')} />
      </nav>
    )
  }
  return (
    <div className="flex flex-col overflow-y-auto flex-1 min-h-0">
      <MiniCalendar />

      <div className="mx-3 my-2 h-px bg-border" />

      <div className="px-1 pb-3">
        <p className="px-2 mb-1 text-[9px] font-bold text-text-tertiary uppercase tracking-widest">
          {t('my_calendars')}
        </p>
        <CalendarList />
      </div>

      <div className="mx-3 my-2 h-px bg-border" />

      <WeatherSection />
    </div>
  )
}
