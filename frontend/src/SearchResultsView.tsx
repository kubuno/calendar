import { useState, useMemo, useEffect, useCallback, useRef, Fragment } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueries, useMutation, useQueryClient } from '@tanstack/react-query'
import { useCalendarStore, type ViewMode } from './store'
import {
  X, Calendar as CalendarIcon,
  Clock, MapPin, Search, Plus, Edit2, Copy, Trash2, Bell,
  Mail, Share2, AlignLeft, Check, User as UserIcon,
  MoreVertical, Printer, Link2, Lock, Globe,
  Repeat, Users, Briefcase, ChevronDown, Pipette, Video, Tag,
  LayoutGrid, Home, Building, Building2,
} from 'lucide-react'
import { useAuthStore } from '@kubuno/sdk'
import { FloatingWindow, MenuDropdown, type MenuItem, type MenuDropdownPos } from '@ui'
import { Dropdown, Checkbox, Button, DatePicker, Input, RichText, ColorPicker, useAppPickerTheme, useIsMobile } from '@ui'
import {
  format, startOfMonth, endOfMonth, startOfWeek, endOfWeek,
  eachDayOfInterval, isSameMonth, isToday,
  isSameDay, parseISO, addDays, startOfDay, endOfDay,
  startOfYear, endOfYear, getDay, subYears, addYears,
} from 'date-fns'
import DOMPurify from 'dompurify'
import { getDateLocale } from '@kubuno/sdk'
import {
  calendarApi, weatherApi, wmoInfo, weatherIconUrl, appointmentApi,
  type Calendar, type EventInstance, type DailyWeather,
  type EventReminder, type AppointmentSchedule,
} from './api'
import { ExtensionRegistry, ModuleServiceRegistry } from '@kubuno/sdk'
import { CALENDAR_OVERLAY, type CalendarOverlayItem, type CalendarOverlayProvider } from '@kubuno/sdk'
import {
  useCalendarSettings, timePattern, hourPattern, workDayFor, isWorkingHour,
  type CalendarSettings, type WeekStart, type WorkLocation,
} from './calendarSettings'
import { buildRrule, presetFromRrule, describeRrule } from './rrule'
import { copyKubunoData, eventEnvelope, openLabelPicker } from './kubunoData'
import RecurrenceCustomDialog from './RecurrenceCustomDialog'
import { MonoText } from './MonoText'
import {
  MoonIcon, PrincipalMoonIcon, moonPhase, moonIllumination,
  moonPhaseName, principalPhaseOfDay, principalPhaseName,
} from './moon'
import { Link, useParams, useNavigate, useLocation } from 'react-router-dom'

export function SearchResultsView({
  calendars,
  onEventClick,
}: {
  calendars: Calendar[]
  onEventClick: (ev: EventInstance) => void
}) {
  const { t, i18n } = useTranslation('calendar')
  const tPattern = timePattern(useCalendarSettings().timeFormat)
  const { searchQuery, searchFilters, clearSearch } = useCalendarStore()
  const calMap = useMemo(() => new Map(calendars.map(c => [c.id, c])), [calendars])

  // Fetch a broad range (±1 year) for searching
  const rangeStart = useMemo(() => subYears(new Date(), 1).toISOString(), [])
  const rangeEnd   = useMemo(() => addYears(new Date(), 1).toISOString(), [])

  const { data, isLoading } = useQuery({
    queryKey: ['calendar-events-search', rangeStart, rangeEnd],
    queryFn:  () => calendarApi.listEvents(rangeStart, rangeEnd),
  })

  const results = useMemo(() => {
    const all = data?.events ?? []
    const q         = (searchQuery || searchFilters.subject).toLowerCase().trim()
    const loc       = searchFilters.location.toLowerCase().trim()
    const exclude   = searchFilters.excludeWords.toLowerCase().trim()
    const dateFrom  = searchFilters.dateFrom ? parseISO(searchFilters.dateFrom + 'T00:00:00') : null
    const dateTo    = searchFilters.dateTo   ? parseISO(searchFilters.dateTo   + 'T23:59:59') : null

    return all.filter(ev => {
      const title = ev.title.toLowerCase()
      const desc  = (ev.description ?? '').toLowerCase()
      const evLoc = (ev.location ?? '').toLowerCase()

      if (q && !title.includes(q) && !desc.includes(q)) return false
      if (loc && !evLoc.includes(loc)) return false
      if (exclude) {
        const words = exclude.split(/\s+/)
        if (words.some(w => title.includes(w) || desc.includes(w))) return false
      }
      const evStart = parseISO(ev.starts_at)
      if (dateFrom && evStart < dateFrom) return false
      if (dateTo   && evStart > dateTo)   return false
      return true
    }).sort((a, b) => parseISO(a.starts_at).getTime() - parseISO(b.starts_at).getTime())
  }, [data, searchQuery, searchFilters])

  return (
    <div className="flex-1 overflow-y-auto px-6 py-4">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2 text-sm text-text-secondary">
          <Search size={14} />
          {isLoading
            ? t('searching')
            : t('search_results_count', { count: results.length })}
        </div>
        <button
          onClick={clearSearch}
          className="text-sm text-primary hover:text-primary-hover font-medium transition-colors"
        >
          {t('clear_search')}
        </button>
      </div>

      {/* Results list */}
      {!isLoading && results.length === 0 && (
        <div className="flex flex-col items-center justify-center py-20 text-text-tertiary">
          <Search size={40} className="opacity-20 mb-3" />
          <p className="text-sm">{t('no_events')}</p>
        </div>
      )}

      <div className="space-y-1">
        {results.map(ev => {
          const cal   = calMap.get(ev.calendar_id)
          const color = ev.color ?? cal?.color ?? '#4D38DB'
          const start = parseISO(ev.starts_at)
          const end   = parseISO(ev.ends_at)
          return (
            <button
              key={ev.id}
              onClick={() => onEventClick(ev)}
              className="w-full flex items-start gap-3 px-3 py-2.5 rounded-lg hover:bg-surface-1 transition-colors text-left"
            >
              <div className="w-3 h-3 rounded-full mt-1 shrink-0" style={{ backgroundColor: color }} />
              <div className="flex-1 min-w-0">
                <div className="flex items-baseline gap-3">
                  <span className="text-sm font-medium text-text-primary truncate">{ev.title}</span>
                  <span className="text-xs text-text-tertiary shrink-0">
                    {ev.all_day
                      ? format(start, 'd MMMM yyyy', { locale: getDateLocale(i18n.language) })
                      : <>{format(start, 'd MMM, ', { locale: getDateLocale(i18n.language) })}<MonoText>{format(start, tPattern)}</MonoText> – <MonoText>{format(end, tPattern)}</MonoText></>}
                  </span>
                </div>
                {ev.location && (
                  <div className="flex items-center gap-1 mt-0.5 text-xs text-text-tertiary">
                    <MapPin size={10} />
                    {ev.location}
                  </div>
                )}
                {cal && (
                  <span className="text-xs text-text-tertiary">{cal.name}</span>
                )}
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}
