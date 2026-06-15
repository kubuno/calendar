import { api as apiClient } from '@kubuno/sdk'
import { i18n } from '@kubuno/sdk'

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
  created_at: string
  updated_at: string
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

export interface Attendee {
  id:           string
  event_id:     string
  user_id:      string | null
  email:        string
  display_name: string | null
  status:       string   // 'needs_action' | 'accepted' | 'declined' | 'tentative'
  is_organizer: boolean
  invited_at:   string
  responded_at: string | null
  comment:      string | null
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

export interface DailyWeather {
  date:            string   // "YYYY-MM-DD"
  weather_code:    number
  temp_max:        number
  temp_min:        number
  precip_prob_max: number
  uv_index_max:    number
  sunrise:         string | null
  sunset:          string | null
}

export interface HourlyPoint {
  time:         string   // "YYYY-MM-DDTHH:MM"
  weather_code: number
  temp:         number
  feels_like:   number
  humidity:     number
  precip_prob:  number
  wind_speed:   number
  wind_dir:     number
}

export interface WeatherForecast {
  latitude:  number
  longitude: number
  timezone:  string
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
 * URL d'une icône météo SVG animée (amCharts/ammap.com) selon le code WMO Open-Meteo.
 * Fichiers servis depuis public/weather-icons/. Variante jour/nuit pour ciel dégagé/peu nuageux.
 * Icônes : © amCharts — https://www.amcharts.com/free-animated-svg-weather-icons/
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
  else if (code <= 67)  name = 'rainy-6'     // pluie forte / verglaçante
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
  listCalendars: async (): Promise<{ calendars: Calendar[] }> => {
    const { data } = await apiClient.get('/calendar/calendars')
    return data
  },

  createCalendar: async (dto: { name: string; color?: string; timezone?: string }): Promise<{ calendar: Calendar }> => {
    const { data } = await apiClient.post('/calendar/calendars', dto)
    return data
  },

  listEvents: async (from: string, to: string, calendarIds?: string[]): Promise<{ events: EventInstance[] }> => {
    // Le backend attend `until` (pas `to`) ; sans lui la fenêtre tombait à from+30j
    // → la vue Année (et la fin des grilles mensuelles 6 semaines) perdait des événements.
    const params: Record<string, string> = { from, until: to }
    if (calendarIds?.length) params['calendar_ids'] = calendarIds.join(',')
    const { data } = await apiClient.get('/calendar/events', { params })
    return data
  },

  createEvent: async (dto: CreateEventDto): Promise<{ event: EventInstance }> => {
    const { data } = await apiClient.post('/calendar/events', dto)
    return data
  },

  updateEvent: async (id: string, dto: Partial<CreateEventDto> & { scope?: string }): Promise<{ event: EventInstance }> => {
    // `scope` (this|following|all) est un paramètre de requête, pas un champ du corps.
    const { scope, ...body } = dto
    const { data } = await apiClient.patch(`/calendar/events/${id}`, body, scope ? { params: { scope } } : undefined)
    return data
  },

  deleteEvent: async (id: string, scope?: string): Promise<void> => {
    await apiClient.delete(`/calendar/events/${id}`, { params: scope ? { scope } : {} })
  },

  // ── Invités (attendees) ──────────────────────────────────────────────────────
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
}
