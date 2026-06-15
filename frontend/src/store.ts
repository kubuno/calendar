import { create } from 'zustand'

export type ViewMode = 'day' | 'week' | 'month' | 'year'

// Fuseau horaire secondaire (vue Jour) — préférence perso persistée localement.
const SECONDARY_TZ_KEY = 'kubuno:calendar:secondary-tz'
function loadSecondaryTz(): string | null {
  if (typeof localStorage === 'undefined') return null
  const v = localStorage.getItem(SECONDARY_TZ_KEY)
  return v && v.length > 0 ? v : null
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

  // Vue Jour — fuseau horaire secondaire (null = colonne unique)
  secondaryTimezone: string | null

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
  setSecondaryTimezone: (tz: string | null) => void
}

export const useCalendarStore = create<CalendarState>((set) => ({
  currentDate:       new Date(),
  viewMode:          'month',
  hiddenCalendarIds: [],
  pendingCreateDate: null,

  searchQuery:   '',
  searchFilters: { ...DEFAULT_FILTERS },
  searchApplied: false,

  weatherEnabled:    true,
  weatherLocationId: null,

  secondaryTimezone: loadSecondaryTz(),

  setCurrentDate:   (currentDate) => set({ currentDate }),
  setViewMode:      (viewMode) => set({ viewMode }),
  setPendingCreate: (pendingCreateDate) => set({ pendingCreateDate }),

  toggleCalendar: (id) =>
    set((s) => ({
      hiddenCalendarIds: s.hiddenCalendarIds.includes(id)
        ? s.hiddenCalendarIds.filter((i) => i !== id)
        : [...s.hiddenCalendarIds, id],
    })),

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
  setSecondaryTimezone: (secondaryTimezone) => {
    try {
      if (secondaryTimezone) localStorage.setItem(SECONDARY_TZ_KEY, secondaryTimezone)
      else localStorage.removeItem(SECONDARY_TZ_KEY)
    } catch { /* quota / SSR */ }
    set({ secondaryTimezone })
  },
}))
