import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Calendar, MapPin } from 'lucide-react'
import { formatDate, toDate, isToday, isTomorrow, DashboardWidget } from '@kubuno/sdk'
import type { ReactNode } from 'react'
import { calendarApi } from './api'
import { MonoText } from './MonoText'

type TFn = (key: string) => string

function eventDay(starts_at: string, t: TFn): string {
  const d = toDate(starts_at)
  if (isToday(d))    return t('today')
  if (isTomorrow(d)) return t('tomorrow')
  return formatDate(d, { weekday: 'short', day: 'numeric', month: 'short' })
}

function eventTime(event: { starts_at: string; ends_at: string; all_day: boolean }, t: TFn): ReactNode {
  if (event.all_day) return t('all_day')
  return <><MonoText>{formatDate(toDate(event.starts_at), 'time')}</MonoText> – <MonoText>{formatDate(toDate(event.ends_at), 'time')}</MonoText></>
}

export default function CalendarEventsWidget() {
  const { t, i18n } = useTranslation('calendar')
  const now   = new Date()
  const later = new Date(now.getTime() + 7 * 24 * 3600 * 1000)

  const { data, isLoading } = useQuery({
    queryKey: ['widget-calendar-events'],
    queryFn:  () => calendarApi.listEvents(now.toISOString(), later.toISOString()),
    staleTime: 60_000,
  })

  const events = (data?.events ?? []).slice(0, 6)

  return (
    <DashboardWidget
      title={t('upcoming_events')}
      icon={<Calendar size={15} className="text-green-600" />}
      link="/calendar"
    >
      {isLoading ? (
        <div className="px-4 py-6 text-center text-sm text-text-tertiary">{t('loading')}</div>
      ) : events.length === 0 ? (
        <div className="px-4 py-6 text-center text-sm text-text-tertiary italic">
          {t('no_events_7days')}
        </div>
      ) : (
        <ul className="divide-y divide-border">
          {events.map(ev => (
            <li key={ev.id} className="flex items-start gap-3 px-4 py-3 hover:bg-surface-1 transition-colors">
              {/* Indicateur couleur */}
              <div
                className="w-2.5 h-2.5 rounded-full mt-1.5 shrink-0"
                style={{ backgroundColor: ev.color ?? '#1a73e8' }}
              />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-text-primary truncate">{ev.title}</p>
                <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                  <span className="text-xs text-text-tertiary">{eventDay(ev.starts_at, t)}</span>
                  <span className="text-xs text-text-tertiary">·</span>
                  <span className="text-xs text-text-secondary">{eventTime(ev, t)}</span>
                  {ev.location && (
                    <>
                      <span className="text-xs text-text-tertiary">·</span>
                      <span className="text-xs text-text-tertiary flex items-center gap-0.5">
                        <MapPin size={10} />
                        {ev.location}
                      </span>
                    </>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </DashboardWidget>
  )
}
