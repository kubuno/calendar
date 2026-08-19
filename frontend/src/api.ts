import { api as apiClient } from '@kubuno/sdk'
import { i18n } from '@kubuno/sdk'
import { userTimezone } from './timezones'

export interface Calendar {
  id: string
  owner_id: string
  name: string
  description: string | null
  color: string
  cal_type: string
  is_default: boolean
  is_visible: boolean
  is_public: boolean
  timezone: string
  caldav_token: string
  /** Mirrored remote .ics feed (cal_type = 'subscription'). */
  subscription_url: string | null
  last_synced_at: string | null
  created_at: string
  updated_at: string
  /** Droits de l'utilisateur courant : 'owner' | 'write' | 'read'. */
  my_permission?: 'owner' | 'write' | 'read' | null
}

export interface CalendarShare {
  id: string
  calendar_id: string
  shared_with: string
  permission: 'read' | 'write'
  created_at: string
}

/** Public profile returned by /users/search and /users/lookup (core). */
export interface UserBrief {
  id: string
  username: string
  display_name: string | null
  avatar_url: string | null
}

export interface EventReminder {
  type: string
  minutes_before: number
}

export interface EventInstance {
  id: string
  event_id: string
  calendar_id: string
  owner_id: string
  title: string
  description: string | null
  location: string | null
  starts_at: string
  ends_at: string
  all_day: boolean
  is_recurring: boolean
  rrule: string | null
  status: string
  visibility: string
  busy?: boolean
  timezone?: string
  ical_uid: string
  etag: string
  color: string | null
  reminders: EventReminder[]
  /** RSVP status of the current user when invited ('declined', 'accepted'…). */
  my_status?: string | null
}

export interface CreateEventDto {
  calendar_id: string
  title: string
  description?: string
  location?: string
  url?: string
  starts_at: string
  ends_at: string
  all_day?: boolean
  timezone?: string
  color?: string | null
  clear_color?: boolean
  rrule?: string
  reminders?: EventReminder[]
  status?: string
  visibility?: string
  busy?: boolean
}

export interface ImportResult {
  total:    number
  imported: number
  updated:  number
  skipped:  number
  errors:   string[]
}

export interface Attendee {
  id:           string
  event_id:     string
  user_id:      string | null
  email:        string
  display_name: string | null
  status:       string   // 'needs-action' | 'accepted' | 'declined' | 'tentative'
  is_organizer: boolean
  rsvp_token:   string | null
  invited_at:   string
  responded_at: string | null
  comment:      string | null
}

export interface AvailableSlot {
  starts_at: string
  ends_at:   string
  /** 1.0 = all attendees available. */
  score:     number
}

// ── Weather ───────────────────────────────────────────────────────────────────

export interface WeatherLocation {
  id:         string
  user_id:    string
  name:       string
  latitude:   number
  longitude:  number
  timezone:   string
  is_default: boolean
  sort_order: number
  created_at: string
}

export interface CurrentWeather {
  time:         string   // "YYYY-MM-DDTHH:MM"
  weather_code: number
  temp:         number
  feels_like:   number
  is_day:       boolean
  humidity:     number
  precip:       number   // mm (last hour)
  wind_speed:   number
  wind_gust:    number
  wind_dir:     number
  pressure:     number   // hPa
  cloud_cover:  number   // %
}

export interface DailyWeather {
  date:              string   // "YYYY-MM-DD"
  weather_code:      number
  temp_max:          number
  temp_min:          number
  feels_like_max:    number
  feels_like_min:    number
  precip_prob_max:   number
  precip_sum:        number   // mm
  uv_index_max:      number
  wind_max:          number
  wind_gust_max:     number
  wind_dir_dominant: number
  sunrise:           string | null
  sunset:            string | null
}

export interface HourlyPoint {
  time:         string   // "YYYY-MM-DDTHH:MM"
  weather_code: number
  temp:         number
  feels_like:   number
  is_day:       boolean
  humidity:     number
  precip:       number   // mm
  precip_prob:  number
  wind_speed:   number
  wind_gust:    number
  wind_dir:     number
  uv_index:     number
  pressure:     number   // hPa
  visibility:   number   // meters
  cloud_cover:  number   // %
}

