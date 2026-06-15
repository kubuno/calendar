import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { format, parseISO } from 'date-fns'
import { getDateLocale } from '@kubuno/sdk'
import { weatherApi, wmoInfo, weatherIconUrl, type DailyWeather, type HourlyPoint } from './api'
import { DashboardWidget } from '@kubuno/sdk'
import { useWidgetSize } from '@kubuno/sdk'

// ── Display slots ─────────────────────────────────────────────────────────────
// Today 08:00 → tomorrow 05:00, 3-hour steps (indices into hours[])
const HOUR_INDICES = [8, 11, 14, 17, 20, 23, 26, 29]

type Tab = 'temperature' | 'precipitation' | 'wind'

// ── SVG smooth path (Catmull-Rom spline) ─────────────────────────────────────
function catmullRomPath(pts: { x: number; y: number }[]): string {
  if (pts.length < 2) return ''
  let d = `M ${pts[0].x} ${pts[0].y}`
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(i - 1, 0)]
    const p1 = pts[i]
    const p2 = pts[i + 1]
    const p3 = pts[Math.min(i + 2, pts.length - 1)]
    const cp1x = p1.x + (p2.x - p0.x) / 6
    const cp1y = p1.y + (p2.y - p0.y) / 6
    const cp2x = p2.x - (p3.x - p1.x) / 6
    const cp2y = p2.y - (p3.y - p1.y) / 6
    d += ` C ${cp1x.toFixed(1)} ${cp1y.toFixed(1)} ${cp2x.toFixed(1)} ${cp2y.toFixed(1)} ${p2.x} ${p2.y}`
  }
  return d
}

// ── Wind direction arrow ──────────────────────────────────────────────────────
function WindArrow({ deg, size = 32, color = '#90CAF9' }: { deg: number; size?: number; color?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      style={{ transform: `rotate(${deg}deg)` }}
      className="mx-auto"
    >
      <line x1="12" y1="20" x2="12" y2="5" stroke={color} strokeWidth="2" strokeLinecap="round" />
      <polyline points="7,10 12,5 17,10" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

// ── Temperature SVG chart ─────────────────────────────────────────────────────
function TemperatureChart({ slots }: { slots: HourlyPoint[] }) {
  const temps = slots.map(s => s.temp)
  const tMin = Math.min(...temps) - 3
  const tMax = Math.max(...temps) + 3
  const W = 800
  const H = 90
  const PAD_X = 50  // half-column width
  const colW  = (W - PAD_X * 2) / (slots.length - 1)

  const pts = temps.map((t, i) => ({
    x: PAD_X + i * colW,
    y: 8 + (1 - (t - tMin) / (tMax - tMin)) * 58,
  }))

  const linePath = catmullRomPath(pts)
  const areaPath = `${linePath} L ${pts[pts.length - 1].x} ${H} L ${pts[0].x} ${H} Z`

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: 90 }} preserveAspectRatio="none">
      <defs>
        <linearGradient id="tempGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stopColor="#FDD835" stopOpacity="0.55" />
          <stop offset="100%" stopColor="#FDD835" stopOpacity="0.05" />
        </linearGradient>
      </defs>
      <path d={areaPath} fill="url(#tempGrad)" />
      <path d={linePath} fill="none" stroke="#F9A825" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
      {pts.map((p, i) => (
        <text
          key={i}
          x={p.x}
          y={Math.max(p.y - 5, 12)}
          textAnchor="middle"
          fontSize="11"
          fill="#5f6368"
          fontFamily="system-ui, sans-serif"
        >
          {Math.round(temps[i])}°
        </text>
      ))}
    </svg>
  )
}

