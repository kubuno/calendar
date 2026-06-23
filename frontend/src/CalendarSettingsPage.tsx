import React, { useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api, useAuthStore } from '@kubuno/sdk'
import { Calendar, Save, ArrowLeft, ExternalLink, MapPin, Plus, Trash2, Star, Search, Check } from 'lucide-react'
import { Link } from 'react-router-dom'
import { Button, Input, Spinner, Dropdown, Toggle, Radio } from '@ui'
import CalendarCalDavSettings from './CalendarCalDavSettings'
import { weatherApi, type GeocodingResult } from './api'
import { useCalendarStore, type ViewMode } from './store'
import { useModulePrefs } from './userPrefs'

// ── Per-user preferences (backend, cross-device via core users.preferences) ─────

interface CalendarPrefs {
  defaultView:     string   // 'month' | 'week' | 'day' | 'year'
  weekStart:       string   // 'monday' | 'sunday' | 'saturday'
  time24h:         boolean
  defaultDuration: string   // minutes: '15' | '30' | '60' | '120'
  dayStartHour:    string   // hour of day the calendar scrolls to: '0'..'12'
}

const DEFAULT_PREFS: CalendarPrefs = {
  defaultView: 'month', weekStart: 'monday', time24h: true,
  defaultDuration: '60', dayStartHour: '8',
}

// ── Mail-style layout helpers ───────────────────────────────────────────────────

function SettingsRow({ label, description, children }: {
  label: string; description?: string; children: React.ReactNode
}) {
  return (
    <div className="flex items-start gap-8 py-4 border-b border-[#e8eaed] last:border-0">
      <div className="w-60 flex-shrink-0">
        <p className="text-sm text-[#202124] font-normal">{label}</p>
        {description && <p className="text-xs text-text-tertiary mt-0.5 leading-relaxed">{description}</p>}
      </div>
      <div className="flex-1">{children}</div>
    </div>
  )
}

function RadioGroup({ options, value, onChange }: {
  options: { value: string; label: string }[]; value: string; onChange: (v: string) => void
}) {
  return (
    <div className="flex flex-col items-start gap-2">
      {options.map(opt => (
        <Radio key={opt.value} checked={value === opt.value} onChange={() => onChange(opt.value)} label={opt.label} />
      ))}
    </div>
  )
}

// ── Préférences tab (per-user) ──────────────────────────────────────────────────

