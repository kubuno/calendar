// Time zones offered by the settings page (secondary zone, world clock).
//
// Kept deliberately short and ordered by region: the full IANA database (~600
// entries) makes a picker unusable, and `Intl.supportedValuesOf('timeZone')` is
// not available everywhere the app runs.
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
