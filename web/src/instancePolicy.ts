// What the instance allows, as the module's screens need to know it.
//
// The core's `/modules/calendar/config` deliberately hides instance-scoped
// settings from accounts without the settings privilege, so it cannot answer
// "may I publish a calendar?" for an ordinary user. The module answers that
// itself, on `/calendar/instance-policy`, with the handful of decisions its own
// screens act on — the same ones the server already enforces, so the interface
// never offers an action the backend will refuse.
import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@kubuno/sdk'

export interface InstancePolicy {
  /** May a calendar be published as a public .ics feed at all? */
  allowPublicCalendars: boolean
  /** May a guest outside the instance be invited? */
  allowExternalGuests: boolean
  /** Warn in the composer before adding such a guest (when allowed). */
  warnExternalGuests: boolean
  /** May a remote .ics feed be mirrored? */
  allowCalendarSubscriptions: boolean
  /** May bookable appointment pages be published? */
  allowAppointmentSchedules: boolean
  /** May users set a daily working location? */
  allowWorkingLocation: boolean
  /** Ceiling on the guest list of one event; 0 = no ceiling. */
  maxEventGuests: number
  /** The instance's own domain names, lowercase. */
  internalDomains: string[]
}

/** Permissive until the query answers: the first paint must not flash a screen
 *  that looks locked down, and the server refuses anything it disallows anyway. */
export const INSTANCE_POLICY_DEFAULTS: InstancePolicy = {
  allowPublicCalendars:       true,
  allowExternalGuests:        true,
  warnExternalGuests:         true,
  allowCalendarSubscriptions: true,
  allowAppointmentSchedules:  true,
  allowWorkingLocation:       true,
  maxEventGuests:             0,
  internalDomains:            [],
}

interface RawPolicy {
  allow_public_calendars?:       boolean
  allow_external_guests?:        boolean
  warn_external_guests?:         boolean
  allow_calendar_subscriptions?: boolean
  allow_appointment_schedules?:  boolean
  allow_working_location?:       boolean
  max_event_guests?:             number
  internal_domains?:             string[]
}

export function useInstancePolicy(): InstancePolicy {
  const { data } = useQuery({
    queryKey: ['calendar-instance-policy'],
    queryFn:  () => api.get<RawPolicy>('/calendar/instance-policy').then(r => r.data),
    staleTime: 5 * 60_000,
  })

  // Memoised: consumers put the result in dependency arrays, and a fresh object
  // on every render would defeat every one of them.
  return useMemo(() => {
    const d = INSTANCE_POLICY_DEFAULTS
    if (!data) return d
    return {
      allowPublicCalendars:       data.allow_public_calendars       ?? d.allowPublicCalendars,
      allowExternalGuests:        data.allow_external_guests        ?? d.allowExternalGuests,
      warnExternalGuests:         data.warn_external_guests         ?? d.warnExternalGuests,
      allowCalendarSubscriptions: data.allow_calendar_subscriptions ?? d.allowCalendarSubscriptions,
      allowAppointmentSchedules:  data.allow_appointment_schedules  ?? d.allowAppointmentSchedules,
      allowWorkingLocation:       data.allow_working_location       ?? d.allowWorkingLocation,
      maxEventGuests:             typeof data.max_event_guests === 'number' ? data.max_event_guests : d.maxEventGuests,
      internalDomains:            Array.isArray(data.internal_domains) ? data.internal_domains : d.internalDomains,
    }
  }, [data])
}

/** True when the address plainly belongs to one of the instance's domains.
 *  An unknown domain is not proof of an outsider — the instance may simply not
 *  have declared its names — so callers use this to WARN, never to refuse; the
 *  refusal, when the policy asks for one, is the server's and is based on the
 *  directory as well. */
export function isInternalAddress(email: string, domains: string[]): boolean {
  const at = email.lastIndexOf('@')
  if (at < 1) return false
  const domain = email.slice(at + 1).trim().toLowerCase()
  return domain.length > 0 && domains.includes(domain)
}
