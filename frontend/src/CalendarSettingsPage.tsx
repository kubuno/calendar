import { useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@kubuno/sdk'
import { Calendar, Save, ChevronLeft, ExternalLink, MapPin, Plus, Trash2, Star, Search } from 'lucide-react'
import { Link } from 'react-router-dom'
import { Button, Tabs, Input, Spinner, Dropdown } from '@ui'
import CalendarCalDavSettings from './CalendarCalDavSettings'
import { weatherApi, type GeocodingResult } from './api'
import { useCalendarStore } from './store'

type Tab = 'general' | 'caldav' | 'weather' | 'about'

interface CalendarSettings {
  'calendar.default_timezone': string
  'calendar.week_starts_on': string
  'calendar.time_format': string
  'calendar.default_event_duration_min': number
}

const WEEK_START_OPTIONS = [
  { value: 'monday',   labelKey: 'settings_day_monday' },
  { value: 'sunday',   labelKey: 'settings_day_sunday' },
  { value: 'saturday', labelKey: 'settings_day_saturday' },
]

const TIME_FORMAT_OPTIONS = [
  { value: '24h', labelKey: 'settings_time_24h', example: '14:30' },
  { value: '12h', labelKey: 'settings_time_12h', example: '2:30 PM' },
]

// Fuseaux proposés pour la colonne secondaire de la vue Jour ('' = désactivé).
const SECONDARY_TZ_OPTIONS = [
  '',
  'Europe/Paris', 'Europe/London', 'Europe/Berlin', 'Europe/Moscow',
  'America/New_York', 'America/Los_Angeles', 'America/Sao_Paulo',
  'Africa/Douala', 'Africa/Casablanca', 'Asia/Dubai', 'Asia/Kolkata',
  'Asia/Shanghai', 'Asia/Tokyo', 'Australia/Sydney', 'UTC',
]

const EVENT_DURATION_OPTIONS = [
  { value: 15,  labelKey: 'settings_duration_15min' },
  { value: 30,  labelKey: 'settings_duration_30min' },
  { value: 60,  labelKey: 'settings_duration_1h' },
  { value: 120, labelKey: 'settings_duration_2h' },
]

function useAdminSettings() {
  return useQuery({
    queryKey: ['admin-settings'],
    queryFn: () =>
      api.get<{ settings: { key: string; value: unknown }[] }>('/admin/settings').then((r) => {
        const map: Record<string, unknown> = {}
        r.data.settings.forEach((s) => { map[s.key] = s.value })
        return map as unknown as CalendarSettings
      }),
  })
}

function GeneralTab() {
  const { t } = useTranslation('calendar')
  const queryClient = useQueryClient()
  const { data: settings } = useAdminSettings()

  const [timezone, setTimezone]     = useState<string | null>(null)
  const [weekStart, setWeekStart]   = useState<string | null>(null)
  const [timeFormat, setTimeFormat] = useState<string | null>(null)
  const [duration, setDuration]     = useState<number | null>(null)
  // Fuseau secondaire = préférence perso (vue Jour), appliquée immédiatement.
  const { secondaryTimezone, setSecondaryTimezone } = useCalendarStore()

  const currentTimezone   = timezone   ?? (settings?.['calendar.default_timezone']           ?? 'Europe/Paris')
  const currentWeekStart  = weekStart  ?? (settings?.['calendar.week_starts_on']             ?? 'monday')
  const currentTimeFormat = timeFormat ?? (settings?.['calendar.time_format']                ?? '24h')
  const currentDuration   = duration   ?? (settings?.['calendar.default_event_duration_min'] ?? 60)

  const isDirty = timezone !== null || weekStart !== null || timeFormat !== null || duration !== null

  const save = useMutation({
    mutationFn: (updates: Record<string, unknown>) => api.patch('/admin/settings', updates),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-settings'] })
      setTimezone(null)
      setWeekStart(null)
      setTimeFormat(null)
      setDuration(null)
    },
  })

  function handleSave() {
    const updates: Record<string, unknown> = {}
    if (timezone   !== null) updates['calendar.default_timezone']           = timezone
    if (weekStart  !== null) updates['calendar.week_starts_on']             = weekStart
    if (timeFormat !== null) updates['calendar.time_format']                = timeFormat
    if (duration   !== null) updates['calendar.default_event_duration_min'] = duration
    if (Object.keys(updates).length > 0) save.mutate(updates)
  }

  return (
    <div>
      <div className="bg-white rounded-xl border border-border divide-y divide-border">
        {/* Timezone */}
        <div className="p-5">
          <label className="block text-sm font-medium text-text-primary mb-1">
            {t('settings_default_timezone')}
          </label>
          <p className="text-xs text-text-secondary mb-3">
            {t('settings_default_timezone_help')}
          </p>
          <Dropdown
            value={currentTimezone}
            onChange={(v) => setTimezone(v)}
            options={(SECONDARY_TZ_OPTIONS.filter(Boolean).includes(currentTimezone)
                ? SECONDARY_TZ_OPTIONS.filter(Boolean)
                : [currentTimezone, ...SECONDARY_TZ_OPTIONS.filter(Boolean)]
              ).map(tz => ({ value: tz, label: tz }))}
            className="w-full max-w-sm"
          />
        </div>

        {/* Secondary timezone (personal — day view) */}
        <div className="p-5">
          <label className="block text-sm font-medium text-text-primary mb-1">
            {t('settings_secondary_timezone')}
          </label>
          <p className="text-xs text-text-secondary mb-3">
            {t('settings_secondary_timezone_help')}
          </p>
          <Dropdown
            value={secondaryTimezone ?? ''}
            onChange={(v) => setSecondaryTimezone(v || null)}
            options={SECONDARY_TZ_OPTIONS.map(tz => ({
              value: tz,
              label: tz === '' ? t('settings_secondary_timezone_none', { defaultValue: 'Aucun (désactivé)' }) : tz,
            }))}
            className="w-full max-w-sm"
          />
        </div>

        {/* Week starts on */}
        <div className="p-5">
          <p className="text-sm font-medium text-text-primary mb-1">
            {t('settings_week_start')}
          </p>
          <p className="text-xs text-text-secondary mb-3">
            {t('settings_week_start_help')}
          </p>
          <div className="flex gap-2">
            {WEEK_START_OPTIONS.map(opt => (
              <button
                key={opt.value}
                onClick={() => setWeekStart(opt.value)}
                className={`px-5 py-2 rounded-lg border text-sm font-medium transition-colors ${
                  currentWeekStart === opt.value
                    ? 'border-primary bg-primary-light text-primary'
                    : 'border-border hover:bg-surface-1 text-text-secondary'
                }`}
              >
                {t(opt.labelKey)}
              </button>
            ))}
          </div>
        </div>

        {/* Time format */}
        <div className="p-5">
          <p className="text-sm font-medium text-text-primary mb-1">{t('settings_time_format')}</p>
          <p className="text-xs text-text-secondary mb-3">{t('settings_time_format_help')}</p>
          <div className="flex gap-3">
            {TIME_FORMAT_OPTIONS.map(opt => (
              <button
                key={opt.value}
                onClick={() => setTimeFormat(opt.value)}
                className={`flex-1 max-w-[140px] py-3 rounded-xl border text-center transition-colors ${
                  currentTimeFormat === opt.value
                    ? 'border-primary bg-primary-light text-primary'
                    : 'border-border hover:bg-surface-1 text-text-secondary'
                }`}
              >
                <p className="text-sm font-semibold">{t(opt.labelKey)}</p>
                <p className="text-xs font-mono mt-0.5 opacity-70">{opt.example}</p>
              </button>
            ))}
          </div>
        </div>

        {/* Default event duration */}
        <div className="p-5">
          <p className="text-sm font-medium text-text-primary mb-1">
            {t('settings_default_duration')}
          </p>
          <p className="text-xs text-text-secondary mb-3">
            {t('settings_default_duration_help')}
          </p>
          <div className="flex flex-wrap gap-2">
            {EVENT_DURATION_OPTIONS.map(opt => (
              <button
                key={opt.value}
                onClick={() => setDuration(opt.value)}
                className={`px-4 py-1.5 rounded-full text-sm border transition-colors ${
                  currentDuration === opt.value
                    ? 'border-primary bg-primary-light text-primary font-medium'
                    : 'border-border hover:bg-surface-1 text-text-secondary'
                }`}
              >
                {t(opt.labelKey)}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="mt-4 flex justify-end">
        <Button onClick={handleSave} disabled={!isDirty || save.isPending}>
          <Save size={15} />
          {save.isPending ? t('saving') : t('save')}
        </Button>
      </div>
    </div>
  )
}

// ── Weather tab (inline, non-modal) ──────────────────────────────────────────

function GeoSearch({ onSelect }: { onSelect: (r: GeocodingResult) => void }) {
  const { t } = useTranslation('calendar')
  const [q, setQ]               = useState('')
  const [results, setResults]   = useState<GeocodingResult[]>([])
  const [loading, setLoading]   = useState(false)
  const [timer, setTimer]       = useState<ReturnType<typeof setTimeout> | null>(null)

  const search = useCallback((value: string) => {
    if (timer) clearTimeout(timer)
    if (!value.trim()) { setResults([]); return }
    setLoading(true)
    const t = setTimeout(async () => {
      try {
        const { results: r } = await weatherApi.geocode(value)
        setResults(r)
      } catch { setResults([]) }
      finally { setLoading(false) }
    }, 400)
    setTimer(t)
  }, [timer])

  return (
    <div>
      <Input
        type="text"
        placeholder={t('weather_search_city')}
        value={q}
        onChange={e => { setQ(e.target.value); search(e.target.value) }}
        className="w-full"
        leftIcon={<Search size={14} />}
        rightIcon={loading ? <Spinner size="xs" /> : undefined}
      />

      {results.length > 0 && (
        <div className="mt-1 border border-border rounded-lg overflow-hidden shadow-sm bg-white">
          {results.map((r, i) => (
            <button
              key={i}
              onClick={() => { onSelect(r); setQ(''); setResults([]) }}
              className="w-full flex items-start gap-2 px-3 py-2 text-left hover:bg-surface-1 transition-colors border-b border-border last:border-0"
            >
              <MapPin size={13} className="text-text-tertiary mt-0.5 shrink-0" />
              <div>
                <div className="text-sm text-text-primary font-medium">{r.name}</div>
                <div className="text-xs text-text-tertiary">
                  {[r.admin1, r.country].filter(Boolean).join(', ')}
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function WeatherTab() {
  const { t } = useTranslation('calendar')
  const qc = useQueryClient()

  const { data, isLoading } = useQuery({
    queryKey: ['weather-locations'],
    queryFn:  weatherApi.listLocations,
  })
  const locations = data?.locations ?? []

  const addMut = useMutation({
    mutationFn: (r: GeocodingResult) => weatherApi.addLocation({
      name:       `${r.name}${r.admin1 ? `, ${r.admin1}` : ''}, ${r.country}`,
      latitude:   r.latitude,
      longitude:  r.longitude,
      timezone:   r.timezone,
    }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['weather-locations'] }),
  })

  const setDefaultMut = useMutation({
    mutationFn: (id: string) => weatherApi.updateLocation(id, { is_default: true }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['weather-locations'] }),
  })

  const deleteMut = useMutation({
    mutationFn: (id: string) => weatherApi.deleteLocation(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['weather-locations'] }),
  })

  return (
    <div className="bg-white rounded-xl border border-border overflow-hidden">
      <div className="flex items-center gap-3 px-5 py-4 bg-surface-1 border-b border-border">
        <div className="w-8 h-8 rounded-lg bg-sky-100 flex items-center justify-center shrink-0">
          <MapPin size={16} className="text-sky-600" />
        </div>
        <div>
          <p className="text-sm font-semibold text-text-primary">{t('weather_locations')}</p>
          <p className="text-xs text-text-tertiary">
            {t('weather_locations_help')}
          </p>
        </div>
      </div>

      <div className="p-5 space-y-5">
        {isLoading ? (
          <div className="flex justify-center py-6">
            <Spinner size="md" />
          </div>
        ) : locations.length === 0 ? (
          <p className="text-sm text-text-tertiary text-center py-4 italic">
            {t('weather_no_locations_short')}
          </p>
        ) : (
          <div className="space-y-2">
            {locations.map(loc => (
              <div key={loc.id}
                className="flex items-center gap-3 px-4 py-3 border border-border rounded-xl hover:bg-surface-1 transition-colors group"
              >
                <MapPin size={14} className="text-text-tertiary shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-text-primary truncate">{loc.name}</p>
                  <p className="text-xs text-text-tertiary">{loc.timezone}</p>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  {loc.is_default ? (
                    <span className="text-xs text-primary font-medium px-1.5 py-0.5 bg-primary/10 rounded">
                      {t('weather_default')}
                    </span>
                  ) : (
                    <button
                      onClick={() => setDefaultMut.mutate(loc.id)}
                      title={t('weather_set_default')}
                      className="p-1.5 rounded-lg text-text-tertiary hover:text-primary hover:bg-primary/10 transition-colors opacity-0 group-hover:opacity-100"
                    >
                      <Star size={13} />
                    </button>
                  )}
                  <button
                    onClick={() => deleteMut.mutate(loc.id)}
                    disabled={deleteMut.isPending}
                    title={t('delete')}
                    className="p-1.5 rounded-lg text-text-tertiary hover:text-danger hover:bg-danger/10 transition-colors opacity-0 group-hover:opacity-100"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="border-t border-border pt-4">
          <p className="text-xs font-semibold text-text-tertiary uppercase tracking-wider mb-3 flex items-center gap-1">
            <Plus size={11} /> {t('weather_add_location')}
          </p>
          <GeoSearch onSelect={r => addMut.mutate(r)} />
          {addMut.isPending && (
            <p className="text-xs text-text-tertiary mt-2 flex items-center gap-1">
              <Spinner size="xs" /> {t('weather_adding')}
            </p>
          )}
        </div>
      </div>

      <p className="text-[11px] text-text-tertiary mt-4 px-1">
        {t('about_weather_credit')}{' '}
        <a
          href="https://www.amcharts.com/free-animated-svg-weather-icons/"
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary hover:underline"
        >
          amCharts
        </a>
      </p>
    </div>
  )
}

function AboutTab() {
  const { t } = useTranslation('calendar')
  return (
    <div className="space-y-4">
      <div className="bg-white rounded-xl border border-border overflow-hidden">
        <div className="flex items-center gap-3 px-5 py-4 border-b border-border bg-surface-1">
          <div className="w-10 h-10 rounded-xl bg-green-100 flex items-center justify-center shrink-0">
            <Calendar size={20} className="text-green-600" />
          </div>
          <div>
            <p className="text-sm font-semibold text-text-primary">Kubuno Calendar</p>
            <p className="text-xs text-text-tertiary">{t('about_version_official')}</p>
          </div>
          <span className="ml-auto text-xs font-medium px-2 py-0.5 rounded-full bg-orange-100 text-orange-700">
            Rust
          </span>
        </div>

        <div className="divide-y divide-border">
          <div className="px-5 py-4">
            <p className="text-xs font-semibold text-text-tertiary uppercase tracking-wider mb-2">{t('description')}</p>
            <p className="text-sm text-text-secondary leading-relaxed">
              {t('about_description')}
            </p>
          </div>

          <div className="px-5 py-4 grid grid-cols-2 gap-4">
            <div>
              <p className="text-xs font-semibold text-text-tertiary uppercase tracking-wider mb-2">{t('about_author')}</p>
              <p className="text-sm text-text-primary">Kubuno Contributors</p>
            </div>
            <div>
              <p className="text-xs font-semibold text-text-tertiary uppercase tracking-wider mb-2">{t('about_license')}</p>
              <p className="text-sm text-text-primary">AGPL-3.0</p>
            </div>
          </div>

          <div className="px-5 py-4">
            <p className="text-xs font-semibold text-text-tertiary uppercase tracking-wider mb-3">{t('about_technologies')}</p>
            <div className="flex flex-wrap gap-2">
              {['Rust', 'Axum 0.7', 'SQLx 0.8', 'PostgreSQL 16', 'CalDAV/RFC 4791', 'Open-Meteo API'].map(t => (
                <span key={t} className="text-xs px-2 py-1 rounded-lg bg-surface-2 text-text-secondary font-mono">{t}</span>
              ))}
            </div>
          </div>

          <div className="px-5 py-4">
            <p className="text-xs font-semibold text-text-tertiary uppercase tracking-wider mb-2">{t('about_credits')}</p>
            <p className="text-sm text-text-secondary">
              {t('about_weather_credit')}{' '}
              <a
                href="https://www.amcharts.com/free-animated-svg-weather-icons/"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-primary hover:underline"
              >
                amCharts
                <ExternalLink size={12} />
              </a>
            </p>
          </div>

          <div className="px-5 py-4">
            <p className="text-xs font-semibold text-text-tertiary uppercase tracking-wider mb-2">{t('about_links')}</p>
            <a
              href="https://github.com/kubuno/kubuno"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline"
            >
              <ExternalLink size={13} />
              github.com/kubuno/kubuno
            </a>
          </div>
        </div>
      </div>
    </div>
  )
}

export default function CalendarSettingsPage() {
  const { t } = useTranslation('calendar')
  const [tab, setTab] = useState<Tab>('general')

  const TABS: { id: Tab; label: string }[] = [
    { id: 'general', label: t('settings_tab_general') },
    { id: 'caldav',  label: 'CalDAV' },
    { id: 'weather', label: t('settings_tab_weather') },
    { id: 'about',   label: t('settings_tab_about') },
  ]

  return (
    <div className="max-w-2xl">
      <div className="flex items-center gap-3 mb-6">
        <Link to="/admin?tab=modules" className="p-1.5 rounded-lg hover:bg-surface-2 text-text-secondary hover:text-text-primary transition-colors">
          <ChevronLeft size={18} />
        </Link>
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-green-100 flex items-center justify-center">
            <Calendar size={16} className="text-green-600" />
          </div>
          <div>
            <h1 className="text-lg font-medium text-text-primary">{t('settings_title')}</h1>
            <p className="text-xs text-text-tertiary">{t('settings_subtitle')}</p>
          </div>
        </div>
      </div>

      <Tabs tabs={TABS} value={tab} onChange={setTab} className="mb-6" />

      {tab === 'general' && <GeneralTab />}
      {tab === 'caldav'  && <CalendarCalDavSettings />}
      {tab === 'weather' && <WeatherTab />}
      {tab === 'about'   && <AboutTab />}
    </div>
  )
}