export interface AirQuality {
  european_aqi: number | null
  us_aqi:       number | null
  pm2_5:        number | null
  pm10:         number | null
  ozone:        number | null
  no2:          number | null
}

export interface WeatherForecast {
  latitude:  number
  longitude: number
  timezone:  string
  current:   CurrentWeather | null
  air:       AirQuality | null
  days:      DailyWeather[]
  hours:     HourlyPoint[]
}

export interface GeocodingResult {
  name:      string
  latitude:  number
  longitude: number
  timezone:  string
  country:   string
  admin1:    string | null
}

export const weatherApi = {
  listLocations: async (): Promise<{ locations: WeatherLocation[] }> => {
    const { data } = await apiClient.get('/calendar/weather/locations')
    return data
  },

  addLocation: async (dto: {
    name: string; latitude: number; longitude: number; timezone: string; is_default?: boolean
  }): Promise<{ location: WeatherLocation }> => {
    const { data } = await apiClient.post('/calendar/weather/locations', dto)
    return data
  },

  updateLocation: async (id: string, dto: {
    name?: string; is_default?: boolean; sort_order?: number
  }): Promise<{ location: WeatherLocation }> => {
    const { data } = await apiClient.patch(`/calendar/weather/locations/${id}`, dto)
    return data
  },

  deleteLocation: async (id: string): Promise<void> => {
    await apiClient.delete(`/calendar/weather/locations/${id}`)
  },

  getForecast: async (lat: number, lon: number, tz: string): Promise<{ forecast: WeatherForecast }> => {
    const { data } = await apiClient.get('/calendar/weather/forecast', { params: { lat, lon, tz } })
    return data
  },

  geocode: async (q: string): Promise<{ results: GeocodingResult[] }> => {
    const { data } = await apiClient.get('/calendar/weather/geocode', { params: { q, lang: i18n.language } })
    return data
  },
}

// ── WMO weather code helpers ──────────────────────────────────────────────────

/** i18n key for a WMO weather code (translated in the component via `t()`). */
export function wmoKey(code: number): string {
  if (code === 0)  return 'wmo_clear'
  if (code === 1)  return 'wmo_mainly_clear'
  if (code === 2)  return 'wmo_partly_cloudy'
  if (code === 3)  return 'wmo_overcast'
  if (code <= 49)  return 'wmo_fog'
  if (code <= 57)  return 'wmo_drizzle'
  if (code <= 67)  return 'wmo_rain'
  if (code <= 77)  return 'wmo_snow'
  if (code <= 82)  return 'wmo_showers'
  if (code <= 86)  return 'wmo_snow_showers'
  if (code <= 99)  return 'wmo_thunderstorm'
  return 'wmo_unknown'
}

export function wmoInfo(code: number): { emoji: string; label: string } {
  if (code === 0)  return { emoji: '☀️',  label: 'Ciel dégagé' }
  if (code === 1)  return { emoji: '🌤️',  label: 'Généralement dégagé' }
  if (code === 2)  return { emoji: '⛅',  label: 'Partiellement nuageux' }
  if (code === 3)  return { emoji: '☁️',  label: 'Couvert' }
  if (code <= 49)  return { emoji: '🌫️',  label: 'Brouillard' }
  if (code <= 57)  return { emoji: '🌦️',  label: 'Bruine' }
  if (code <= 67)  return { emoji: '🌧️',  label: 'Pluie' }
  if (code <= 77)  return { emoji: '🌨️',  label: 'Neige' }
  if (code <= 82)  return { emoji: '🌦️',  label: 'Averses' }
  if (code <= 86)  return { emoji: '🌨️',  label: 'Averses de neige' }
  if (code <= 99)  return { emoji: '⛈️',  label: 'Orage' }
  return { emoji: '🌡️', label: 'Inconnu' }
}

