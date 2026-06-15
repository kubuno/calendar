import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Calendar, MapPin } from 'lucide-react'
import { format, isToday, isTomorrow, parseISO, type Locale } from 'date-fns'
import { getDateLocale } from '@kubuno/sdk'
import { calendarApi } from './api'
import { DashboardWidget } from '@kubuno/sdk'

type TFn = (key: string) => string

function eventDay(starts_at: string, t: TFn, loc: Locale): string {
  const d = parseISO(starts_at)
  if (isToday(d))    return t('today')
  if (isTomorrow(d)) return t('tomorrow')
  return format(d, 'EEE d MMM', { locale: loc })
}

function eventTime(event: { starts_at: string; ends_at: string; all_day: boolean }, t: TFn): string {
  if (event.all_day) return t('all_day')
  return `${format(parseISO(event.starts_at), 'HH:mm')} – ${format(parseISO(event.ends_at), 'HH:mm')}`
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
                style={{ backgroundColor: ev.color ?? '#4D38DB' }}
              />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-text-primary truncate">{ev.title}</p>
                <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                  <span className="text-xs text-text-tertiary">{eventDay(ev.starts_at, t, getDateLocale(i18n.language))}</span>
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
