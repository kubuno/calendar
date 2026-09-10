/**
 * Event picker mounted globally (slot `app-dialogs`) and driven by a promise:
 * a consumer module (chat…) calls the published `calendar.pickEvent` service,
 * the user picks an upcoming event, and the promise resolves with its
 * `calendar.event` envelope (or `null` when cancelled).
 *
 * Same pattern as drive's `FilesFolderPickerDialog`: the resolver lives in a
 * zustand store, so opening the dialog is a plain async call from anywhere —
 * no cross-module import, no shared React tree needed.
 */
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { create } from 'zustand'
import { formatDate, toDate, addDays, isSameDay } from '@kubuno/sdk'
import { CalendarDays, MapPin, Search, Video } from 'lucide-react'
import { Button, FloatingWindow, Spinner } from '@ui'
import { calendarApi, type EventInstance } from './api'
import { MonoText } from './MonoText'
import { eventEnvelope, MEETING_LINK_RE, type KubunoDataEnvelope } from './kubunoData'

/** How far ahead the picker looks for upcoming events. */
const HORIZON_DAYS = 60

interface EventPickerState {
  open:    boolean
  resolve: ((envelope: KubunoDataEnvelope | null) => void) | null
  /** Public API — called by consumer modules through `ModuleServiceRegistry`. */
  pickEvent: () => Promise<KubunoDataEnvelope | null>
  /** Internal API — called by the dialog only. */
  _resolve: (envelope: KubunoDataEnvelope | null) => void
}

export const useEventPickerStore = create<EventPickerState>((set, get) => ({
  open:    false,
  resolve: null,

  pickEvent: () => {
    // A picker already open would leave its caller hanging: resolve it first.
    get()._resolve(null)
    return new Promise(resolve => set({ open: true, resolve }))
  },

  _resolve: (envelope) => {
    const resolve = get().resolve
    set({ open: false, resolve: null })
    resolve?.(envelope)
  },
}))

/** Opens the picker and resolves with the chosen event's envelope (`null` = cancelled). */
export function pickEvent(): Promise<KubunoDataEnvelope | null> {
  return useEventPickerStore.getState().pickEvent()
}

function EventPickerInner({ onClose }: { onClose: (envelope: KubunoDataEnvelope | null) => void }) {
  const { t, i18n } = useTranslation('calendar')
  const [search, setSearch] = useState('')

  // Frozen at mount: keeps the query key (and the window) stable while open.
  const [range] = useState(() => {
    const now = new Date()
    return { from: now.toISOString(), to: addDays(now, HORIZON_DAYS).toISOString() }
  })

  const eventsQ = useQuery({
    queryKey: ['calendar-picker-events', range.from, range.to],
    queryFn:  () => calendarApi.listEvents(range.from, range.to),
    staleTime: 30_000,
  })

  // Client-side title filter, then grouped by day (days sorted, events sorted within).
  const groups = useMemo(() => {
    const q = search.trim().toLowerCase()
    const events = (eventsQ.data?.events ?? [])
      .filter(e => q === '' || e.title.toLowerCase().includes(q))
      .slice()
      .sort((a, b) => a.starts_at.localeCompare(b.starts_at))

    const out: { day: Date; events: EventInstance[] }[] = []
    for (const e of events) {
      const day = toDate(e.starts_at)
      const last = out[out.length - 1]
      if (last && isSameDay(last.day, day)) last.events.push(e)
      else out.push({ day, events: [e] })
    }
    return out
  }, [eventsQ.data, search])

  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

  return (
    <FloatingWindow
      title={t('picker_title', { defaultValue: 'Choisir un événement' })}
      icon={<CalendarDays size={17} className="text-primary" />}
      onClose={() => onClose(null)}
      defaultWidth={480}
      defaultHeight={520}
      resizable
    >
      <div className="flex flex-col flex-1 min-h-0">
        {/* Search */}
        <div className="px-4 py-2 border-b border-border bg-surface-1 flex-shrink-0">
          <div className="relative">
            <Search size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-text-tertiary pointer-events-none" />
            <input
              autoFocus
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder={t('picker_search_ph', { defaultValue: 'Rechercher un événement…' })}
              className="w-full pl-7 pr-2 py-1.5 text-xs border border-border rounded-lg bg-surface-0 text-text-primary outline-none focus:ring-1 focus:ring-primary"
            />
          </div>
        </div>

        {/* Upcoming events, grouped by day */}
        <div className="flex-1 overflow-y-auto p-3">
          {eventsQ.isLoading ? (
            <div className="flex items-center justify-center h-full"><Spinner /></div>
          ) : groups.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-text-tertiary gap-2">
              <CalendarDays size={32} strokeWidth={1} />
              <p className="text-xs">
                {search
                  ? t('picker_no_results', { defaultValue: 'Aucun événement correspondant' })
                  : t('picker_empty', { defaultValue: 'Aucun événement à venir' })}
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {groups.map(({ day, events }) => (
                <div key={day.toISOString()}>
                  <p className="px-1 pb-1 text-[11px] font-semibold text-text-secondary uppercase tracking-wide">
                    {cap(formatDate(day, 'weekdayDate'))}
                  </p>
                  <div className="space-y-0.5">
                    {events.map(e => {
                      const isMeeting = !!e.location && MEETING_LINK_RE.test(e.location)
                      return (
                        <button
                          key={e.id}
                          onClick={() => onClose(eventEnvelope(e))}
                          className="flex items-center gap-3 w-full px-3 py-2 rounded-lg hover:bg-surface-1 text-left"
                        >
                          <span
                            className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                            style={{ backgroundColor: e.color || '#4D38DB' }}
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block text-sm text-text-primary truncate">{e.title}</span>
                            {e.location && (
                              <span className="flex items-center gap-1 text-[11px] text-text-tertiary">
                                {isMeeting
                                  ? <Video  size={10} className="flex-shrink-0" />
                                  : <MapPin size={10} className="flex-shrink-0" />}
                                <span className="truncate">
                                  {isMeeting
                                    ? t('card_video_meeting', { defaultValue: 'Réunion vidéo' })
                                    : e.location}
                                </span>
                              </span>
                            )}
                          </span>
                          <span className="text-xs text-text-secondary flex-shrink-0">
                            {e.all_day
                              ? t('detail_all_day', { defaultValue: 'Toute la journée' })
                              : <MonoText>{formatDate(toDate(e.starts_at), 'time')}</MonoText>}
                          </span>
                        </button>
                      )
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 px-5 py-3 border-t border-border bg-surface-1 flex-shrink-0">
          <Button variant="secondary" size="sm" onClick={() => onClose(null)}>
            {t('cancel', { defaultValue: 'Annuler' })}
          </Button>
        </div>
      </div>
    </FloatingWindow>
  )
}

export default function EventPickerDialog() {
  const open    = useEventPickerStore(s => s.open)
  const resolve = useEventPickerStore(s => s._resolve)

  if (!open) return null
  return <EventPickerInner onClose={resolve} />
}