/**
 * URL of an animated SVG weather icon (amCharts/ammap.com) for a WMO Open-Meteo code.
 * Files served from public/weather-icons/. Day/night variants for clear/partly-cloudy skies.
 * Icons: © amCharts — https://www.amcharts.com/free-animated-svg-weather-icons/
 */
export function weatherIconUrl(code: number, isDay = true): string {
  let name: string
  if (code === 0)       name = isDay ? 'day' : 'night'
  else if (code === 1)  name = isDay ? 'cloudy-day-1' : 'cloudy-night-1'
  else if (code === 2)  name = isDay ? 'cloudy-day-2' : 'cloudy-night-2'
  else if (code === 3)  name = 'cloudy'
  else if (code <= 49)  name = 'cloudy'      // brouillard
  else if (code <= 57)  name = 'rainy-1'     // bruine
  else if (code === 61) name = 'rainy-4'
  else if (code === 63) name = 'rainy-5'
  else if (code <= 67)  name = 'rainy-6'     // heavy / freezing rain
  else if (code === 71) name = 'snowy-4'
  else if (code === 73) name = 'snowy-5'
  else if (code <= 77)  name = 'snowy-6'     // neige
  else if (code === 80) name = 'rainy-5'
  else if (code === 81) name = 'rainy-6'
  else if (code <= 82)  name = 'rainy-7'     // averses
  else if (code <= 86)  name = 'snowy-6'     // averses de neige
  else if (code <= 99)  name = 'thunder'     // orage
  else                  name = 'cloudy'
  return `/weather-icons/${name}.svg`
}

