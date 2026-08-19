// Time zones offered by the settings page (secondary zone, world clock).
//
// Kept deliberately short and ordered by region: the full IANA database (~600
// entries) makes a picker unusable, and `Intl.supportedValuesOf('timeZone')` is
// not available everywhere the app runs.
import { useMemo } from 'react'
import { useAuthStore } from '@kubuno/sdk'

export const TIMEZONES: string[] = [
  'Europe/Paris', 'Europe/London', 'Europe/Berlin', 'Europe/Madrid', 'Europe/Rome',
  'Europe/Lisbon', 'Europe/Brussels', 'Europe/Zurich', 'Europe/Athens', 'Europe/Moscow',
  'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
  'America/Toronto', 'America/Mexico_City', 'America/Sao_Paulo', 'America/Buenos_Aires',
  'Africa/Douala', 'Africa/Lagos', 'Africa/Casablanca', 'Africa/Cairo',
  'Africa/Nairobi', 'Africa/Johannesburg', 'Africa/Abidjan', 'Africa/Dakar',
  'Asia/Dubai', 'Asia/Karachi', 'Asia/Kolkata', 'Asia/Bangkok', 'Asia/Shanghai',
  'Asia/Hong_Kong', 'Asia/Singapore', 'Asia/Seoul', 'Asia/Tokyo', 'Asia/Jerusalem',
  'Australia/Perth', 'Australia/Sydney', 'Pacific/Auckland', 'Pacific/Honolulu',
  'UTC',
]

// ── The reader's own time zone ───────────────────────────────────────────────
//
// Two sources, in this order, and no third one is invented here:
//
//   1. the account preference `preferences.timezone`, which the core's own
//      profile page writes (its "Automatic" choice stores an empty string);
//   2. the device, which is what every view of this module has always treated
//      as the reader's zone.
//
// The instance-wide setting is deliberately absent from this list: it is the
// SERVER's last resort when neither of these is usable, not a value the
// interface should present as the reader's own.

/** The device's zone. `UTC` when the platform refuses to say. */
export function deviceTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch { return 'UTC' }
}

/** Reads the preference out of whatever the account bag holds — it is untyped
 *  JSON, so anything but a non-empty string means "not chosen". */
function chosenTimezone(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

/** The reader's time zone, outside React (API calls, event handlers). */
export function userTimezone(): string {
  return chosenTimezone(useAuthStore.getState().user?.preferences?.timezone) ?? deviceTimezone()
}

/** The reader's time zone, for components — re-renders when the account
 *  preference changes, which `userTimezone()` cannot do. */
export function useUserTimezone(): string {
  const preferred = useAuthStore(s => s.user?.preferences?.timezone)
  return useMemo(() => chosenTimezone(preferred) ?? deviceTimezone(), [preferred])
}

/** "GMT+2" for a zone, at the given instant (empty string if unsupported). */
export function tzOffsetLabel(tz: string, at: Date = new Date()): string {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' })
      .formatToParts(at).find(p => p.type === 'timeZoneName')?.value ?? ''
  } catch { return '' }
}

/** "(GMT+02:00) Europe/Paris" — the label used in the pickers. */
export function tzLabel(tz: string): string {
  const off = tzOffsetLabel(tz)
  return off ? `(${off}) ${tz.replace(/_/g, ' ')}` : tz.replace(/_/g, ' ')
}

/** Wall-clock time in a zone, formatted for the world clock. */
export function tzTime(tz: string, at: Date, hour12: boolean): string {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, hour: '2-digit', minute: '2-digit', hour12,
    }).format(at)
  } catch { return '' }
}