function PreferencesTab() {
  const { t } = useTranslation('calendar')
  const { prefs: saved, update } = useModulePrefs<CalendarPrefs>('calendar', DEFAULT_PREFS)
  const setViewMode = useCalendarStore(s => s.setViewMode)
  const [prefs, setPrefs] = useState<CalendarPrefs>(saved)
  const [savedFlag, setSavedFlag] = useState(false)
  const [busy, setBusy] = useState(false)

  const set = <K extends keyof CalendarPrefs>(key: K, value: CalendarPrefs[K]) =>
    setPrefs(p => ({ ...p, [key]: value }))

  const save = async () => {
    setBusy(true)
    try {
      await update(prefs)
      // Apply the default view immediately to the live store (cheap, non-invasive).
      setViewMode(prefs.defaultView as ViewMode)
      setSavedFlag(true)
      setTimeout(() => setSavedFlag(false), 2500)
    } finally { setBusy(false) }
  }

  // Hours of day offered for the day/week view scroll anchor.
  const HOUR_OPTIONS = ['0', '6', '7', '8', '9', '10', '12']

  return (
    <div>
      <SettingsRow
        label={t('calendar_pref_default_view', { defaultValue: 'Vue par défaut' })}
        description={t('calendar_pref_default_view_desc', { defaultValue: 'Affichage utilisé à l\'ouverture de l\'agenda.' })}
      >
        <RadioGroup
          value={prefs.defaultView}
          onChange={v => set('defaultView', v)}
          options={[
            { value: 'month', label: t('calendar_pref_view_month', { defaultValue: 'Mois' }) },
            { value: 'week',  label: t('calendar_pref_view_week',  { defaultValue: 'Semaine' }) },
            { value: 'day',   label: t('calendar_pref_view_day',   { defaultValue: 'Jour' }) },
            { value: 'year',  label: t('calendar_pref_view_year',  { defaultValue: 'Année' }) },
          ]}
        />
      </SettingsRow>

      <SettingsRow
        label={t('calendar_pref_week_start', { defaultValue: 'Premier jour de la semaine' })}
        description={t('calendar_pref_week_start_desc', { defaultValue: 'Jour affiché en première colonne des vues Mois et Semaine.' })}
      >
        <RadioGroup
          value={prefs.weekStart}
          onChange={v => set('weekStart', v)}
          options={[
            { value: 'monday',   label: t('settings_day_monday',   { defaultValue: 'Lundi' }) },
            { value: 'sunday',   label: t('settings_day_sunday',   { defaultValue: 'Dimanche' }) },
            { value: 'saturday', label: t('settings_day_saturday', { defaultValue: 'Samedi' }) },
          ]}
        />
      </SettingsRow>

      <SettingsRow
        label={t('calendar_pref_time_format', { defaultValue: 'Format de l\'heure' })}
        description={t('calendar_pref_time_format_desc', { defaultValue: 'Affichage des heures sur 24 h ou avec AM/PM.' })}
      >
        <label className="flex items-center gap-2 cursor-pointer select-none">
          <Toggle checked={prefs.time24h} onChange={() => set('time24h', !prefs.time24h)} />
          <span className="text-sm text-text-primary">
            {prefs.time24h
              ? t('calendar_pref_time_24h_on',  { defaultValue: 'Format 24 h (14:30)' })
              : t('calendar_pref_time_24h_off', { defaultValue: 'Format 12 h (2:30 PM)' })}
          </span>
        </label>
      </SettingsRow>

      <SettingsRow
        label={t('calendar_pref_default_duration', { defaultValue: 'Durée d\'événement par défaut' })}
        description={t('calendar_pref_default_duration_desc', { defaultValue: 'Durée appliquée à un nouvel événement.' })}
      >
        <RadioGroup
          value={prefs.defaultDuration}
          onChange={v => set('defaultDuration', v)}
          options={[
            { value: '15',  label: t('settings_duration_15min', { defaultValue: '15 minutes' }) },
            { value: '30',  label: t('settings_duration_30min', { defaultValue: '30 minutes' }) },
            { value: '60',  label: t('settings_duration_1h',    { defaultValue: '1 heure' }) },
            { value: '120', label: t('settings_duration_2h',    { defaultValue: '2 heures' }) },
          ]}
        />
      </SettingsRow>

      <SettingsRow
        label={t('calendar_pref_day_start', { defaultValue: 'Heure de début de journée' })}
        description={t('calendar_pref_day_start_desc', { defaultValue: 'Heure sur laquelle les vues Jour et Semaine se positionnent à l\'ouverture.' })}
      >
        <div className="max-w-[180px]">
          <Dropdown
            value={prefs.dayStartHour}
            onChange={v => set('dayStartHour', v)}
            options={HOUR_OPTIONS.map(h => ({
              value: h,
              label: prefs.time24h ? `${h.padStart(2, '0')}:00` : `${(Number(h) % 12) || 12}:00 ${Number(h) < 12 ? 'AM' : 'PM'}`,
            }))}
            className="w-full"
          />
        </div>
      </SettingsRow>

      <div className="pt-5 flex items-center gap-3">
        <Button onClick={save} loading={busy}>
          {savedFlag
            ? <><Check size={14} className="mr-1.5 inline" />{t('calendar_settings_saved', { defaultValue: 'Enregistré' })}</>
            : t('calendar_settings_save_changes', { defaultValue: 'Enregistrer les modifications' })}
        </Button>
        <Button variant="ghost" onClick={() => setPrefs(saved)}>
          {t('common_cancel', { defaultValue: 'Annuler' })}
        </Button>
      </div>
    </div>
  )
}