export const calendarApi = {
  // A calendar is born in the zone of whoever created it, and the browser is the
  // only place that knows which one that is — the core stores an account
  // preference but exposes it to no module server. So the three routes that
  // create a calendar carry it. The server validates it and keeps the instance
  // setting for when it is missing or unusable; nothing here assumes it took.
  listCalendars: async (): Promise<{ calendars: Calendar[] }> => {
    // The first listing of an account also creates its default calendar.
    const { data } = await apiClient.get('/calendar/calendars', { params: { tz: userTimezone() } })
    return data
  },

  createCalendar: async (dto: { name: string; color?: string; timezone?: string; description?: string }): Promise<{ calendar: Calendar }> => {
    const { data } = await apiClient.post('/calendar/calendars', { ...dto, timezone: dto.timezone || userTimezone() })
    return data
  },

  updateCalendar: async (id: string, dto: { name?: string; color?: string; description?: string; is_public?: boolean; is_visible?: boolean }): Promise<{ calendar: Calendar }> => {
    const { data } = await apiClient.patch(`/calendar/calendars/${id}`, dto)
    return data
  },

  deleteCalendar: async (id: string): Promise<void> => {
    await apiClient.delete(`/calendar/calendars/${id}`)
  },

  // ── Partage d'agendas ────────────────────────────────────────────────────────
  listShares: async (id: string): Promise<{ shares: CalendarShare[] }> => {
    const { data } = await apiClient.get(`/calendar/calendars/${id}/shares`)
    return data
  },

  shareCalendar: async (id: string, dto: { user_id: string; permission: 'read' | 'write' }): Promise<{ share: CalendarShare }> => {
    const { data } = await apiClient.post(`/calendar/calendars/${id}/share`, dto)
    return data
  },

  unshareCalendar: async (id: string, userId: string): Promise<void> => {
    await apiClient.delete(`/calendar/calendars/${id}/share/${userId}`)
  },

  // ── Abonnements iCalendar distants ───────────────────────────────────────────
  subscribeCalendar: async (dto: { name: string; url: string; color?: string; timezone?: string }): Promise<{ calendar: Calendar }> => {
    const { data } = await apiClient.post('/calendar/calendars/subscribe', { ...dto, timezone: dto.timezone || userTimezone() })
    return data
  },

  refreshCalendar: async (id: string): Promise<{ imported: number; updated: number; removed: number }> => {
    const { data } = await apiClient.post(`/calendar/calendars/${id}/refresh`)
    return data
  },

  // ── .ics export (client-side download) ──────────────────────────────────────
  exportCalendar: async (id: string, name: string): Promise<void> => {
    const { data } = await apiClient.get(`/calendar/calendars/${id}/export`, { responseType: 'blob' })
    const url = URL.createObjectURL(data as Blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${name.replace(/[/\\?%*:|"<>]/g, '-')}.ics`
    document.body.appendChild(a); a.click(); a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 4000)
  },

  /** Public URL of the .ics feed (requires is_public = true). */
  publicFeedUrl: (cal: Calendar): string =>
    `${window.location.origin}/api/v1/calendar/public/calendars/${cal.caldav_token}/feed.ics`,

  // ── Annuaire (core) ──────────────────────────────────────────────────────────
  searchUsers: async (q: string): Promise<UserBrief[]> => {
    const { data } = await apiClient.get('/users/search', { params: { q, limit: 8 } })
    return data.users ?? []
  },

  lookupUsers: async (ids: string[]): Promise<UserBrief[]> => {
    if (!ids.length) return []
    const { data } = await apiClient.get('/users/lookup', { params: { ids: ids.join(',') } })
    return data.users ?? []
  },

  listEvents: async (from: string, to: string, calendarIds?: string[]): Promise<{ events: EventInstance[] }> => {
    // The backend expects `until` (not `to`); without it the window fell back to
    // from+30d → the Year view (and the tail of 6-week month grids) lost events.
    const params: Record<string, string> = { from, until: to }
    if (calendarIds?.length) params['calendar_ids'] = calendarIds.join(',')
    const { data } = await apiClient.get('/calendar/events', { params })
    return data
  },

  createEvent: async (dto: CreateEventDto): Promise<{ event: EventInstance }> => {
    const { data } = await apiClient.post('/calendar/events', dto)
    return data
  },

  updateEvent: async (id: string, dto: Partial<CreateEventDto> & { scope?: string; occurrence?: string; clear_rrule?: boolean }): Promise<{ event: EventInstance }> => {
    // `scope` (this|following|all) and `occurrence` (start of the targeted
    // occurrence, required for this/following on a series) are query parameters.
    const { scope, occurrence, ...body } = dto
    const params: Record<string, string> = {}
    if (scope) params.scope = scope
    if (occurrence) params.occurrence = occurrence
    const { data } = await apiClient.patch(`/calendar/events/${id}`, body, Object.keys(params).length ? { params } : undefined)
    return data
  },

  deleteEvent: async (id: string, scope?: string, occurrence?: string): Promise<void> => {
    const params: Record<string, string> = {}
    if (scope) params.scope = scope
    if (occurrence) params.occurrence = occurrence
    await apiClient.delete(`/calendar/events/${id}`, { params })
  },

  // ── Import iCalendar (.ics) ───────────────────────────────────────────────────
  importIcs: async (calendarId: string, icsContent: string): Promise<ImportResult> => {
    const { data } = await apiClient.post('/calendar/import', {
      calendar_id: calendarId,
      ics_content: icsContent,
    })
    return data
  },

  // ── Attendees ────────────────────────────────────────────────────────────────
  listAttendees: async (eventId: string): Promise<{ attendees: Attendee[] }> => {
    const { data } = await apiClient.get(`/calendar/events/${eventId}/attendees`)
    return data
  },

  inviteAttendee: async (eventId: string, dto: { email: string; display_name?: string }): Promise<{ attendee: Attendee }> => {
    const { data } = await apiClient.post(`/calendar/events/${eventId}/attendees`, dto)
    return data
  },

  removeAttendee: async (eventId: string, attendeeId: string): Promise<void> => {
    await apiClient.delete(`/calendar/events/${eventId}/attendees/${attendeeId}`)
  },

  /** Standalone public RSVP page of an attendee (to send by e-mail). */
  rsvpPageUrl: (attendee: Attendee): string | null =>
    attendee.rsvp_token
      ? `${window.location.origin}/api/v1/calendar/public/rsvp/${attendee.rsvp_token}/page`
      : null,

  // ── Common-slot search ───────────────────────────────────────────────────────
  /** `hidden_user_ids` names the participants whose busy times the instance did
   *  not let this account read — they are absent from the computation, not free. */
  findCommonSlots: async (dto: { from: string; until: string; user_ids: string[] }): Promise<{ slots: AvailableSlot[]; hidden_user_ids?: string[] }> => {
    const { data } = await apiClient.post('/calendar/availability', dto)
    return data
  },
}

// ─────────────────────────────────────────────────────────────────────────────
// Bookable appointment schedules
// ─────────────────────────────────────────────────────────────────────────────

/** Custom booking-form field beyond the built-in first/last name + email. */
export interface BookingFormField {
  id:       string
  label:    string
  type:     'text' | 'email' | 'phone' | 'longtext'
  required: boolean
}

/** One availability rule: weekly (weekday set) or date-specific (date set).
 *  Times are minutes from midnight in the schedule timezone. weekday 0 = Mon. */
export interface AvailabilityRule {
  id?:            string
  weekday:        number | null
  specific_date:  string | null
  start_minute:   number
  end_minute:     number
}

export interface AppointmentSchedule {
  id:                string
  owner_id:          string
  calendar_id:       string
  public_token:      string
  title:             string
  description:       string | null
  color:             string | null
  duration_minutes:  number
  buffer_minutes:    number | null
  max_per_day:       number | null
  timezone:          string
  window_type:       'rolling' | 'fixed'
  window_max_days:   number | null
  window_min_hours:  number | null
  window_start_date: string | null
  window_end_date:   string | null
  location_type:     'none' | 'in_person' | 'phone' | 'video'
  location_details:  string | null
  guests_can_invite: boolean
  host_name:         string | null
  host_avatar_url:   string | null
  form_fields:       BookingFormField[]
  calendar_invite:   boolean
  email_reminders:   number[]
  created_at:        string
  updated_at:        string
  /** Present on GET /:id — the schedule's availability rules. */
  availability?:     AvailabilityRule[]
}

export interface SaveScheduleDto {
  calendar_id:       string
  title?:            string
  description?:      string | null
  color?:            string | null
  duration_minutes:  number
  buffer_minutes?:   number | null
  max_per_day?:      number | null
  timezone?:         string
  window_type?:      'rolling' | 'fixed'
  window_max_days?:  number | null
  window_min_hours?: number | null
  window_start_date?: string | null
  window_end_date?:  string | null
  location_type?:    'none' | 'in_person' | 'phone' | 'video'
  location_details?: string | null
  guests_can_invite?: boolean
  host_name?:        string | null
  host_avatar_url?:  string | null
  form_fields?:      BookingFormField[]
  calendar_invite?:  boolean
  email_reminders?:  number[]
  availability:      AvailabilityRule[]
}

export const appointmentApi = {
  list: async (): Promise<{ schedules: AppointmentSchedule[] }> => {
    const { data } = await apiClient.get('/calendar/appointment-schedules')
    return data
  },
  get: async (id: string): Promise<{ schedule: AppointmentSchedule }> => {
    const { data } = await apiClient.get(`/calendar/appointment-schedules/${id}`)
    return data
  },
  create: async (dto: SaveScheduleDto): Promise<{ schedule: AppointmentSchedule }> => {
    const { data } = await apiClient.post('/calendar/appointment-schedules', dto)
    return data
  },
  update: async (id: string, dto: SaveScheduleDto): Promise<{ schedule: AppointmentSchedule }> => {
    const { data } = await apiClient.patch(`/calendar/appointment-schedules/${id}`, dto)
    return data
  },
  remove: async (id: string): Promise<void> => {
    await apiClient.delete(`/calendar/appointment-schedules/${id}`)
  },
  /** Public booking-page URL to share with invitees. */
  bookingPageUrl: (token: string): string =>
    `${window.location.origin}/api/v1/calendar/public/appointments/${token}/page`,
}
