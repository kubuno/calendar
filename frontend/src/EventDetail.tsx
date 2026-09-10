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
import { useAuthStore, toDate, formatDate, ExtensionRegistry, ModuleServiceRegistry, CALENDAR_OVERLAY, type CalendarOverlayItem, type CalendarOverlayProvider } from '@kubuno/sdk'
import { FloatingWindow, MenuDropdown, type MenuItem, type MenuDropdownPos } from '@ui'
import { Dropdown, Checkbox, Button, DatePicker, Input, RichText, ColorPicker, useAppPickerTheme, useIsMobile } from '@ui'
import DOMPurify from 'dompurify'
import {
  calendarApi, weatherApi, wmoInfo, weatherIconUrl, appointmentApi,
  type Calendar, type EventInstance, type DailyWeather,
  type EventReminder, type AppointmentSchedule,
} from './api'
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
import { isCalendarLocked, MEETING_LINK_RE, REMINDER_OPTIONS } from './calendarUtils'

function HeaderIconBtn({ title, onClick, danger, children }: {
  title: string; onClick: (e: React.MouseEvent<HTMLButtonElement>) => void; danger?: boolean; children: React.ReactNode
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      className={`p-1.5 rounded-full transition-colors text-text-secondary
                  ${danger ? 'hover:bg-danger/10 hover:text-danger' : 'hover:bg-surface-2 hover:text-text-primary'}`}
    >
      {children}
    </button>
  )
}

