import { useState, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { formatDate, toDate, DashboardWidget, useWidgetSize } from '@kubuno/sdk'
import {
  Thermometer, Droplets, Wind, Gauge, Sun, Eye, Cloud, Leaf,
  Sunrise, Sunset, MapPin,
} from 'lucide-react'
import type { TFunction } from 'i18next'
import { Dropdown } from '@ui'
import {
  weatherApi, wmoKey, weatherIconUrl,
  type DailyWeather, type HourlyPoint, type CurrentWeather, type WeatherLocation,
} from './api'
import { MonoText } from './MonoText'

// Persisted UI preferences (per-browser; the widget config API is host-side only).
const UNIT_KEY = 'kubuno:weather-unit'
const LOC_KEY  = 'kubuno:weather-widget-location'

type Unit = 'C' | 'F'
type Tab  = 'temperature' | 'precipitation' | 'wind'

// ── Colour helpers ────────────────────────────────────────────────────────────

/** Temperature → a warm/cool hue (cold blue → hot red). */
function tempColor(c: number): string {
  const t = Math.max(-10, Math.min(40, c))
  const hue = 210 - ((t + 10) / 50) * 198  // 210° (cold) → 12° (hot)
  return `hsl(${hue.toFixed(0)}, 82%, 52%)`
}

/** Sky gradient for the hero, by condition + day/night. */
function skyGradient(code: number, isDay: boolean): string {
  if (!isDay) {
    if (code >= 61 && code <= 99) return 'linear-gradient(155deg,#2c3a4a 0%,#171f2b 100%)'
    if (code === 0 || code === 1) return 'linear-gradient(155deg,#1b3a6b 0%,#0d1526 100%)'
    return 'linear-gradient(155deg,#243244 0%,#151d2a 100%)'
  }
  if (code === 0 || code === 1) return 'linear-gradient(155deg,#2b8fe6 0%,#66b3f2 100%)'
  if (code === 2)               return 'linear-gradient(155deg,#4a92d6 0%,#84add0 100%)'
  if (code === 3 || code <= 49) return 'linear-gradient(155deg,#6d7d90 0%,#9fabb9 100%)'
  if (code <= 67)               return 'linear-gradient(155deg,#4a6382 0%,#728499 100%)'
  if (code <= 77)               return 'linear-gradient(155deg,#7d92a6 0%,#adb9c5 100%)'
  if (code <= 82)               return 'linear-gradient(155deg,#57718f 0%,#7f91a5 100%)'
  if (code <= 99)               return 'linear-gradient(155deg,#39434f 0%,#586675 100%)'
  return 'linear-gradient(155deg,#4a92d6 0%,#84add0 100%)'
}

function uvBand(uv: number, t: TFunction): { label: string; color: string; pct: number } {
  const pct = Math.min(100, (uv / 11) * 100)
  if (uv < 3)  return { label: t('uv_low'),       color: '#43a047', pct }
  if (uv < 6)  return { label: t('uv_moderate'),  color: '#f9a825', pct }
  if (uv < 8)  return { label: t('uv_high'),      color: '#ef6c00', pct }
  if (uv < 11) return { label: t('uv_very_high'), color: '#d32f2f', pct }
  return { label: t('uv_extreme'), color: '#8e24aa', pct }
}

/** European AQI bands (0–20 good … >100 extremely poor). */
function aqiBand(aqi: number, t: TFunction): { label: string; color: string; pct: number } {
  const pct = Math.min(100, (aqi / 120) * 100)
  if (aqi <= 20)  return { label: t('aqi_good'),      color: '#4cc4a0', pct }
  if (aqi <= 40)  return { label: t('aqi_fair'),      color: '#8bc34a', pct }
  if (aqi <= 60)  return { label: t('aqi_moderate'),  color: '#f5c542', pct }
  if (aqi <= 80)  return { label: t('aqi_poor'),      color: '#ef8c42', pct }
  if (aqi <= 100) return { label: t('aqi_very_poor'), color: '#e0483f', pct }
  return { label: t('aqi_extreme'), color: '#8d54a0', pct }
}

const DIR_KEYS = ['dir_n', 'dir_ne', 'dir_e', 'dir_se', 'dir_s', 'dir_sw', 'dir_w', 'dir_nw']
function cardinal(deg: number, t: TFunction): string {
  return t(DIR_KEYS[Math.round(deg / 45) % 8])
}

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

// ── Wind compass ──────────────────────────────────────────────────────────────
function WindCompass({ deg, size = 56 }: { deg: number; size?: number }) {
  const c = size / 2
  return (
    <svg width={size} height={size} viewBox="0 0 56 56">
      <circle cx="28" cy="28" r="25" fill="none" stroke="var(--color-border)" strokeWidth="1.5" />
      {[0, 90, 180, 270].map(a => {
        const rad = (a - 90) * Math.PI / 180
        return (
          <line
            key={a}
            x1={c + Math.cos(rad) * 22} y1={c + Math.sin(rad) * 22}
            x2={c + Math.cos(rad) * 25} y2={c + Math.sin(rad) * 25}
            stroke="var(--color-text-tertiary)" strokeWidth="1.5"
          />
        )
      })}
      {/* Arrow shows where the wind blows TO (dir is where it comes FROM). */}
      <g transform={`rotate(${deg} 28 28)`}>
        <path d="M28 12 L33 30 L28 26 L23 30 Z" fill="var(--color-primary)" />
        <line x1="28" y1="26" x2="28" y2="44" stroke="var(--color-primary)" strokeWidth="2" strokeLinecap="round" opacity="0.5" />
      </g>
    </svg>
  )
}

// ── Sunrise/sunset arc ─────────────────────────────────────────────────────────
function SunArc({ sunrise, sunset, t }: {
  sunrise: string | null; sunset: string | null; t: TFunction
}) {
  if (!sunrise || !sunset) return null
  const rise = toDate(sunrise).getTime()
  const set  = toDate(sunset).getTime()
  const now  = Date.now()
  const frac = Math.max(0, Math.min(1, (now - rise) / (set - rise)))
  // Arc: semicircle from (10,60) to (170,60), peak at (90,10)
  const W = 180, H = 66
  const ax = 10 + frac * 160
  const ay = 60 - Math.sin(frac * Math.PI) * 50
  const isUp = now >= rise && now <= set

  const arcPath = 'M 10 60 Q 90 -30 170 60'
  return (
    <div className="flex flex-col items-center">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ maxWidth: 220, height: 70 }}>
        <path d={arcPath} fill="none" stroke="var(--color-border)" strokeWidth="2" strokeDasharray="3 3" />
        <path
          d={arcPath} fill="none" stroke="#f9a825" strokeWidth="2.5" strokeLinecap="round"
          pathLength={1} strokeDasharray={1} strokeDashoffset={1 - frac}
        />
        {isUp && (
          <circle cx={ax} cy={ay} r="6" fill="#f9a825" stroke="#fff" strokeWidth="1.5">
          </circle>
        )}
        <line x1="6" y1="60" x2="174" y2="60" stroke="var(--color-border)" strokeWidth="1" />
      </svg>
      <div className="flex items-center justify-between w-full text-xs" style={{ maxWidth: 220 }}>
        <span className="flex items-center gap-1 text-text-secondary">
          <Sunrise size={13} className="text-amber-500" />
          <MonoText>{formatDate(toDate(sunrise), 'time')}</MonoText>
        </span>
        <span className="flex items-center gap-1 text-text-secondary">
          <Sunset size={13} className="text-orange-500" />
          <MonoText>{formatDate(toDate(sunset), 'time')}</MonoText>
        </span>
      </div>
      <span className="text-[10px] text-text-tertiary uppercase tracking-wide mt-1">{t('weather_sunrise_sunset')}</span>
    </div>
  )
}

