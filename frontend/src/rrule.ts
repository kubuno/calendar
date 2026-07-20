// Shared RRULE helpers: presets used by the quick dropdown, a full
// parse/build round-trip for the custom recurrence editor, and the French
// humanizer shown in the event popover / editor summary.
import { format, getDay, getDate } from 'date-fns'
import { getDateLocale } from '@kubuno/sdk'

export const WEEKDAY_BY = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']
/** French display order (week starting on Monday). */
export const WEEKDAYS_ORDERED = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const

export function buildRrule(preset: string, start: Date): string | null {
  switch (preset) {
    case 'daily':   return 'FREQ=DAILY'
    case 'weekly':  return `FREQ=WEEKLY;BYDAY=${WEEKDAY_BY[getDay(start)]}`
    case 'weekday': return 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR'
    case 'monthly': return 'FREQ=MONTHLY'
    case 'yearly':  return 'FREQ=YEARLY'
    default:        return null
  }
}

export function presetFromRrule(rrule: string | null | undefined): string {
  if (!rrule) return 'none'
  const u = rrule.toUpperCase().replace(/^RRULE:/, '')
  // Any rule with INTERVAL>1, COUNT, UNTIL or multiple BYDAY = custom.
  const parts = parseRruleParts(u)
  const nonTrivial = (parts.INTERVAL && parts.INTERVAL !== '1') || parts.COUNT || parts.UNTIL
  if (!nonTrivial) {
    if (parts.FREQ === 'DAILY') return 'daily'
    if (parts.BYDAY === 'MO,TU,WE,TH,FR') return 'weekday'
    if (parts.FREQ === 'WEEKLY' && (!parts.BYDAY || parts.BYDAY.split(',').length === 1)) return 'weekly'
    if (parts.FREQ === 'MONTHLY' && !parts.BYDAY && !parts.BYMONTHDAY) return 'monthly'
    if (parts.FREQ === 'YEARLY') return 'yearly'
  }
  return 'custom'
}

function parseRruleParts(rrule: string): Record<string, string> {
  return Object.fromEntries(
    rrule.replace(/^RRULE:/i, '').split(';').filter(Boolean).map(kv => {
      const [k, v] = kv.split('=')
      return [k.toUpperCase(), (v ?? '').toUpperCase()]
    })
  ) as Record<string, string>
}

// ── Custom recurrence (state ↔ RRULE) ─────────────────────────────────────────

export interface CustomRecurrence {
  freq: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY'
  interval: number
  /** WEEKLY: checked weekdays (iCal codes MO…SU). */
  byday: string[]
  /** MONTHLY : par date du mois (BYMONTHDAY) ou par rang de jour (BYDAY=2TU). */
  monthlyMode: 'bymonthday' | 'byday'
  end: 'never' | 'count' | 'until'
  count: number
  /** Format yyyy-MM-dd (input date). */
  until: string
}

/** Default state, aligned on the event start date. */
export function defaultCustomRecurrence(start: Date): CustomRecurrence {
  return {
    freq: 'WEEKLY',
    interval: 1,
    byday: [WEEKDAY_BY[getDay(start)]],
    monthlyMode: 'bymonthday',
    end: 'never',
    count: 10,
    until: format(start, 'yyyy-MM-dd'),
  }
}

