// Secondary sections of the settings page: weather locations, CalDAV access and
// the module's "about" card. Kept out of the page shell to keep each file small.
import React, { useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { ExternalLink, Scale, Users, MapPin, Plus, Trash2, Star, Search } from 'lucide-react'
import { Input, Spinner } from '@ui'
import { weatherApi, type GeocodingResult } from '../api'
import CalendarLogo from '../CalendarLogo'
import { Section } from './parts'

// ── Météo ──────────────────────────────────────────────────────────────────────

function GeoSearch({ onSelect }: { onSelect: (r: GeocodingResult) => void }) {
  const { t } = useTranslation('calendar')
  const [q, setQ]             = useState('')
  const [results, setResults] = useState<GeocodingResult[]>([])
  const [loading, setLoading] = useState(false)
  const [timer, setTimer]     = useState<ReturnType<typeof setTimeout> | null>(null)

  const search = useCallback((value: string) => {
    if (timer) clearTimeout(timer)
    if (!value.trim()) { setResults([]); return }
    setLoading(true)
    const id = setTimeout(async () => {
      try {
        const { results: r } = await weatherApi.geocode(value)
        setResults(r)
      } catch { setResults([]) }
      finally { setLoading(false) }
    }, 400)
    setTimer(id)
  }, [timer])

  return (
    <div className="max-w-sm">
      <Input type="text" placeholder={t('weather_search_city')} value={q}
        onChange={e => { setQ(e.target.value); search(e.target.value) }}
        className="w-full" leftIcon={<Search size={14} />}
        rightIcon={loading ? <Spinner size="xs" /> : undefined} />

      {results.length > 0 && (
        <div className="mt-1 border border-border rounded-lg overflow-hidden shadow-sm bg-surface-0">
          {results.map((r, i) => (
            <button key={i} onClick={() => { onSelect(r); setQ(''); setResults([]) }}
              className="w-full flex items-start gap-2 px-3 py-2 text-left hover:bg-surface-1
                         transition-colors border-b border-border last:border-0">
              <MapPin size={13} className="text-text-tertiary mt-0.5 shrink-0" />
              <div>
                <div className="text-text-primary">{r.name}</div>
                <div className="text-xs text-text-tertiary">{[r.admin1, r.country].filter(Boolean).join(', ')}</div>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export function WeatherSection() {
  const { t } = useTranslation('calendar')
  const qc = useQueryClient()

  const { data, isLoading } = useQuery({
    queryKey: ['weather-locations'],
    queryFn:  weatherApi.listLocations,
  })
  const locations = data?.locations ?? []

  const addMut = useMutation({
    mutationFn: (r: GeocodingResult) => weatherApi.addLocation({
      name:      `${r.name}${r.admin1 ? `, ${r.admin1}` : ''}, ${r.country}`,
      latitude:  r.latitude,
      longitude: r.longitude,
      timezone:  r.timezone,
    }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['weather-locations'] }),
  })
  const setDefaultMut = useMutation({
    mutationFn: (id: string) => weatherApi.updateLocation(id, { is_default: true }),
    onSuccess:  () => qc.invalidateQueries({ queryKey: ['weather-locations'] }),
  })
  const deleteMut = useMutation({
    mutationFn: (id: string) => weatherApi.deleteLocation(id),
    onSuccess:  () => qc.invalidateQueries({ queryKey: ['weather-locations'] }),
  })

  return (
    <Section id="weather" title={t('weather_locations')} description={t('weather_locations_help')}>
      <div className="space-y-4 max-w-lg">
        {isLoading ? (
          <Spinner size="md" />
        ) : locations.length === 0 ? (
          <p className="text-text-tertiary italic">{t('weather_no_locations_short')}</p>
        ) : (
          <div className="space-y-1">
            {locations.map(loc => (
              <div key={loc.id} className="flex items-center gap-3 px-3 py-2 border border-border
                                           rounded-lg hover:bg-surface-1 transition-colors group">
                <MapPin size={14} className="text-text-tertiary shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-text-primary truncate">{loc.name}</p>
                  <p className="text-xs text-text-tertiary">{loc.timezone}</p>
                </div>
                {loc.is_default ? (
                  <span className="text-xs text-primary px-1.5 py-0.5 bg-primary/10 rounded">
                    {t('weather_default')}
                  </span>
                ) : (
                  <button onClick={() => setDefaultMut.mutate(loc.id)} title={t('weather_set_default')}
                    className="p-1.5 rounded-lg text-text-tertiary hover:text-primary hover:bg-primary/10
                               transition-colors opacity-0 group-hover:opacity-100">
                    <Star size={13} />
                  </button>
                )}
                <button onClick={() => deleteMut.mutate(loc.id)} disabled={deleteMut.isPending}
                  title={t('delete', { defaultValue: 'Supprimer' })}
                  className="p-1.5 rounded-lg text-text-tertiary hover:text-danger hover:bg-danger/10
                             transition-colors opacity-0 group-hover:opacity-100">
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
          </div>
        )}

        <div>
          <p className="text-xs text-text-tertiary mb-2 flex items-center gap-1">
            <Plus size={11} /> {t('weather_add_location')}
          </p>
          <GeoSearch onSelect={r => addMut.mutate(r)} />
          {addMut.isPending && (
            <p className="text-xs text-text-tertiary mt-2 flex items-center gap-1">
              <Spinner size="xs" /> {t('weather_adding')}
            </p>
          )}
        </div>
        {/* The amCharts credit lives once, on the About page — not repeated here. */}
      </div>
    </Section>
  )
}

// ── À propos ───────────────────────────────────────────────────────────────────

/** One "label / value" fact of the about page (author, license…). */
function Fact({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="flex items-start gap-3">
      <span className="mt-0.5 text-text-tertiary shrink-0">{icon}</span>
      <div className="min-w-0">
        <p className="text-xs text-text-tertiary">{label}</p>
        <p className="text-text-primary truncate">{value}</p>
      </div>
    </div>
  )
}

export function AboutSection() {
  const { t } = useTranslation('calendar')

  const technologies = ['Rust', 'Axum', 'SQLx', 'PostgreSQL', 'CalDAV', 'Open-Meteo']

  return (
    <Section id="about" title={t('settings_tab_about', { defaultValue: 'À propos' })}>
      <div className="max-w-xl">
        {/* Hero: brand logo + name + official-build badge */}
        <div className="flex items-center gap-4">
          <div className="shrink-0 rounded-2xl p-2.5 bg-surface-0 shadow-sm ring-1 ring-border/70">
            <CalendarLogo size={44} />
          </div>
          <div className="min-w-0">
            <h3 className="text-xl text-text-primary leading-tight">Kubuno Calendar</h3>
            <p className="mt-1 text-text-tertiary">{t('about_version_official')}</p>
          </div>
        </div>

        {/* Pitch */}
        <p className="mt-5 text-text-secondary leading-relaxed">{t('about_description')}</p>

        {/* Facts */}
        <div className="mt-6 grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Fact icon={<Users size={16} />} label={t('about_author')} value="Kubuno Contributors" />
          <Fact icon={<Scale size={16} />} label={t('about_license')} value="AGPL-3.0" />
        </div>

        {/* Built with */}
        <div className="mt-6">
          <p className="text-xs text-text-tertiary uppercase tracking-wider mb-2">{t('about_technologies')}</p>
          <div className="flex flex-wrap gap-2">
            {technologies.map(tech => (
              <span key={tech}
                className="inline-flex items-center gap-1.5 rounded-full border border-border
                           bg-surface-0 px-3 py-1 text-xs text-text-secondary">
                <span className="w-1.5 h-1.5 rounded-full bg-primary/70" />
                {tech}
              </span>
            ))}
          </div>
        </div>

        {/* Links */}
        <div className="mt-6 pt-5 border-t border-border space-y-3">
          <a href="https://github.com/kubuno/calendar" target="_blank" rel="noopener noreferrer"
            className="inline-flex items-center gap-2 text-primary hover:underline">
            <ExternalLink size={15} />github.com/kubuno/calendar
          </a>
          <p className="text-xs text-text-tertiary">
            {t('about_weather_credit')}{' '}
            <a href="https://www.amcharts.com/free-animated-svg-weather-icons/"
              target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">amCharts</a>
          </p>
        </div>
      </div>
    </Section>
  )
}