// ── Precipitation chart ───────────────────────────────────────────────────────
function PrecipChart({ slots }: { slots: HourlyPoint[] }) {
  const maxProb = Math.max(...slots.map(s => s.precip_prob), 1)
  const hasRain = slots.some(s => s.precip_prob > 0)

  return (
    <div className="w-full" style={{ height: 90 }}>
      {/* Values row */}
      <div className="grid" style={{ gridTemplateColumns: `repeat(${slots.length}, 1fr)`, height: 24 }}>
        {slots.map((s, i) => (
          <div key={i} className="text-center text-xs font-medium" style={{ color: '#1976D2' }}>
            {s.precip_prob}%
          </div>
        ))}
      </div>

      {/* Bar chart area */}
      <div className="relative w-full" style={{ height: 56 }}>
        {hasRain ? (
          <div className="absolute inset-0 flex items-end">
            <div className="grid w-full h-full items-end" style={{ gridTemplateColumns: `repeat(${slots.length}, 1fr)` }}>
              {slots.map((s, i) => {
                const pct = (s.precip_prob / maxProb) * 100
                return (
                  <div key={i} className="flex justify-center items-end h-full px-1">
                    <div
                      className="rounded-t"
                      style={{
                        width: '60%',
                        height: `${pct}%`,
                        backgroundColor: '#90CAF9',
                        minHeight: s.precip_prob > 0 ? 4 : 0,
                      }}
                    />
                  </div>
                )
              })}
            </div>
          </div>
        ) : (
          <div className="absolute bottom-0 left-0 right-0 h-[2px]" style={{ backgroundColor: '#90CAF9' }} />
        )}
      </div>

      {/* Baseline */}
      <div className="w-full h-[1px]" style={{ backgroundColor: '#BBDEFB' }} />
    </div>
  )
}

