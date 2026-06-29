// Per-user settings page for Calendar (route `/calendar/user-settings`).
//
// The "Préférences" tab is rendered generically from the module's declarative
// settings manifest via <ModuleSettingsForm mode="user" />; the page no longer
// hand-crafts those controls. Instance-wide (admin) settings live on a separate
// page, CalendarAdminSettingsPage (route `/calendar/settings`).
import React, { useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Calendar, ArrowLeft, ExternalLink, MapPin, Plus, Trash2, Star, Search } from 'lucide-react'
import { Link } from 'react-router-dom'
import { Input, Spinner, Dropdown } from '@ui'
import CalendarCalDavSettings from './CalendarCalDavSettings'
import { weatherApi, type GeocodingResult } from './api'
import { useCalendarStore } from './store'
import ModuleSettingsForm from './ModuleSettingsForm'

// ── Mail-style layout helper ────────────────────────────────────────────────────

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

// Timezones offered for the secondary column of the Day view ('' = disabled).
const SECONDARY_TZ_OPTIONS = [
  '',
  'Europe/Paris', 'Europe/London', 'Europe/Berlin', 'Europe/Moscow',
  'America/New_York', 'America/Los_Angeles', 'America/Sao_Paulo',
  'Africa/Douala', 'Africa/Casablanca', 'Asia/Dubai', 'Asia/Kolkata',
  'Asia/Shanghai', 'Asia/Tokyo', 'Australia/Sydney', 'UTC',
]

// ── Préférences tab (per-user) ──────────────────────────────────────────────────

function PreferencesTab() {
  const { t } = useTranslation('calendar')
  // Secondary timezone is a purely local display preference (calendar store), not a
  // declarative setting, so it stays a bespoke control alongside the generic form.
  const { secondaryTimezone, setSecondaryTimezone } = useCalendarStore()

  return (
    <div className="space-y-6">
      <ModuleSettingsForm moduleId="calendar" mode="user" />

      <div className="bg-white rounded-xl border border-border px-5">
        <SettingsRow
          label={t('settings_secondary_timezone', { defaultValue: 'Fuseau horaire secondaire' })}
          description={t('settings_secondary_timezone_help', { defaultValue: 'Seconde colonne d\'heures dans la vue Jour.' })}
        >
          <div className="max-w-sm">
            <Dropdown
              value={secondaryTimezone ?? ''}
              onChange={(v) => setSecondaryTimezone(v || null)}
              options={SECONDARY_TZ_OPTIONS.map(tz => ({
                value: tz,
                label: tz === '' ? t('settings_secondary_timezone_none', { defaultValue: 'Aucun (désactivé)' }) : tz,
              }))}
              className="w-full"
            />
          </div>
        </SettingsRow>
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

type Tab = 'preferences' | 'caldav' | 'weather' | 'about'

export default function CalendarSettingsPage() {
  const { t } = useTranslation('calendar')
  const [tab, setTab] = useState<Tab>('preferences')

  const tabs: { id: Tab; label: string }[] = [
    { id: 'preferences', label: t('calendar_tab_preferences', { defaultValue: 'Préférences' }) },
    { id: 'caldav',      label: 'CalDAV' },
    { id: 'weather',     label: t('settings_tab_weather', { defaultValue: 'Météo' }) },
    { id: 'about',       label: t('settings_tab_about', { defaultValue: 'À propos' }) },
  ]

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
        {tabs.map(tb => (
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
          {tab === 'about'       && <AboutTab />}
        </div>
      </div>
    </div>
  )
}