/** Interpret an existing RRULE as editor state (best effort). */
export function parseCustomRecurrence(rrule: string | null | undefined, start: Date): CustomRecurrence {
  const def = defaultCustomRecurrence(start)
  if (!rrule) return def
  const p = parseRruleParts(rrule)
  const freq = (['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(p.FREQ) ? p.FREQ : 'WEEKLY') as CustomRecurrence['freq']
  const byday = (p.BYDAY ?? '').split(',').map(d => d.replace(/^[+-]?\d+/, '')).filter(d => WEEKDAY_BY.includes(d))
  let until = def.until
  if (p.UNTIL) {
    const m = p.UNTIL.match(/^(\d{4})(\d{2})(\d{2})/)
    if (m) until = `${m[1]}-${m[2]}-${m[3]}`
  }
  return {
    freq,
    interval: Math.max(1, parseInt(p.INTERVAL ?? '1', 10) || 1),
    byday: freq === 'WEEKLY' && byday.length ? byday : def.byday,
    monthlyMode: freq === 'MONTHLY' && p.BYDAY ? 'byday' : 'bymonthday',
    end: p.COUNT ? 'count' : p.UNTIL ? 'until' : 'never',
    count: Math.max(1, parseInt(p.COUNT ?? '10', 10) || 10),
    until,
  }
}

/** Build the RRULE matching the custom editor state. */
export function buildCustomRrule(c: CustomRecurrence, start: Date): string {
  const parts: string[] = [`FREQ=${c.freq}`]
  if (c.interval > 1) parts.push(`INTERVAL=${Math.floor(c.interval)}`)
  if (c.freq === 'WEEKLY') {
    const days = WEEKDAYS_ORDERED.filter(d => c.byday.includes(d))
    if (days.length) parts.push(`BYDAY=${days.join(',')}`)
  }
  if (c.freq === 'MONTHLY') {
    if (c.monthlyMode === 'bymonthday') {
      parts.push(`BYMONTHDAY=${getDate(start)}`)
    } else {
      // Rank of the day within the month: 1st/2nd/3rd/4th, or last (-1) when 5th.
      const nth = Math.ceil(getDate(start) / 7)
      parts.push(`BYDAY=${nth >= 5 ? -1 : nth}${WEEKDAY_BY[getDay(start)]}`)
    }
  }
  if (c.end === 'count') parts.push(`COUNT=${Math.max(1, Math.floor(c.count))}`)
  else if (c.end === 'until' && c.until) {
    // End of day UTC: the occurrence on the chosen day stays included.
    parts.push(`UNTIL=${c.until.replace(/-/g, '')}T235959Z`)
  }
  return parts.join(';')
}

// ── Humanizer (localized) ─────────────────────────────────────────────────────

const DAY_NAMES: Record<string, string> = {
  MO: 'lundi', TU: 'mardi', WE: 'mercredi', TH: 'jeudi', FR: 'vendredi', SA: 'samedi', SU: 'dimanche',
}

export function describeRrule(rrule: string | null, lang: string, start: Date): string | null {
  if (!rrule) return null
  const parts = parseRruleParts(rrule)
  const freq = parts.FREQ
  if (!freq) return null
  const interval = Math.max(1, parseInt(parts.INTERVAL ?? '1', 10) || 1)
  const loc = getDateLocale(lang)

  const byday = (parts.BYDAY ?? '').split(',').map(d => d.replace(/^[+-]?\d+/, '')).filter(Boolean)
  const dayList = byday.map(d => DAY_NAMES[d]).filter(Boolean)
  const joinDays = (ds: string[]) =>
    ds.length <= 1 ? (ds[0] ?? '') : `${ds.slice(0, -1).join(', ')} et ${ds[ds.length - 1]}`

  let base: string
  switch (freq) {
    case 'DAILY':
      base = interval === 1 ? 'Tous les jours' : `Tous les ${interval} jours`
      break
    case 'WEEKLY': {
      const days = dayList.length ? joinDays(dayList) : format(start, 'EEEE', { locale: loc })
      base = interval === 1 ? `Toutes les semaines le ${days}` : `Toutes les ${interval} semaines le ${days}`
      break
    }
    case 'MONTHLY': {
      const nthMatch = (parts.BYDAY ?? '').match(/^(-?\d)([A-Z]{2})$/)
      const suffix = nthMatch
        ? ` le ${nthMatch[1] === '-1' ? 'dernier' : nthMatch[1] === '1' ? '1ᵉʳ' : `${nthMatch[1]}ᵉ`} ${DAY_NAMES[nthMatch[2]] ?? ''}`
        : parts.BYMONTHDAY ? ` le ${parseInt(parts.BYMONTHDAY, 10)}` : ''
      base = (interval === 1 ? 'Tous les mois' : `Tous les ${interval} mois`) + suffix
      break
    }
    case 'YEARLY':
      base = interval === 1 ? 'Tous les ans' : `Tous les ${interval} ans`
      break
    default:
      return null
  }

  if (parts.COUNT) base += `, ${parts.COUNT} fois`
  else if (parts.UNTIL) {
    const m = parts.UNTIL.match(/^(\d{4})(\d{2})(\d{2})/)
    if (m) base += `, jusqu'au ${format(new Date(+m[1], +m[2] - 1, +m[3]), 'd MMMM yyyy', { locale: loc })}`
  }
  return base
}
