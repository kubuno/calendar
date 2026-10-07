import { create } from 'zustand'

// 'schedule' = vertical per-day event list ("Planning" view) — the default
// mobile view, also reachable at /calendar/schedule on desktop.
// 'custom'   = N-day strip, N coming from the `custom_view_days` preference.
export type ViewMode = 'day' | 'week' | 'month' | 'year' | 'schedule' | 'custom'

const MOON_KEY = 'kubuno:calendar:moon'

// Which holiday calendars the person has unchecked.
//
// Persisted, unlike the other unchecked calendars: a real calendar's visibility
// is a per-session glance ("hide this while I look at that"), whereas somebody
// who turns the holidays off means it — and having them come back at every
// reload would read as the switch not working.
const HIDDEN_HOLIDAYS_KEY = 'kubuno:calendar:hidden-holidays'
export const HOLIDAY_CALENDAR_PREFIX = 'holidays:'

function loadHiddenHolidays(): string[] {
  if (typeof localStorage === 'undefined') return []
  try {
    const raw = JSON.parse(localStorage.getItem(HIDDEN_HOLIDAYS_KEY) ?? '[]')
    return Array.isArray(raw) ? raw.filter((id): id is string => typeof id === 'string') : []
  } catch {
    return []
  }
}
function loadMoonEnabled(): boolean {
  if (typeof localStorage === 'undefined') return true
  return localStorage.getItem(MOON_KEY) !== 'off'
}

export interface CalendarSearchFilters {
  scope:        'active' | 'all'
  subject:      string
  participants: string
  location:     string
  excludeWords: string
  dateFrom:     string
  dateTo:       string
}

const DEFAULT_FILTERS: CalendarSearchFilters = {
  scope:        'active',
  subject:      '',
  participants: '',
  location:     '',
  excludeWords: '',
  dateFrom:     '',
  dateTo:       '',
}

interface CalendarState {
  currentDate:       Date
  viewMode:          ViewMode
  hiddenCalendarIds: string[]
  pendingCreateDate: Date | null

  // Search
  searchQuery:    string
  searchFilters:  CalendarSearchFilters
  searchApplied:  boolean   // true once user clicks "Rechercher"

  // Weather
  weatherEnabled:    boolean
  weatherLocationId: string | null   // selected location id (null = use default)

  // Moon phases (markers on the day/week/month views)
  moonEnabled: boolean

  setCurrentDate:       (date: Date) => void
  setViewMode:          (mode: ViewMode) => void
  toggleCalendar:       (id: string) => void
  setPendingCreate:     (date: Date | null) => void
  setSearchQuery:       (q: string) => void
  setSearchFilters:     (f: Partial<CalendarSearchFilters>) => void
  applySearch:          () => void
  clearSearch:          () => void
  setWeatherEnabled:    (v: boolean) => void
  setWeatherLocationId: (id: string | null) => void
  setMoonEnabled:       (v: boolean) => void
}

export const useCalendarStore = create<CalendarState>((set) => ({
  currentDate:       new Date(),
  viewMode:          'month',
  hiddenCalendarIds: loadHiddenHolidays(),
  pendingCreateDate: null,

  searchQuery:   '',
  searchFilters: { ...DEFAULT_FILTERS },
  searchApplied: false,

  weatherEnabled:    true,
  weatherLocationId: null,

  moonEnabled: loadMoonEnabled(),

  setCurrentDate:   (currentDate) => set({ currentDate }),
  setViewMode:      (viewMode) => set({ viewMode }),
  setPendingCreate: (pendingCreateDate) => set({ pendingCreateDate }),

  toggleCalendar: (id) =>
    set((s) => {
      const hiddenCalendarIds = s.hiddenCalendarIds.includes(id)
        ? s.hiddenCalendarIds.filter((i) => i !== id)
        : [...s.hiddenCalendarIds, id]
      try {
        localStorage.setItem(
          HIDDEN_HOLIDAYS_KEY,
          JSON.stringify(hiddenCalendarIds.filter((i) => i.startsWith(HOLIDAY_CALENDAR_PREFIX))),
        )
      } catch { /* quota / SSR */ }
      return { hiddenCalendarIds }
    }),

  setSearchQuery: (searchQuery) => set({ searchQuery, searchApplied: searchQuery.trim().length > 0 }),

  setSearchFilters: (f) =>
    set((s) => ({ searchFilters: { ...s.searchFilters, ...f } })),

  applySearch: () => set({ searchApplied: true }),

  clearSearch: () => set({
    searchQuery:   '',
    searchFilters: { ...DEFAULT_FILTERS },
    searchApplied: false,
  }),

  setWeatherEnabled:    (weatherEnabled)    => set({ weatherEnabled }),
  setWeatherLocationId: (weatherLocationId) => set({ weatherLocationId }),
  setMoonEnabled: (moonEnabled) => {
    try { localStorage.setItem(MOON_KEY, moonEnabled ? 'on' : 'off') } catch { /* quota / SSR */ }
    set({ moonEnabled })
  },
}))
