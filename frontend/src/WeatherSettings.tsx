import { useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { MapPin, Plus, Trash2, Search, Star } from 'lucide-react'
import { weatherApi, type GeocodingResult } from './api'
import { useCalendarStore } from './store'
import { FloatingWindow, Input, Spinner } from '@ui'

// ── Geocoding search ──────────────────────────────────────────────────────────

function GeoSearch({ onSelect }: { onSelect: (r: GeocodingResult) => void }) {
  const { t } = useTranslation('calendar')
  const [q, setQ]           = useState('')
  const [results, setResults] = useState<GeocodingResult[]>([])
  const [loading, setLoading] = useState(false)
  const [timer, setTimer]     = useState<ReturnType<typeof setTimeout> | null>(null)

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

// ── Main component ────────────────────────────────────────────────────────────

export default function WeatherSettings({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation('calendar')
  const qc = useQueryClient()
  const { weatherLocationId, setWeatherLocationId } = useCalendarStore()

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
    onSuccess: (_, id) => {
      if (weatherLocationId === id) setWeatherLocationId(null)
      qc.invalidateQueries({ queryKey: ['weather-locations'] })
    },
  })

  return (
    <FloatingWindow
      title={t('weather_locations')}
      icon={<MapPin size={16} className="text-primary" />}
      onClose={onClose}
      defaultWidth={440}
      defaultHeight={480}
      resizable
      backdrop
    >
      <div className="flex flex-col min-h-0 flex-1 p-5">
        {/* Saved locations */}
        <div className="flex-1 overflow-y-auto mb-4">
          {isLoading ? (
            <div className="flex justify-center py-6">
              <Spinner size="md" />
            </div>
          ) : locations.length === 0 ? (
            <p className="text-sm text-text-tertiary text-center py-6 italic">
              {t('weather_no_locations')}<br />{t('weather_no_locations_hint')}
            </p>
          ) : (
            <div className="space-y-1">
              {locations.map(loc => (
                <div key={loc.id}
                  className="flex items-center gap-2 px-3 py-2.5 rounded-lg border border-border hover:bg-surface-1 transition-colors group">
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-text-primary truncate">{loc.name}</div>
                    <div className="text-xs text-text-tertiary">{loc.timezone}</div>
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
                        className="p-1 rounded text-text-tertiary hover:text-primary hover:bg-primary/10 transition-colors opacity-0 group-hover:opacity-100"
                      >
                        <Star size={13} />
                      </button>
                    )}
                    <button
                      onClick={() => deleteMut.mutate(loc.id)}
                      disabled={deleteMut.isPending}
                      title={t('delete')}
                      className="p-1 rounded text-text-tertiary hover:text-danger hover:bg-danger/10 transition-colors opacity-0 group-hover:opacity-100"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Add location */}
        <div className="border-t border-border pt-4 flex-shrink-0">
          <p className="text-xs font-semibold text-text-tertiary uppercase tracking-wider mb-2 flex items-center gap-1">
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
    </FloatingWindow>
  )
}
