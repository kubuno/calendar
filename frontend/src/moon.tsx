import type { TFunction } from 'i18next'
// Moon phases — 100% client-side computation (no API): position within the
// synodic cycle since a reference new moon, plenty accurate for a calendar
// (± a few hours over several decades).
//
// The icon is a drawn SVG (dark disc + lit part via an elliptical arc),
// consistent with the app style — no emoji.

/** Mean length of the synodic month (days). */
const SYNODIC = 29.530588853
/** Reference new moon: January 6, 2000, 18:14 UTC. */
const NEW_MOON_EPOCH = Date.UTC(2000, 0, 6, 18, 14)

/** Position within the cycle [0, 1) — 0 = new moon, 0.5 = full moon. */
export function moonPhase(date: Date): number {
  const days = (date.getTime() - NEW_MOON_EPOCH) / 86_400_000
  return (((days % SYNODIC) + SYNODIC) % SYNODIC) / SYNODIC
}

/** Illuminated fraction of the disc [0, 1]. */
export function moonIllumination(date: Date): number {
  return (1 - Math.cos(2 * Math.PI * moonPhase(date))) / 2
}

export type PrincipalPhase = 'new' | 'first-quarter' | 'full' | 'last-quarter'

/**
 * Principal phase reached on THAT day (local time), if any: new moon, first
 * quarter, full moon or last quarter — like the markers on a paper calendar.
 */
export function principalPhaseOfDay(day: Date): PrincipalPhase | null {
  const start = new Date(day); start.setHours(0, 0, 0, 0)
  const end   = new Date(start.getTime() + 86_400_000)
  const p0 = moonPhase(start)
  const p1raw = moonPhase(end)
  // Unwrap the 1 → 0 rollover so crossings can be tested with a plain interval.
  const p1 = p1raw < p0 ? p1raw + 1 : p1raw
  for (const [target, phase] of [
    [0.25, 'first-quarter'], [0.5, 'full'], [0.75, 'last-quarter'], [1, 'new'],
  ] as [number, PrincipalPhase][]) {
    if (p0 < target && target <= p1) return phase
  }
  return null
}

/** Name (i18n key + FR default) of the phase on the given day (8 phases). */
export function moonPhaseName(date: Date, t: TFunction): string {
  const p = moonPhase(date)
  // Half-day window around the principal phases, otherwise an intermediate phase.
  const half = 0.5 / SYNODIC
  if (p < half || p > 1 - half) return t('moon_new',             { defaultValue: 'Nouvelle lune' })
  if (Math.abs(p - 0.25) < half) return t('moon_first_quarter',  { defaultValue: 'Premier quartier' })
  if (Math.abs(p - 0.5)  < half) return t('moon_full',           { defaultValue: 'Pleine lune' })
  if (Math.abs(p - 0.75) < half) return t('moon_last_quarter',   { defaultValue: 'Dernier quartier' })
  if (p < 0.25) return t('moon_waxing_crescent', { defaultValue: 'Premier croissant' })
  if (p < 0.5)  return t('moon_waxing_gibbous',  { defaultValue: 'Gibbeuse croissante' })
  if (p < 0.75) return t('moon_waning_gibbous',  { defaultValue: 'Gibbeuse décroissante' })
  return t('moon_waning_crescent', { defaultValue: 'Dernier croissant' })
}

const PRINCIPAL_PHASE_VALUE: Record<PrincipalPhase, number> = {
  new: 0, 'first-quarter': 0.25, full: 0.5, 'last-quarter': 0.75,
}

export function principalPhaseName(phase: PrincipalPhase, t: TFunction): string {
  return {
    new:             t('moon_new',           { defaultValue: 'Nouvelle lune' }),
    'first-quarter': t('moon_first_quarter', { defaultValue: 'Premier quartier' }),
    full:            t('moon_full',          { defaultValue: 'Pleine lune' }),
    'last-quarter':  t('moon_last_quarter',  { defaultValue: 'Dernier quartier' }),
  }[phase]
}

/**
 * Phase icon: dark disc + lit area. `phase` ∈ [0,1) (0 = new moon).
 * Northern-hemisphere convention: a waxing moon is lit on the right.
 */
export function MoonIcon({ phase, size = 14, className, title }: {
  phase: number; size?: number; className?: string; title?: string
}) {
  const r = 10
  const cx = 12, cy = 12
  const d = 2 * Math.PI * phase
  const lit = (1 - Math.cos(d)) / 2
  const rx = Math.abs(Math.cos(d)) * r
  // Lit side: right while waxing, left while waning.
  const outerSweep = phase <= 0.5 ? 1 : 0
  const innerSweep = lit > 0.5 ? outerSweep : 1 - outerSweep
  const litPath = `M ${cx} ${cy - r} A ${r} ${r} 0 0 ${outerSweep} ${cx} ${cy + r} A ${rx} ${r} 0 0 ${innerSweep} ${cx} ${cy - r} Z`
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden={!title}>
      {title && <title>{title}</title>}
      {/* Dark face + limb */}
      <circle cx={cx} cy={cy} r={r} fill="var(--color-surface-3, #e8eaed)" stroke="var(--color-border-strong, #bdc1c6)" strokeWidth="1" />
      {/* Lit part */}
      {lit > 0.01 && (lit > 0.99
        ? <circle cx={cx} cy={cy} r={r} fill="#f6c453" />
        : <path d={litPath} fill="#f6c453" />)}
    </svg>
  )
}

/** Icon of a principal phase (paper-calendar-style marker). */
export function PrincipalMoonIcon({ phase, size = 14, className, title }: {
  phase: PrincipalPhase; size?: number; className?: string; title?: string
}) {
  return <MoonIcon phase={PRINCIPAL_PHASE_VALUE[phase]} size={size} className={className} title={title} />
}