// ── Admin-only global settings (instance, via /admin/settings) ──────────────────

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

// Timezones offered for the secondary column of the Day view ('' = disabled).
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
  // Secondary timezone = personal preference (Day view), applied immediately.
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
      <p className="text-xs text-text-tertiary mb-4">
        {t('calendar_settings_admin_hint', { defaultValue: 'Réglages appliqués à toute l\'instance (administrateurs).' })}
      </p>
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
              {['Rust', 'Axum 0.7', 'SQLx 0.8', 'PostgreSQL 16', 'CalDAV/RFC 4791', 'Open-Meteo API'].map(tech => (
                <span key={tech} className="text-xs px-2 py-1 rounded-lg bg-surface-2 text-text-secondary font-mono">{tech}</span>
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

// ── Main page (mail-style breadcrumb + tab bar) ─────────────────────────────────

type Tab = 'preferences' | 'caldav' | 'weather' | 'general' | 'about'

export default function CalendarSettingsPage() {
  const { t } = useTranslation('calendar')
  const isAdmin = useAuthStore(s => s.user?.role === 'admin')
  const [tab, setTab] = useState<Tab>('preferences')

  // Admin-only tabs (instance-wide settings) are hidden for non-admins.
  const tabs: { id: Tab; label: string; adminOnly?: boolean }[] = [
    { id: 'preferences', label: t('calendar_tab_preferences', { defaultValue: 'Préférences' }) },
    { id: 'caldav',      label: 'CalDAV' },
    { id: 'weather',     label: t('settings_tab_weather', { defaultValue: 'Météo' }) },
    { id: 'general',     label: t('calendar_tab_general', { defaultValue: 'Général' }), adminOnly: true },
    { id: 'about',       label: t('settings_tab_about', { defaultValue: 'À propos' }) },
  ]
  const visibleTabs = tabs.filter(tb => !tb.adminOnly || isAdmin)

  return (
    <div className="flex flex-col h-full bg-white overflow-hidden">
      {/* Breadcrumb header */}
      <div className="flex items-center gap-2 px-6 py-2.5 border-b border-[#e8eaed] flex-shrink-0" style={{ background: '#f8f9fa' }}>
        <Link to="/calendar" className="flex items-center gap-1.5 text-sm text-[#1a73e8] hover:underline">
          <ArrowLeft size={14} />
          {t('calendar_settings_breadcrumb', { defaultValue: 'Agenda' })}
        </Link>
        <span className="text-text-tertiary text-sm">/</span>
        <div className="flex items-center gap-1.5">
          <Calendar size={15} className="text-text-secondary" />
          <span className="text-sm text-text-primary">{t('settings_title', { defaultValue: 'Réglages' })}</span>
        </div>
      </div>

      {/* Tab bar (Gmail-style) */}
      <div className="flex items-end border-b border-[#e8eaed] px-4 flex-shrink-0 overflow-x-auto overflow-y-hidden" style={{ background: '#fff' }}>
        {visibleTabs.map(tb => (
          <button key={tb.id} onClick={() => setTab(tb.id)}
            className={`px-4 py-3 text-sm border-b-2 -mb-px transition-colors whitespace-nowrap ${
              tab === tb.id ? 'border-[#1a73e8] text-[#1a73e8] font-medium' : 'border-transparent text-[#5f6368] hover:text-[#202124] hover:bg-[#f1f3f4]'}`}>
            {tb.label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-8 py-6">
          {tab === 'preferences' && <PreferencesTab />}
          {tab === 'caldav'      && <CalendarCalDavSettings />}
          {tab === 'weather'     && <WeatherTab />}
          {tab === 'general'     && isAdmin && <GeneralTab />}
          {tab === 'about'       && <AboutTab />}
        </div>
      </div>
    </div>
  )
}