// ── Temperature chart ─────────────────────────────────────────────────────────
function TemperatureChart({ slots, toDisplay }: { slots: HourlyPoint[]; toDisplay: (c: number) => number }) {
  const temps = slots.map(s => s.temp)
  const tMin = Math.min(...temps) - 3
  const tMax = Math.max(...temps) + 3
  const W = 800, H = 96, PAD_X = 50
  const colW = (W - PAD_X * 2) / (slots.length - 1)
  const pts = temps.map((t, i) => ({
    x: PAD_X + i * colW,
    y: 12 + (1 - (t - tMin) / (tMax - tMin)) * 58,
  }))
  const linePath = catmullRomPath(pts)
  const areaPath = `${linePath} L ${pts[pts.length - 1].x} ${H} L ${pts[0].x} ${H} Z`
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: 96 }} preserveAspectRatio="none">
      <defs>
        <linearGradient id="tempGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stopColor="#f9a825" stopOpacity="0.5" />
          <stop offset="100%" stopColor="#f9a825" stopOpacity="0.02" />
        </linearGradient>
      </defs>
      <path d={areaPath} fill="url(#tempGrad)" />
      <path d={linePath} fill="none" stroke="#f59f00" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
      {pts.map((p, i) => (
        <text key={i} x={p.x} y={Math.max(p.y - 6, 12)} textAnchor="middle" fontSize="12"
          fill="var(--color-text-secondary)" fontFamily="system-ui, sans-serif" fontWeight="600">
          {toDisplay(temps[i])}°
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
    <div className="w-full" style={{ height: 96 }}>
      <div className="grid" style={{ gridTemplateColumns: `repeat(${slots.length}, 1fr)`, height: 24 }}>
        {slots.map((s, i) => (
          <div key={i} className="text-center text-xs font-semibold" style={{ color: '#1976d2' }}>
            {s.precip_prob > 0 ? `${s.precip_prob}%` : ''}
          </div>
        ))}
      </div>
      <div className="relative w-full" style={{ height: 60 }}>
        {hasRain ? (
          <div className="grid w-full h-full items-end" style={{ gridTemplateColumns: `repeat(${slots.length}, 1fr)` }}>
            {slots.map((s, i) => (
              <div key={i} className="flex justify-center items-end h-full px-1">
                <div className="rounded-t" style={{
                  width: '58%',
                  height: `${(s.precip_prob / maxProb) * 100}%`,
                  background: 'linear-gradient(180deg,#64b5f6,#1976d2)',
                  minHeight: s.precip_prob > 0 ? 4 : 0,
                }} />
              </div>
            ))}
          </div>
        ) : (
          <div className="absolute bottom-0 left-0 right-0 h-[2px]" style={{ backgroundColor: '#90caf9' }} />
        )}
      </div>
      <div className="w-full h-[1px]" style={{ backgroundColor: 'var(--color-border)' }} />
    </div>
  )
}

// ── Wind display ─────────────────────────────────────────────────────────────
function WindDisplay({ slots }: { slots: HourlyPoint[] }) {
  return (
    <div className="w-full" style={{ height: 96 }}>
      <div className="grid" style={{ gridTemplateColumns: `repeat(${slots.length}, 1fr)`, height: 24 }}>
        {slots.map((s, i) => (
          <div key={i} className="text-center text-xs text-text-secondary font-medium">
            {Math.round(s.wind_speed)}
          </div>
        ))}
      </div>
      <div className="grid" style={{ gridTemplateColumns: `repeat(${slots.length}, 1fr)`, height: 48 }}>
        {slots.map((s, i) => (
          <div key={i} className="flex items-center justify-center">
            <svg width={30} height={30} viewBox="0 0 24 24" style={{ transform: `rotate(${s.wind_dir}deg)` }}>
              <line x1="12" y1="20" x2="12" y2="5" stroke="#5b8def" strokeWidth="2" strokeLinecap="round" />
              <polyline points="7,10 12,5 17,10" fill="none" stroke="#5b8def" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Metric tile ────────────────────────────────────────────────────────────────
function MetricTile({ icon, label, value, sub, accent }: {
  icon: React.ReactNode; label: string; value: React.ReactNode; sub?: React.ReactNode; accent?: string
}) {
  return (
    <div className="rounded-xl bg-black/[0.035] p-3 flex flex-col gap-1 min-w-0">
      <div className="flex items-center gap-1.5 text-text-tertiary">
        <span style={accent ? { color: accent } : undefined}>{icon}</span>
        <span className="text-[11px] uppercase tracking-wide font-medium truncate">{label}</span>
      </div>
      <div className="text-lg font-semibold text-text-primary leading-tight truncate">{value}</div>
      {sub && <div className="text-xs text-text-tertiary truncate">{sub}</div>}
    </div>
  )
}

// ── Main widget ───────────────────────────────────────────────────────────────
export default function CalendarWeatherWidget() {
  const { t, i18n } = useTranslation('calendar')
  const widgetSize = useWidgetSize()
  const size: 'sm' | 'md' | 'lg' = widgetSize === 'large' ? 'lg' : widgetSize === 'medium' ? 'md' : 'sm'

  const [unit, setUnit] = useState<Unit>(() => (localStorage.getItem(UNIT_KEY) as Unit) || 'C')
  const [tab, setTab]   = useState<Tab>('temperature')
  const [locId, setLocId] = useState<string | null>(() => localStorage.getItem(LOC_KEY))
  useEffect(() => { localStorage.setItem(UNIT_KEY, unit) }, [unit])

  const { data: locData } = useQuery({
    queryKey:  ['weather-locations'],
    queryFn:   weatherApi.listLocations,
    staleTime: 300_000,
  })
  const locations: WeatherLocation[] = locData?.locations ?? []
  const activeLoc =
    locations.find(l => l.id === locId) ??
    locations.find(l => l.is_default) ??
    locations[0]

  const { data: forecastData, isLoading } = useQuery({
    queryKey: ['widget-weather-forecast', activeLoc?.id],
    queryFn:  () => weatherApi.getForecast(activeLoc!.latitude, activeLoc!.longitude, activeLoc!.timezone),
    enabled:  !!activeLoc,
    staleTime: 900_000,
  })

  const daily: DailyWeather[] = forecastData?.forecast?.days ?? []
  const hours: HourlyPoint[]  = forecastData?.forecast?.hours ?? []
  const air = forecastData?.forecast?.air ?? null
  const today = daily[0]

  // hours[0] is the current hour (Open-Meteo forecast_hours). Use the dedicated
  // `current` block for the hero (interpolated, more precise), else fall back.
  const current: CurrentWeather | null = forecastData?.forecast?.current ?? (hours[0] ? {
    ...hours[0], wind_gust: hours[0].wind_gust,
  } as CurrentWeather : null)

  const toDisplay = (c: number): number => unit === 'C' ? Math.round(c) : Math.round(c * 9 / 5 + 32)

  // Charts use 8 evenly-spread points across the next ~24h.
  const chartSlots: HourlyPoint[] = useMemo(() => {
    const step = Math.max(1, Math.floor(hours.length / 8))
    return Array.from({ length: 8 }, (_, i) => hours[i * step]).filter(Boolean)
  }, [hours])

  const hourly24 = hours.slice(0, 24)
  const daysToShow = size === 'sm' ? 5 : 7

  const cond = current ? t(wmoKey(current.weather_code)) : ''
  const isDayNow = current?.is_day ?? true

  const locOptions = locations.map(l => ({ value: l.id, label: l.name }))

  // Metric tiles (source of truth = current hour / today).
  const tiles = useMemo(() => {
    if (!current || !today) return []
    const uv = uvBand(today.uv_index_max, t)
    const list: { key: string; icon: React.ReactNode; label: string; value: React.ReactNode; sub?: React.ReactNode; accent?: string }[] = [
      {
        key: 'feels', icon: <Thermometer size={14} />, label: t('weather_feels_like'),
        value: `${toDisplay(current.feels_like)}°`, accent: tempColor(current.feels_like),
      },
      {
        key: 'humidity', icon: <Droplets size={14} />, label: t('weather_humidity'),
        value: `${current.humidity}%`, accent: '#2196f3',
      },
      {
        key: 'wind', icon: <Wind size={14} />, label: t('weather_wind'),
        value: `${Math.round(current.wind_speed)} km/h`,
        sub: `${cardinal(current.wind_dir, t)} · ${t('weather_wind_gust')} ${Math.round(current.wind_gust)}`,
      },
      {
        key: 'pressure', icon: <Gauge size={14} />, label: t('weather_pressure'),
        value: `${Math.round(current.pressure)}`, sub: 'hPa',
      },
      {
        key: 'uv', icon: <Sun size={14} />, label: t('weather_uv'),
        value: today.uv_index_max.toFixed(1), sub: uv.label, accent: uv.color,
      },
      {
        key: 'visibility', icon: <Eye size={14} />, label: t('weather_visibility'),
        value: `${Math.round((hours[0]?.visibility ?? 0) / 1000)} km`,
      },
      {
        key: 'cloud', icon: <Cloud size={14} />, label: t('weather_cloud_cover'),
        value: `${current.cloud_cover}%`,
      },
    ]
    if (air?.european_aqi != null) {
      const a = aqiBand(air.european_aqi, t)
      list.push({
        key: 'air', icon: <Leaf size={14} />, label: t('weather_air_quality'),
        value: String(air.european_aqi), sub: a.label, accent: a.color,
      })
    }
    return list
  }, [current, today, air, unit, hours, i18n.language]) // eslint-disable-line react-hooks/exhaustive-deps

  const tileCount = size === 'sm' ? 4 : size === 'md' ? 6 : 8
  const tileCols  = size === 'sm' ? 'grid-cols-2' : size === 'md' ? 'grid-cols-3' : 'grid-cols-4'

  const mainTabs: Tab[] = ['temperature', 'precipitation', 'wind']

  const titleIcon = current
    ? <img src={weatherIconUrl(current.weather_code, isDayNow)} alt="" width={18} height={18} style={{ width: 18, height: 18 }} draggable={false} />
    : <img src="/weather-icons/cloudy-day-1.svg" alt="" width={18} height={18} style={{ width: 18, height: 18 }} draggable={false} />

  return (
    <DashboardWidget title={t('weather')} icon={titleIcon}>
      {!activeLoc ? (
        <div className="px-4 py-10 text-center text-sm text-text-tertiary italic">{t('weather_no_location')}</div>
      ) : isLoading ? (
        <div className="px-4 py-10 text-center text-sm text-text-tertiary">{t('loading')}</div>
      ) : !current || !today ? (
        <div className="px-4 py-10 text-center text-sm text-text-tertiary italic">{t('weather_data_unavailable')}</div>
      ) : (
        <div className="flex flex-col">

          {/* ── Hero (full-bleed sky gradient) ───────────────────────────── */}
          <div
            className="relative px-5 py-4 text-white"
            style={{ background: skyGradient(current.weather_code, isDayNow) }}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-3 min-w-0">
                <img
                  src={weatherIconUrl(current.weather_code, isDayNow)}
                  alt={cond}
                  width={size === 'sm' ? 60 : 76} height={size === 'sm' ? 60 : 76}
                  style={{ width: size === 'sm' ? 60 : 76, height: size === 'sm' ? 60 : 76, filter: 'drop-shadow(0 2px 6px rgba(0,0,0,0.25))' }}
                  draggable={false}
                />
                <div className="min-w-0">
                  <div className="flex items-start gap-1">
                    <span className={`${size === 'sm' ? 'text-5xl' : 'text-6xl'} font-extralight leading-none tracking-tight`}>
                      {toDisplay(current.temp)}°
                    </span>
                    <div className="flex flex-col gap-0.5 mt-1 text-sm">
                      <button onClick={() => setUnit('C')} className={`font-semibold leading-none transition-opacity ${unit === 'C' ? 'opacity-100' : 'opacity-50 hover:opacity-80'}`}>C</button>
                      <button onClick={() => setUnit('F')} className={`font-semibold leading-none transition-opacity ${unit === 'F' ? 'opacity-100' : 'opacity-50 hover:opacity-80'}`}>F</button>
                    </div>
                  </div>
                  <p className="text-sm font-medium mt-1 truncate opacity-95">{cond}</p>
                  <p className="text-xs opacity-80 mt-0.5">
                    {t('weather_feels_like')} {toDisplay(current.feels_like)}° · ↑{toDisplay(today.temp_max)}° ↓{toDisplay(today.temp_min)}°
                  </p>
                </div>
              </div>

              <div className="flex flex-col items-end gap-1 shrink-0">
                {locations.length > 1 ? (
                  <Dropdown
                    value={activeLoc.id}
                    onChange={(v: string) => { setLocId(v); localStorage.setItem(LOC_KEY, v) }}
                    options={locOptions}
                    width={size === 'sm' ? 120 : 150}
                    height={30}
                    fontSize={13}
                  />
                ) : (
                  <span className="flex items-center gap-1 text-sm font-medium">
                    <MapPin size={13} className="opacity-80" />{activeLoc.name}
                  </span>
                )}
                <span className="text-xs opacity-80 capitalize">
                  {formatDate(new Date(), 'weekdayTime')}
                </span>
              </div>
            </div>
          </div>

          {/* ── Hourly strip (next 24h) ──────────────────────────────────── */}
          {hourly24.length > 0 && (
            <div className="px-3 py-3 border-b border-border overflow-x-auto">
              <div className="flex gap-1 min-w-min">
                {hourly24.map((h, i) => (
                  <div key={h.time} className="flex flex-col items-center gap-1 px-2 py-1 rounded-lg shrink-0"
                    style={{ minWidth: 46 }}>
                    <span className="text-[11px] text-text-tertiary font-medium">
                      {i === 0 ? t('weather_now') : String((toDate(h.time)).getHours()).padStart(2, '0')}
                    </span>
                    <img src={weatherIconUrl(h.weather_code, h.is_day)} alt="" width={30} height={30}
                      style={{ width: 30, height: 30 }} draggable={false} />
                    <span className="text-sm font-semibold text-text-primary">{toDisplay(h.temp)}°</span>
                    <span className="text-[10px] font-medium" style={{ color: h.precip_prob > 0 ? '#1976d2' : 'transparent' }}>
                      {h.precip_prob > 0 ? `${h.precip_prob}%` : '·'}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── Metric tiles ─────────────────────────────────────────────── */}
          <div className={`grid ${tileCols} gap-2 p-3`}>
            {tiles.slice(0, tileCount).map(tile => (
              <MetricTile key={tile.key} icon={tile.icon} label={tile.label} value={tile.value} sub={tile.sub} accent={tile.accent} />
            ))}
          </div>

          {/* ── Charts + sun arc ─────────────────────────────────────────── */}
          {size !== 'sm' && chartSlots.length >= 6 && (
            <div className={`px-4 pb-3 ${size === 'lg' ? 'flex items-start gap-4' : ''}`}>
              <div className={size === 'lg' ? 'flex-1 min-w-0' : ''}>
                <div className="flex border-b border-border">
                  {mainTabs.map(id => {
                    const label = id === 'temperature' ? t('weather_temperature') : id === 'precipitation' ? t('weather_precipitation') : t('weather_wind')
                    return (
                      <button key={id} onClick={() => setTab(id)}
                        className={`relative px-3 py-2 text-sm font-medium transition-colors ${tab === id ? 'text-text-primary' : 'text-text-secondary hover:text-text-primary'}`}>
                        {label}
                        {tab === id && <span className="absolute bottom-0 left-0 right-0 h-[3px] rounded-t bg-primary" />}
                      </button>
                    )
                  })}
                </div>
                <div className="mt-2">
                  {tab === 'temperature'   && <TemperatureChart slots={chartSlots} toDisplay={toDisplay} />}
                  {tab === 'precipitation' && <PrecipChart slots={chartSlots} />}
                  {tab === 'wind'          && <WindDisplay slots={chartSlots} />}
                </div>
                <div className="grid text-center mt-1" style={{ gridTemplateColumns: `repeat(${chartSlots.length}, 1fr)` }}>
                  {chartSlots.map((s, i) => (
                    <div key={i} className="text-xs text-text-tertiary">{s.time.slice(11, 16)}</div>
                  ))}
                </div>
              </div>

              {size === 'lg' && (
                <div className="w-52 shrink-0 flex flex-col items-center pt-2 border-l border-border pl-4">
                  <div className="flex items-center gap-3 mb-2">
                    <WindCompass deg={current.wind_dir} />
                    <div className="text-sm">
                      <div className="font-semibold text-text-primary">{Math.round(current.wind_speed)} km/h</div>
                      <div className="text-xs text-text-tertiary">{cardinal(current.wind_dir, t)}</div>
                    </div>
                  </div>
                  <SunArc sunrise={today.sunrise} sunset={today.sunset} t={t} />
                </div>
              )}
            </div>
          )}

          {/* Sun arc (md, below charts) */}
          {size === 'md' && (
            <div className="px-4 pb-3 flex justify-center">
              <SunArc sunrise={today.sunrise} sunset={today.sunset} t={t} />
            </div>
          )}

          {/* ── 7-day forecast ───────────────────────────────────────────── */}
          <div className="px-3 pb-3 pt-1 border-t border-border">
            <p className="text-[11px] uppercase tracking-wide font-semibold text-text-tertiary px-1 py-1.5">
              {t('weather_daily_forecast')}
            </p>
            <DailyList days={daily.slice(0, daysToShow)} toDisplay={toDisplay} />
          </div>
        </div>
      )}
    </DashboardWidget>
  )
}

// ── 7-day list with hi/lo range bars ─────────────────────────────────────────
function DailyList({ days, toDisplay }: {
  days: DailyWeather[]; toDisplay: (c: number) => number
}) {
  const weekMin = Math.min(...days.map(d => d.temp_min))
  const weekMax = Math.max(...days.map(d => d.temp_max))
  const span = Math.max(1, weekMax - weekMin)
  const todayStr = new Date().toISOString().slice(0, 10)

  return (
    <div className="flex flex-col">
      {days.map(day => {
        const left  = ((day.temp_min - weekMin) / span) * 100
        const width = ((day.temp_max - day.temp_min) / span) * 100
        const isToday = day.date === todayStr
        return (
          <div key={day.date} className="flex items-center gap-2 py-1.5 px-1 rounded-lg hover:bg-surface-1 transition-colors">
            <span className={`w-9 text-sm capitalize shrink-0 ${isToday ? 'font-semibold text-text-primary' : 'text-text-secondary'}`}>
              {formatDate(toDate(day.date), 'weekdayShort')}
            </span>
            <img src={weatherIconUrl(day.weather_code, true)} alt="" width={28} height={28}
              style={{ width: 28, height: 28 }} draggable={false} className="shrink-0" />
            <span className="w-9 text-xs text-right shrink-0" style={{ color: day.precip_prob_max > 20 ? '#1976d2' : 'transparent' }}>
              {day.precip_prob_max > 20 ? `${day.precip_prob_max}%` : ''}
            </span>
            <span className="w-8 text-sm text-right text-text-tertiary shrink-0 tabular-nums">{toDisplay(day.temp_min)}°</span>
            <div className="flex-1 h-1.5 rounded-full bg-surface-2 relative min-w-8">
              <div className="absolute h-full rounded-full" style={{
                left: `${left}%`, width: `${Math.max(width, 6)}%`,
                background: `linear-gradient(90deg, ${tempColor(day.temp_min)}, ${tempColor(day.temp_max)})`,
              }} />
            </div>
            <span className="w-8 text-sm text-right font-medium text-text-primary shrink-0 tabular-nums">{toDisplay(day.temp_max)}°</span>
          </div>
        )
      })}
    </div>
  )
}
