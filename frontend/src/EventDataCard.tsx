/**
 * Rich card rendering `calendar.event` envelopes inside CONSUMER modules
 * (chat, notes…). Registered on the `core.data-card` extension point from
 * `entry.ts`, so consumers resolve it dynamically and never import calendar's
 * code — when calendar is not installed they fall back to a generic JSON card.
 */
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { formatDate, toDate } from '@kubuno/sdk'
import { CalendarDays, ExternalLink, MapPin, Repeat, Video } from 'lucide-react'
import { describeRrule } from './rrule'
import { MEETING_LINK_RE, type CalendarEventData, type DataCardProps } from './kubunoData'
import { MonoText } from './MonoText'

/** Narrowing guard: an envelope payload we can actually render. */
export function eventDataOf(envelope: DataCardProps['envelope']): CalendarEventData | null {
  const d = envelope.data as CalendarEventData | null
  return d && typeof d.starts_at === 'string' && typeof d.title === 'string' ? d : null
}

export default function EventDataCard({ envelope }: DataCardProps) {
  const { t, i18n } = useTranslation('calendar')
  const navigate = useNavigate()

  const info = useMemo(() => {
    const d = eventDataOf(envelope)
    if (!d) return null
    const start = toDate(d.starts_at)
    const cap   = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
    const datePart = cap(formatDate(start, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }))
    const dateText = d.all_day
      ? <>{datePart} · {t('detail_all_day', { defaultValue: 'Toute la journée' })}</>
      : <>{datePart} · <MonoText>{formatDate(start, 'time')}</MonoText>–<MonoText>{formatDate(toDate(d.ends_at), 'time')}</MonoText></>
    const isMeeting = !!d.location && MEETING_LINK_RE.test(d.location)
    return {
      data: d,
      dateText,
      isMeeting,
      recurrenceText: d.rrule ? describeRrule(d.rrule, i18n.language, start) : null,
    }
  }, [envelope, i18n.language, t])

  if (!info) return null
  const { data: d, dateText, isMeeting, recurrenceText } = info

  const open = () => { if (envelope.href) navigate(envelope.href) }

  return (
    <div
      className="w-72 max-w-full rounded-xl border border-border bg-surface-0 overflow-hidden cursor-pointer hover:border-strong transition-colors"
      onClick={open}
      role="button"
      title={t('card_open_in_calendar', { defaultValue: "Ouvrir dans l'agenda" })}
    >
      <div className="px-3 py-2 flex items-start gap-2">
        <span
          className="w-2.5 h-2.5 rounded-full mt-1 flex-shrink-0"
          style={{ backgroundColor: d.color || '#1a73e8' }}
        />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold text-text-primary truncate">{d.title}</p>

          <p className="text-[11px] text-text-secondary flex items-center gap-1 mt-0.5">
            <CalendarDays size={11} className="flex-shrink-0" />
            <span className="truncate">{dateText}</span>
          </p>

          {d.location && (
            <p className="text-[11px] text-text-tertiary flex items-center gap-1 mt-0.5">
              {isMeeting
                ? <Video  size={11} className="flex-shrink-0" />
                : <MapPin size={11} className="flex-shrink-0" />}
              <span className="truncate">
                {isMeeting
                  ? t('card_video_meeting', { defaultValue: 'Réunion vidéo' })
                  : d.location}
              </span>
            </p>
          )}

          {recurrenceText && (
            <p className="text-[11px] text-text-tertiary flex items-center gap-1 mt-0.5">
              <Repeat size={11} className="flex-shrink-0" />
              <span className="truncate">{recurrenceText}</span>
            </p>
          )}
        </div>
        <ExternalLink size={13} className="text-text-tertiary mt-0.5 flex-shrink-0" />
      </div>
    </div>
  )
}