// ── Wind display ─────────────────────────────────────────────────────────────
function WindDisplay({ slots }: { slots: HourlyPoint[] }) {
  return (
    <div className="w-full" style={{ height: 90 }}>
      {/* Speed values */}
      <div className="grid" style={{ gridTemplateColumns: `repeat(${slots.length}, 1fr)`, height: 22 }}>
        {slots.map((s, i) => (
          <div key={i} className="text-center text-xs text-text-secondary">
            {Math.round(s.wind_speed)} km/h
          </div>
        ))}
      </div>

      {/* Arrows */}
      <div className="grid" style={{ gridTemplateColumns: `repeat(${slots.length}, 1fr)`, height: 44 }}>
        {slots.map((s, i) => (
          <div key={i} className="flex items-center justify-center">
            <WindArrow deg={s.wind_dir} />
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Main widget ───────────────────────────────────────────────────────────────
export default function CalendarWeatherWidget() {
  const { t, i18n } = useTranslation('calendar')
  const [tab, setTab] = useState<Tab>('temperature')
  const [unit, setUnit] = useState<'C' | 'F'>('C')
  const widgetSize = useWidgetSize()

  const { data: locData } = useQuery({
    queryKey:  ['weather-locations'],
    queryFn:   weatherApi.listLocations,
    staleTime: 300_000,
  })

  const defaultLoc = locData?.locations?.find(l => l.is_default) ?? locData?.locations?.[0]

  const { data: forecastData, isLoading } = useQuery({
    queryKey: ['widget-weather-forecast', defaultLoc?.id],
    queryFn:  () => weatherApi.getForecast(defaultLoc!.latitude, defaultLoc!.longitude, defaultLoc!.timezone),
    enabled:  !!defaultLoc,
    staleTime: 1_800_000,
  })

  const daily = forecastData?.forecast?.days ?? []
  const hours = forecastData?.forecast?.hours ?? []

  // small → sm (3 onglets), medium → md (2 onglets + Vent), large → lg (1 onglet + Précip + Vent)
  const size: 'sm' | 'md' | 'lg' = widgetSize === 'large' ? 'lg' : widgetSize === 'medium' ? 'md' : 'sm'
  const daysToShow = size === 'sm' ? 5 : 7

  // 8 slots pour le graphique principal (aujourd'hui + demain matin)
  const slots: HourlyPoint[] = HOUR_INDICES.map(idx => hours[idx]).filter(Boolean)
  // 6 slots pour les panneaux latéraux (08h→23h aujourd'hui)
  const compactSlots: HourlyPoint[] = HOUR_INDICES.slice(0, 6).map(idx => hours[idx]).filter(Boolean)

  const nowHour = new Date().getHours()
  const currentHour = hours[Math.min(nowHour, hours.length - 1)]
  const today = daily[0]
  const currentInfo = today ? wmoInfo(today.weather_code) : { emoji: '🌡️', label: '' }
  const isDayNow = nowHour >= 7 && nowHour < 20

  // Onglets disponibles dans la zone principale
  const mainTabs: Tab[] = size === 'lg'
    ? ['temperature']
    : size === 'md'
      ? ['temperature', 'precipitation']
      : ['temperature', 'precipitation', 'wind']

  useEffect(() => {
    if (!mainTabs.includes(tab)) setTab('temperature')
  }, [size]) // eslint-disable-line react-hooks/exhaustive-deps

  function toDisplayTemp(c: number): number {
    return unit === 'C' ? Math.round(c) : Math.round(c * 9 / 5 + 32)
  }

  // Panneau latéral avec titre + graphique + labels horaires compacts
  function SidePanel({ title, children }: { title: string; children: React.ReactNode }) {
    return (
      <div>
        <div className="flex border-b border-border mb-0">
          <span className="relative px-4 py-2 text-sm font-medium text-text-primary">
            {title}
            <span className="absolute bottom-0 left-0 right-0 h-[3px] rounded-t" style={{ backgroundColor: '#F9A825' }} />
          </span>
        </div>
        <div className="mt-2 mb-1">{children}</div>
        {compactSlots.length > 0 && (
          <div className="grid text-center mt-1" style={{ gridTemplateColumns: `repeat(${compactSlots.length}, 1fr)` }}>
            {compactSlots.map((s, i) => (
              <div key={i} className="text-xs text-text-tertiary">{s.time.slice(11, 16)}</div>
            ))}
          </div>
        )}
      </div>
    )
  }

  return (
    <DashboardWidget title={t('weather')} icon={<img src="/weather-icons/cloudy-day-1.svg" alt="" width={18} height={18} style={{ width: 18, height: 18 }} draggable={false} />}>
      {!defaultLoc ? (
        <div className="px-4 py-6 text-center text-sm text-text-tertiary italic">
          {t('weather_no_location')}
        </div>
      ) : isLoading ? (
        <div className="px-4 py-6 text-center text-sm text-text-tertiary">{t('loading')}</div>
      ) : !today ? (
        <div className="px-4 py-6 text-center text-sm text-text-tertiary italic">
          {t('weather_data_unavailable')}
        </div>
      ) : (
        <div className="px-5 pt-4 pb-3">

          {/* ── Header : toujours pleine largeur ─────────────────────────── */}
          <div className="flex items-start justify-between mb-4">
            <div className="flex items-center gap-4">
              <img
                src={weatherIconUrl(today.weather_code, isDayNow)}
                alt={currentInfo.label}
                width={72} height={72}
                style={{ width: 72, height: 72 }}
                draggable={false}
              />
              <div>
                <div className="flex items-baseline gap-1">
                  <span className="text-5xl font-light text-text-primary">
                    {currentHour ? toDisplayTemp(currentHour.temp) : toDisplayTemp(today.temp_max)}
                  </span>
                  <div className="flex items-center gap-0.5 text-sm text-text-secondary">
                    <button onClick={() => setUnit('C')} className={`font-medium ${unit === 'C' ? 'text-text-primary' : 'hover:text-text-primary'}`}>°C</button>
                    <span className="text-border mx-0.5">|</span>
                    <button onClick={() => setUnit('F')} className={`font-medium ${unit === 'F' ? 'text-text-primary' : 'hover:text-text-primary'}`}>°F</button>
                  </div>
                </div>
                {currentHour && (
                  <div className="text-xs text-text-secondary space-y-0.5 mt-1">
                    <div>{t('weather_precipitation')} : {currentHour.precip_prob}%</div>
                    <div>{t('weather_wind')} : {Math.round(currentHour.wind_speed)} km/h</div>
                  </div>
                )}
              </div>
            </div>
            <div className="text-right">
              <p className="text-2xl font-medium text-[#3d3929] mb-0.5">{t('weather')}</p>
              <p className="text-sm text-[#3d3929]">{format(new Date(), "EEEE HH:mm", { locale: getDateLocale(i18n.language) })}</p>
              <p className="text-sm text-text-secondary mt-0.5">{currentInfo.label}</p>
              <p className="text-xs text-text-tertiary mt-1">{defaultLoc.name}</p>
            </div>
          </div>

          {/* ── Ligne graphiques : colonnes proportionnelles ──────────────── */}
          {/*   sm : 1 colonne pleine largeur                                 */}
          {/*   md : col-gauche 50% (onglets) | col-droite 50% (Vent)         */}
          {/*   lg : 1/3 (onglets) | 1/3 (Précipitations) | 1/3 (Vent)       */}
          <div className={size !== 'sm' ? 'flex items-start' : ''}>

            {/* Col gauche : barre d'onglets + graphique actif */}
            <div className={
              size === 'lg' ? 'w-1/3 pr-5' :
              size === 'md' ? 'w-1/2 pr-5' :
              'w-full'
            }>
              <div className="flex border-b border-border">
                {mainTabs.map(id => {
                  const label = id === 'temperature' ? t('weather_temperature') : id === 'precipitation' ? t('weather_precipitation') : t('weather_wind')
                  return (
                    <button
                      key={id}
                      onClick={() => setTab(id)}
                      className={`relative px-4 py-2 text-sm font-medium transition-colors
                        ${tab === id ? 'text-text-primary' : 'text-text-secondary hover:text-text-primary'}`}
                    >
                      {label}
                      {tab === id && (
                        <span className="absolute bottom-0 left-0 right-0 h-[3px] rounded-t" style={{ backgroundColor: '#F9A825' }} />
                      )}
                    </button>
                  )
                })}
              </div>
              {slots.length >= 8 && (
                <>
                  <div className="mt-2 mb-1">
                    {tab === 'temperature'   && <TemperatureChart slots={slots} />}
                    {tab === 'precipitation' && <PrecipChart     slots={slots} />}
                    {tab === 'wind'          && <WindDisplay     slots={slots} />}
                  </div>
                  <div className="grid text-center mt-1" style={{ gridTemplateColumns: `repeat(${slots.length}, 1fr)` }}>
                    {slots.map((s, i) => (
                      <div key={i} className="text-xs text-text-tertiary">{s.time.slice(11, 16)}</div>
                    ))}
                  </div>
                </>
              )}
            </div>

            {/* Col centre : Précipitations (lg) ou Vent (md) */}
            {size !== 'sm' && compactSlots.length >= 4 && (
              <div className={`${size === 'lg' ? 'w-1/3 px-5' : 'w-1/2 pl-5'} border-l border-border`}>
                {size === 'lg'
                  ? <SidePanel title={t('weather_precipitation')}><PrecipChart slots={compactSlots} /></SidePanel>
                  : <SidePanel title={t('weather_wind')}><WindDisplay slots={compactSlots} /></SidePanel>
                }
              </div>
            )}

            {/* Col droite : Vent (lg uniquement) */}
            {size === 'lg' && compactSlots.length >= 4 && (
              <div className="w-1/3 pl-5 border-l border-border">
                <SidePanel title={t('weather_wind')}><WindDisplay slots={compactSlots} /></SidePanel>
              </div>
            )}
          </div>

          {/* ── Bas : grille journalière + détails (lg) ──────────────────── */}
          <div className="mt-4 pt-3 border-t border-border">
            <div className="flex items-center gap-0">

              {/* Grille journalière — colonnes fixes 72px */}
              <div className="grid flex-shrink-0" style={{ gridTemplateColumns: `repeat(${daysToShow}, 72px)` }}>
                {daily.slice(0, daysToShow).map((day: DailyWeather, i) => {
                  const info = wmoInfo(day.weather_code)
                  return (
                    <div key={day.date} className={`flex flex-col items-center gap-1 py-2 px-1 rounded-lg ${i === 0 ? 'bg-surface-1' : ''}`}>
                      <p className="text-xs font-medium text-text-secondary capitalize">
                        {format(parseISO(day.date), 'EEE', { locale: getDateLocale(i18n.language) })}
                      </p>
                      <img
                        src={weatherIconUrl(day.weather_code, true)}
                        alt={info.label}
                        width={40} height={40}
                        style={{ width: 40, height: 40 }}
                        draggable={false}
                      />
                      <div className="text-xs text-center">
                        <span className="font-medium text-text-primary">{toDisplayTemp(day.temp_max)}°</span>
                        {' '}
                        <span className="text-text-tertiary">{toDisplayTemp(day.temp_min)}°</span>
                      </div>
                    </div>
                  )
                })}
              </div>

              {/* Détails conditions — lg uniquement, à droite de la grille */}
              {size === 'lg' && currentHour && (
                <div className="flex-1 flex items-center justify-around pl-5 ml-3 border-l border-border self-stretch">
                  {[
                    { label: t('weather_feels_like'), value: `${toDisplayTemp(currentHour.feels_like)}°${unit}` },
                    { label: t('weather_humidity'),   value: `${currentHour.humidity}%` },
                    { label: t('weather_uv_index'),   value: today.uv_index_max > 0 ? today.uv_index_max.toFixed(1) : '—' },
                    {
                      label: t('weather_sunrise_sunset'),
                      value: today.sunrise && today.sunset
                        ? `${today.sunrise.slice(11, 16)} / ${today.sunset.slice(11, 16)}`
                        : '—',
                    },
                  ].map(({ label, value }) => (
                    <div key={label} className="text-center">
                      <p className="text-[10px] text-text-tertiary uppercase tracking-wide mb-1">{label}</p>
                      <p className="text-sm font-semibold text-text-primary">{value}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </DashboardWidget>
  )
}