export function EventDetail({
  event, calendars, onClose, onDelete, onEdit,
}: {
  event: EventInstance; calendars: Calendar[]
  onClose: () => void; onDelete: () => void; onEdit: () => void
}) {
  const { t, i18n } = useTranslation('calendar')
  const tPattern = timePattern(useCalendarSettings().timeFormat)
  const qc   = useQueryClient()
  const navigate = useNavigate()
  const user = useAuthStore(s => s.user)
  const meetingLink = event.location ? event.location.match(MEETING_LINK_RE)?.[0] ?? null : null
  const cal  = calendars.find(c => c.id === event.calendar_id)
  const color = event.color ?? cal?.color ?? '#4D38DB'
  const [copied, setCopied] = useState(false)
  const [moreMenu, setMoreMenu] = useState<MenuDropdownPos | null>(null)
  // Deleting a series: ask for the scope (occurrence / following / all).
  const [askDelScope, setAskDelScope] = useState(false)

  const { mutate: delMut, isPending } = useMutation<unknown, Error, string>({
    // `occurrence` = start of THIS occurrence — without it, this/following
    // would apply to the whole series backend-side.
    mutationFn: (scope: string) => calendarApi.deleteEvent(
      event.event_id, scope, scope !== 'all' ? event.starts_at : undefined),
    onSuccess:  () => { qc.invalidateQueries({ queryKey: ['calendar-events'] }); onDelete() },
  })
  const del = () => {
    if (event.is_recurring) setAskDelScope(true)
    else delMut('all')
  }

  const start = toDate(event.starts_at)
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
  const dateText = cap(event.all_day
    ? formatDate(start, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
    : `${formatDate(start, 'weekdayDate')} · ${t('detail_from_to', {
        from: formatDate(start, tPattern),
        to:   formatDate(toDate(event.ends_at), tPattern),
        defaultValue: `De {{from}} à {{to}}`,
      })}`)
  const recurrenceText = event.is_recurring ? describeRrule(event.rrule, i18n.language, start) : null
  const ownerName = user?.display_name || user?.username || user?.email || null

  // Plain-text summary of the event (for sharing / e-mail).
  const summary = [
    event.title,
    dateText + (recurrenceText ? `\n${recurrenceText}` : ''),
    event.location ? `📍 ${event.location}` : '',
    event.description ? `\n${event.description}` : '',
  ].filter(Boolean).join('\n')

  const inviteLink = `${window.location.origin}/calendar`

  const handleShare = async () => {
    const text = `${summary}\n\n${inviteLink}`
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch { /* clipboard indisponible */ }
  }

  const handleEmail = () => {
    const subject = encodeURIComponent(event.title)
    const body = encodeURIComponent(`${summary}\n\n${inviteLink}`)
    window.open(`mailto:?subject=${subject}&body=${body}`, '_blank')
  }

  const { mutate: duplicate } = useMutation<unknown, Error>({
    mutationFn: () => calendarApi.createEvent({
      calendar_id: event.calendar_id,
      title:       t('copy_suffix', { title: event.title }),
      description: event.description ?? undefined,
      location:    event.location    ?? undefined,
      starts_at:   event.starts_at,
      ends_at:     event.ends_at,
      all_day:     event.all_day,
      color:       event.color ?? undefined,
      reminders:   event.reminders?.length ? event.reminders : undefined,
    }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['calendar-events'] }); onClose() },
  })

  const handleCopyLink = async () => {
    try { await navigator.clipboard.writeText(inviteLink) } catch { /* indisponible */ }
  }

  // Cross-module copy: a JSON envelope pasteable as a rich card in chat, notes…
  const handleCopyCard = () => {
    copyKubunoData(eventEnvelope(event)).catch(() => {})
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  // Human-readable duration (e.g. "1 h", "30 min", "1 h 30").
  const durationText = (() => {
    if (event.all_day) return t('detail_all_day', { defaultValue: 'Toute la journée' })
    const mins = Math.max(0, Math.round((toDate(event.ends_at).getTime() - start.getTime()) / 60000))
    const h = Math.floor(mins / 60), m = mins % 60
    return [h ? `${h} h` : '', m ? `${m} min` : ''].filter(Boolean).join(' ') || '0 min'
  })()

  // Visibility (public/private) — only shown when not public, to stay minimal.
  const vis = (event.visibility || '').toLowerCase()
  const isPrivate = vis === 'private' || vis === 'confidential'

  const moreItems: MenuItem[] = [
    { type: 'action', icon: <Copy size={16} />,    label: t('duplicate'),                                          onClick: () => duplicate() },
    { type: 'action', icon: <Copy size={16} />,    label: t('detail_copy_card', { defaultValue: "Copier l'événement" }), onClick: handleCopyCard },
    { type: 'action', icon: <Tag size={16} />,     label: t('detail_kubuno_labels', { defaultValue: 'Étiquettes Kubuno…' }), onClick: () => { openLabelPicker(eventEnvelope(event)).catch(() => {}) } },
    { type: 'action', icon: <Link2 size={16} />,   label: t('detail_copy_link', { defaultValue: 'Copier le lien' }), onClick: handleCopyLink },
    { type: 'action', icon: <Printer size={16} />, label: t('print', { defaultValue: 'Imprimer' }),                onClick: () => window.print() },
  ]

  return (
    <FloatingWindow
      title={
        <span className="flex items-center gap-2 font-semibold text-text-primary">
          <span className="w-3 h-3 rounded-sm shrink-0 inline-block" style={{ backgroundColor: color }} />
          {event.title}
        </span>
      }
      titleActions={
        <div className="flex items-center gap-0.5">
          {/* Agenda en lecture seule / abonnement : pas de modification possible */}
          {!isCalendarLocked(cal) && (
            <>
              <HeaderIconBtn title={t('edit')} onClick={onEdit}><Edit2 size={16} /></HeaderIconBtn>
              <HeaderIconBtn title={t('delete')} danger onClick={() => del()}><Trash2 size={16} /></HeaderIconBtn>
            </>
          )}
          <HeaderIconBtn title={t('detail_send_email', { defaultValue: 'Envoyer par e-mail' })} onClick={handleEmail}><Mail size={16} /></HeaderIconBtn>
          <HeaderIconBtn
            title={t('more_options', { defaultValue: "Plus d'options" })}
            onClick={e => { const r = e.currentTarget.getBoundingClientRect(); setMoreMenu(m => m ? null : { top: r.bottom + 4, left: r.left }) }}
          ><MoreVertical size={16} /></HeaderIconBtn>
        </div>
      }
      onClose={onClose}
      defaultWidth={380}
      backdrop
    >
      <div className="px-5 py-4">
        {/* Scope of the deletion of a recurring event */}
        {askDelScope && (
          <div className="fixed inset-0 z-[90] flex items-center justify-center" onClick={() => setAskDelScope(false)}>
            <div className="absolute inset-0 bg-black/30" />
            <div className="relative bg-surface-0 rounded-2xl shadow-xl w-full max-w-sm p-5" onClick={e => e.stopPropagation()}>
              <h3 className="text-sm font-semibold text-text-primary mb-1">
                {t('delete_recurring_title', { defaultValue: 'Supprimer l’événement récurrent' })}
              </h3>
              <p className="text-xs text-text-secondary mb-4">
                {t('delete_recurring_desc', { defaultValue: 'Quels événements de la série supprimer ?' })}
              </p>
              <div className="flex flex-col gap-2">
                <button onClick={() => { setAskDelScope(false); delMut('this') }} disabled={isPending}
                  className="w-full text-sm px-3 py-2 rounded-lg border border-border hover:bg-surface-1 text-left">
                  {t('move_this_only', { defaultValue: 'Cet événement seulement' })}
                </button>
                <button onClick={() => { setAskDelScope(false); delMut('following') }} disabled={isPending}
                  className="w-full text-sm px-3 py-2 rounded-lg border border-border hover:bg-surface-1 text-left">
                  {t('move_this_following', { defaultValue: 'Celui-ci et les suivants' })}
                </button>
                <button onClick={() => { setAskDelScope(false); delMut('all') }} disabled={isPending}
                  className="w-full text-sm px-3 py-2 rounded-lg bg-danger text-white hover:opacity-90 text-left">
                  {t('delete_all_events', { defaultValue: 'Tous les événements' })}
                </button>
                <button onClick={() => setAskDelScope(false)} className="w-full text-sm px-3 py-1.5 text-text-secondary">
                  {t('cancel')}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Date + duration + recurrence */}
        <div className="flex items-start gap-3">
          <Clock size={18} className="shrink-0 text-text-tertiary mt-0.5" />
          <div className="text-sm text-text-primary leading-snug">
            <div>{dateText} <span className="text-text-tertiary">· {durationText}</span></div>
            {recurrenceText && (
              <div className="text-text-secondary mt-0.5">{recurrenceText}</div>
            )}
          </div>
        </div>

        {/* Invite with a link */}
        <button
          type="button"
          onClick={handleShare}
          className="mt-4 inline-flex items-center gap-2 px-4 py-2 rounded-full border border-border
                     text-sm font-medium text-primary hover:bg-primary/5 transition-colors"
        >
          {copied ? <Check size={16} /> : <Share2 size={16} />}
          {copied
            ? t('detail_link_copied', { defaultValue: 'Lien copié' })
            : t('detail_invite_link', { defaultValue: 'Inviter avec un lien' })}
        </button>

        {/* Video meeting — join button (link provided by the chat module) */}
        {meetingLink && (
          <button
            type="button"
            onClick={() => { onClose(); navigate(meetingLink) }}
            className="mt-4 inline-flex items-center gap-2 px-4 py-2 rounded-md bg-primary text-white text-sm font-medium hover:bg-primary-hover transition-colors"
          >
            <Video size={16} /> {t('join_video_meeting', { defaultValue: 'Rejoindre la réunion vidéo' })}
          </button>
        )}

        {/* Lieu */}
        {event.location && !meetingLink && (
          <div className="flex items-start gap-3 mt-4">
            <MapPin size={18} className="shrink-0 text-text-tertiary mt-0.5" />
            <div className="text-sm text-text-primary break-words">{event.location}</div>
          </div>
        )}

        {/* Description (texte enrichi rendu en HTML assaini, ou texte brut) */}
        {event.description && (
          <div className="flex items-start gap-3 mt-4">
            <AlignLeft size={18} className="shrink-0 text-text-tertiary mt-0.5" />
            {/<[a-z][\s\S]*>/i.test(event.description) ? (
              <div className="text-sm text-text-primary break-words leading-relaxed
                              [&_a]:text-primary [&_a]:underline [&_ul]:list-disc [&_ol]:list-decimal [&_ul]:ml-5 [&_ol]:ml-5"
                   dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(event.description) }} />
            ) : (
              <p className="text-sm text-text-primary whitespace-pre-wrap break-words">{event.description}</p>
            )}
          </div>
        )}

        {/* Rappels */}
        {event.reminders && event.reminders.length > 0 && (
          <div className="flex items-start gap-3 mt-4">
            <Bell size={18} className="shrink-0 text-text-tertiary mt-0.5" />
            <div className="text-sm text-text-primary space-y-0.5">
              {event.reminders.map((r, i) => {
                const opt = REMINDER_OPTIONS.find(o => o.value === r.minutes_before)
                const label = opt ? t(opt.labelKey) : t('rem_minutes', { count: r.minutes_before })
                const channel = (r.type || '').toLowerCase() === 'email'
                  ? t('rem_by_email', { defaultValue: 'par e-mail' })
                  : t('rem_by_notification', { defaultValue: 'par notification' })
                return <div key={i}>{t('reminder_before', { time: label })}, {channel}</div>
              })}
            </div>
          </div>
        )}

        {/* Visibility */}
        <div className="flex items-start gap-3 mt-4">
          {isPrivate
            ? <Lock size={18} className="shrink-0 text-text-tertiary mt-0.5" />
            : <Globe size={18} className="shrink-0 text-text-tertiary mt-0.5" />}
          <div className="text-sm text-text-primary">
            {isPrivate
              ? t('detail_visibility_private', { defaultValue: 'Privé' })
              : t('detail_visibility_public', { defaultValue: 'Visibilité par défaut' })}
          </div>
        </div>

        {/* Calendar + owner */}
        {cal && (
          <div className="flex items-start gap-3 mt-4">
            <CalendarIcon size={18} className="shrink-0 text-text-tertiary mt-0.5" />
            <div className="text-sm text-text-primary leading-snug">
              <div>{cal.name}</div>
              {ownerName && (
                <div className="text-text-secondary mt-0.5 flex items-center gap-1">
                  <UserIcon size={13} className="text-text-tertiary" /> {ownerName}
                </div>
              )}
            </div>
          </div>
        )}

        {isPending && (
          <div className="text-xs text-text-tertiary mt-4 text-right">{t('deleting')}</div>
        )}
      </div>
      {moreMenu && (
        <MenuDropdown items={moreItems} pos={moreMenu} onClose={() => setMoreMenu(null)} />
      )}
    </FloatingWindow>
  )
}

// ── Context menu ──────────────────────────────────────────────────────────────

