/**
 * The card of an event — the one card, whether the event exists yet or not.
 *
 * ## Why one card and not two
 *
 * There used to be two: this one to create, and a separate detail window to
 * consult and to reach the editor from. They showed the same event, an inch
 * apart, and agreed on almost nothing — different surface, different rows, the
 * video call dressed by the chat module here and a bare button there. Two
 * places to change every time the event gains a field, and two chances to
 * forget one. So there is one card now: empty for a new event, filled for an
 * existing one, and the things only an existing event can offer — delete, send
 * by e-mail, invite with a link, the reminders it already carries — appear when
 * there is an event to offer them for.
 *
 * ## The rows
 *
 * Each row below the title is a VERB until it is used — "Add guests", "Add a
 * location" — and becomes the field once clicked. A card that opened with eight
 * empty inputs would look like the form it exists to avoid. On an existing
 * event the same rows open already filled, so consulting and changing are the
 * same gesture rather than two modes.
 *
 * ## What stays in the full editor
 *
 * The day itself, the recurrence rule, guests of an event that already exists
 * (they are invited live, not on save), rooms, colour and the free/busy flag.
 * "More options" hands everything typed here to the editor rather than starting
 * again — and, when a video room was created for a draft that is not saved yet,
 * it hands that over too.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Clock, Users, Video, MapPin, AlignLeft, Calendar as CalendarIcon,
  Bell, Globe, Lock, Share2, Check, Mail, Trash2, MoreVertical,
  Copy, Tag, Link2, Printer, User as UserIcon,
} from 'lucide-react'
import { MEETING_LINK_RE } from './calendarUtils'
import { AnchoredPopover, Button, DatePicker, Dropdown, Input, RichText, MenuDropdown, type MenuItem, type MenuDropdownPos } from '@ui'
import { SlotRegistry, useAuthStore, useModulesStore, formatDate, toDate } from '@kubuno/sdk'
import { VIDEO_MEETING_FIELD, type VideoMeetingFieldProps, type VideoMeetingDraft } from './videoMeetingField'
import { RemindersSection } from './RemindersField'
import { GuestField } from './GuestField'
import { GuestRow, GuestCalendarNote, calendarUnknown, useGuestConflicts } from './GuestRow'
import { describeRrule } from './rrule'
import { LabelField, useLabelOptions, useEventLabels, saveEventLabels } from './labels'
import { plainText } from './richtext'
import { copyKubunoData, eventEnvelope, openLabelPicker } from './kubunoData'
import { useCalendarSettings, timePattern } from './calendarSettings'
import { calendarApi, type Calendar, type EventInstance, type EventReminder } from './api'

/** Where the card hangs: the point that was clicked in the grid. */
export interface QuickAnchor { x: number; y: number }

export interface QuickDraft {
  title:       string
  start:       Date
  end:         Date
  allDay:      boolean
  /** Objects, not addresses: a guest picked from the people list carries an
   *  account (and a face) the address alone would lose. */
  guests:      GuestDraft[]
  location:    string
  /** The video call's link. Its own field: a call is not a place. */
  url:         string
  description: string
  calendarId:  string
  /** Chosen before the event exists; attached the moment it does. */
  labelIds:    string[]
}

export interface GuestDraft {
  email:        string
  user_id?:     string
  display_name?: string
  avatar_url?:  string
  optional?:    boolean
}

const pad = (n: number) => String(n).padStart(2, '0')
const hhmm = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`

export function EventCard({
  event, start, end, allDay, anchor, calendars, defaultCalendarId,
  onDraftChange, onClose, onMore, onEdit, onSave, saving,
}: {
  /** The event being consulted or changed; absent means a new one. */
  event?: EventInstance | null
  start:  Date
  end:    Date
  allDay: boolean
  anchor: QuickAnchor
  calendars: Calendar[]
  defaultCalendarId: string
  /** The grid draws a provisional block; it follows what is typed here. */
  onDraftChange?: (d: { title: string; start: Date; end: Date; allDay: boolean }) => void
  onClose: () => void
  /** New event: hand everything typed so far to the full editor. */
  onMore?:  (d: QuickDraft) => void
  /** Existing event: open the full editor on it. */
  onEdit?:  () => void
  /** New event: create it. An existing one is saved by this card itself. */
  onSave?:  (d: QuickDraft) => void
  saving?:  boolean
}) {
  const { t, i18n } = useTranslation('calendar')
  const qc = useQueryClient()
  const user = useAuthStore(s => s.user)
  const tPattern = timePattern(useCalendarSettings().timeFormat)
  const editing = Boolean(event)

  const [title,   setTitle]   = useState(event?.title ?? '')
  const [from,    setFrom]    = useState(start)
  const [to,      setTo]      = useState(end)
  const [dayLong, setDayLong] = useState(allDay)
  const [showTime, setShowTime] = useState(!allDay)
  const [guests,  setGuests]  = useState<GuestDraft[]>([])
  const [guestDraft, setGuestDraft] = useState('')
  // Who among them already has something else at that hour. Same question the
  // full editor asks, asked the same way.
  const guestBusy = useGuestConflicts(from, to, guests)
  const [openRow, setOpenRow] = useState<null | 'guests' | 'location' | 'url' | 'description' | 'reminders' | 'labels'>(null)
  const [location, setLocation] = useState(event?.location ?? '')
  const [url,      setUrl]      = useState(event?.url ?? '')
  const [desc,     setDesc]     = useState(event?.description ?? '')
  const [calId,    setCalId]    = useState(event?.calendar_id ?? defaultCalendarId)
  const [reminders, setReminders] = useState<EventReminder[]>(event?.reminders ?? [])
  const [visibility, setVisibility] = useState(event?.visibility || 'default')
  // The instance's labels. On an existing event they are read from the core; on
  // a new one they are simply held here until there is something to attach them
  // to — see `labels.ts`.
  const labelOptions = useLabelOptions()
  const eventLabels  = useEventLabels(event)
  const [labelIds, setLabelIds] = useState<string[]>([])
  const labelsLoaded = useRef(false)
  useEffect(() => {
    // Adopted once, when the answer arrives: re-adopting on every render would
    // undo a choice made while the request was still in flight.
    if (!labelsLoaded.current && eventLabels.data) { labelsLoaded.current = true; setLabelIds(eventLabels.data) }
  }, [eventLabels.data])
  const [copied,   setCopied]   = useState(false)
  const [moreMenu, setMoreMenu] = useState<MenuDropdownPos | null>(null)
  /** Changing or deleting a series: which occurrences? */
  const [askScope, setAskScope] = useState<null | 'save' | 'delete'>(null)

  // The same hole the full editor offers, filled by the same module. This card
  // used to create the room itself through a second, private path — so the one
  // that hosts meetings dressed the editor and not this, and the link it wrote
  // landed in the LOCATION field. One mechanism now, or the two forms drift
  // apart again the next time either is touched.
  const { activeModules, loadedVersion } = useModulesStore()
  const VideoMeeting = useMemo(
    () => SlotRegistry.getActiveOverride<VideoMeetingFieldProps>(
      VIDEO_MEETING_FIELD,
      new Set(activeModules.map(m => m.module_id)),
    ),
    [activeModules, loadedVersion],
  )
  // What the provider is holding for this unsaved card — see `VideoMeetingDraft`.
  const meetingDraft = useRef<VideoMeetingDraft | null>(null)
  const onMeetingDraft = useCallback((d: VideoMeetingDraft | null) => { meetingDraft.current = d }, [])
  // Was this draft settled — saved, or handed on to the editor? Anything else
  // that makes this card go away is an abandonment.
  const settled = useRef(false)
  // The cleanup, on UNMOUNT rather than on a close handler. The card is closed
  // from several places — its own dismissal, Escape caught by the page, the
  // view swapping underneath it — and hooking each one is how a path gets
  // missed (it was: Escape went straight to the parent and the room stayed).
  // Disappearing is the one thing they all do.
  useEffect(() => () => { if (!settled.current) meetingDraft.current?.discard() }, [])

  // The block in the grid is this card's reflection: it moves when the hour
  // moves and it is named when the title is typed.
  useEffect(() => {
    onDraftChange?.({ title, start: from, end: to, allDay: dayLong })
  }, [title, from, to, dayLong]) // eslint-disable-line react-hooks/exhaustive-deps

  const titleRef = useRef<HTMLInputElement>(null)
  useEffect(() => { titleRef.current?.focus() }, [])

  const draft = (): QuickDraft => ({
    title: title.trim(), start: from, end: to, allDay: dayLong,
    guests, location: location.trim(), url: url.trim(),
    description: desc.trim(), calendarId: calId, labelIds,
  })

  // ── Saving ────────────────────────────────────────────────────────────────
  const { mutate: update, isPending: updating } = useMutation<unknown, Error, string | undefined>({
    mutationFn: (scope?: string) => calendarApi.updateEvent(event!.event_id, {
      calendar_id: calId,
      title:       title.trim(),
      description: desc.trim(),
      location:    location.trim(),
      url:         url.trim(),
      starts_at:   from.toISOString(),
      ends_at:     to.toISOString(),
      all_day:     dayLong,
      reminders,
      // "Default visibility" (UI) is the backend's default, which is public.
      visibility:  visibility === 'default' ? 'public' : visibility,
      ...(scope ? { scope, ...(scope !== 'all' ? { occurrence: event!.starts_at } : {}) } : {}),
    }),
    onSuccess: async () => {
      // The labels are the core's, not the calendar's, so they are a second
      // write — and a failure there must not lose the event that was just
      // saved. It is reported by the labels row going stale, not by refusing
      // the save.
      try { await saveEventLabels(event!, labelIds) } catch { /* l'évènement, lui, est enregistré */ }
      qc.invalidateQueries({ queryKey: ['calendar-events'] })
      qc.invalidateQueries({ queryKey: ['event-labels'] })
      onClose()
    },
  })

  const { mutate: remove, isPending: removing } = useMutation<unknown, Error, string>({
    // `occurrence` = the start of THIS one — without it, this/following would
    // apply to the whole series backend-side.
    mutationFn: (scope: string) => calendarApi.deleteEvent(
      event!.event_id, scope, scope !== 'all' ? event!.starts_at : undefined),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['calendar-events'] }); onClose() },
  })

  /** Settle the draft, then do the thing. Confirming the room BEFORE the write
   *  is the one order that cannot leave a saved event pointing at a room that
   *  is still counting down to its own removal. */
  const commitThen = useCallback(async (run: () => void) => {
    settled.current = true
    await meetingDraft.current?.commit()
    meetingDraft.current = null
    run()
  }, [])

  const busy = Boolean(saving) || updating || removing

  const submit = () => void commitThen(() => {
    if (!editing) { onSave?.(draft()); return }
    if (event!.is_recurring) setAskScope('save')
    else update(undefined)
  })

  const del = () => {
    if (event!.is_recurring) setAskScope('delete')
    else remove('all')
  }

  // ── What only an existing event can say ───────────────────────────────────
  const evStart = event ? toDate(event.starts_at) : from
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
  const dateLabel = (d: Date) =>
    d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })
  const recurrenceText = event?.is_recurring ? describeRrule(event.rrule, i18n.language, evStart) : null
  const durationText = (() => {
    if (dayLong) return t('detail_all_day', { defaultValue: 'Toute la journée' })
    const mins = Math.max(0, Math.round((to.getTime() - from.getTime()) / 60000))
    const h = Math.floor(mins / 60), m = mins % 60
    return [h ? `${h} h` : '', m ? `${m} min` : ''].filter(Boolean).join(' ') || '0 min'
  })()
  // A call hosted on this instance carries the event's own name: renaming one
  // renames the other. Said HERE, next to the title, because that is where the
  // reader is about to type — a link discovered afterwards is a surprise.
  const titleIsShared = MEETING_LINK_RE.test(url.trim())
  const cal = calendars.find(c => c.id === calId)
  const ownerName = user?.display_name || user?.username || user?.email || null

  /** Plain-text summary of the event, for sharing and for e-mail. */
  const summary = [
    title,
    cap(dayLong
      ? formatDate(evStart, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
      : `${formatDate(evStart, 'weekdayDate')} · ${t('detail_from_to', {
          from: formatDate(from, tPattern), to: formatDate(to, tPattern),
          defaultValue: 'De {{from}} à {{to}}',
        })}`) + (recurrenceText ? `\n${recurrenceText}` : ''),
    location ? `📍 ${location}` : '',
    // The description is rich text; what goes on a clipboard or in a mail body
    // is the words, not the markup around them.
    desc ? `\n${plainText(desc)}` : '',
  ].filter(Boolean).join('\n')
  const inviteLink = `${window.location.origin}/calendar`

  const flash = () => { setCopied(true); setTimeout(() => setCopied(false), 2000) }
  const handleShare = async () => {
    try { await navigator.clipboard.writeText(`${summary}\n\n${inviteLink}`); flash() }
    catch { /* the clipboard may be refused; the card is still on screen */ }
  }
  const handleEmail = () => {
    window.open(`mailto:?subject=${encodeURIComponent(title)}&body=${encodeURIComponent(`${summary}\n\n${inviteLink}`)}`, '_blank')
  }
  const { mutate: duplicate } = useMutation<unknown, Error>({
    mutationFn: () => calendarApi.createEvent({
      calendar_id: event!.calendar_id,
      title:       t('copy_suffix', { title: event!.title }),
      description: event!.description ?? undefined,
      location:    event!.location ?? undefined,
      url:         event!.url ?? undefined,
      starts_at:   event!.starts_at,
      ends_at:     event!.ends_at,
      all_day:     event!.all_day,
      color:       event!.color ?? undefined,
      reminders:   event!.reminders?.length ? event!.reminders : undefined,
    }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['calendar-events'] }); onClose() },
  })

  const moreItems: MenuItem[] = [
    { type: 'action', icon: <Copy size={16} />,    label: t('duplicate'),                                                     onClick: () => duplicate() },
    { type: 'action', icon: <Copy size={16} />,    label: t('detail_copy_card', { defaultValue: "Copier l'événement" }),      onClick: () => { copyKubunoData(eventEnvelope(event!)).catch(() => {}); flash() } },
    { type: 'action', icon: <Tag size={16} />,     label: t('detail_kubuno_labels', { defaultValue: 'Étiquettes Kubuno…' }),  onClick: () => { openLabelPicker(eventEnvelope(event!)).catch(() => {}) } },
    { type: 'action', icon: <Link2 size={16} />,   label: t('detail_copy_link', { defaultValue: 'Copier le lien' }),          onClick: () => { navigator.clipboard.writeText(inviteLink).catch(() => {}) } },
    { type: 'action', icon: <Printer size={16} />, label: t('print', { defaultValue: 'Imprimer' }),                           onClick: () => window.print() },
  ]

  /** A row is a verb until it is used. */
  const row = (
    icon: React.ReactNode,
    filled: boolean,
    label: string,
    open: boolean,
    onOpen: () => void,
    field: React.ReactNode,
  ) => (
    <div className="flex items-start gap-3 px-1 py-1.5">
      <span className="mt-1 shrink-0 text-text-secondary">{icon}</span>
      {open || filled ? (
        <div className="min-w-0 flex-1">{field}</div>
      ) : (
        <button type="button" onClick={onOpen}
          className="flex-1 rounded px-1 py-1 text-left text-sm text-text-secondary hover:bg-surface-1">
          {label}
        </button>
      )}
    </div>
  )

  const iconBtn = (label: string, onClick: (e: React.MouseEvent<HTMLButtonElement>) => void, danger: boolean, glyph: React.ReactNode) => (
    <button type="button" title={label} aria-label={label} onClick={onClick}
      className={`grid h-8 w-8 place-items-center rounded-full transition-colors
                  ${danger ? 'text-text-secondary hover:bg-danger/10 hover:text-danger'
                           : 'text-text-secondary hover:bg-surface-1 hover:text-text-primary'}`}>
      {glyph}
    </button>
  )

  // A point, not an element: the card hangs where the pointer went down. Giving
  // the shared popover a zero-sized anchor is what lets it keep its own
  // clamping and its own dismissal behaviour.
  const point = useRef<HTMLSpanElement>(null)

  return (
    <>
      <span ref={point} style={{ position: 'fixed', left: anchor.x, top: anchor.y, width: 1, height: 1 }} />
      <AnchoredPopover anchorRef={point} open onClose={onClose}>
        <div
          /* The same form surface as the full editor: this card is that form,
             cut down, and it must not read as a different kind of thing. The
             class is the core's — it carries the canvas AND the fields' look,
             so the two stay in step without this file naming a colour. */
          className="kb-form-surface w-[380px] max-w-[92vw] rounded-xl border border-border p-3 shadow-xl"
          onMouseDown={e => e.stopPropagation()}
        >
          {/* The actions an event has to exist to offer. Above the form, not in
              a band of their own: this is a card, and a title bar on it would
              make it the window it deliberately is not. */}
          {editing && (
            <div className="mb-1 flex items-center justify-end gap-0.5">
              {iconBtn(copied ? t('detail_link_copied', { defaultValue: 'Lien copié' })
                              : t('detail_invite_link', { defaultValue: 'Inviter avec un lien' }),
                handleShare, false, copied ? <Check size={16} className="text-success" /> : <Share2 size={16} />)}
              {iconBtn(t('detail_send_email', { defaultValue: 'Envoyer par e-mail' }), handleEmail, false, <Mail size={16} />)}
              {iconBtn(t('delete'), del, true, <Trash2 size={16} />)}
              {iconBtn(t('more_options', { defaultValue: "Plus d'options" }),
                e => { const r = e.currentTarget.getBoundingClientRect(); setMoreMenu(m => m ? null : { top: r.bottom + 4, left: r.left }) },
                false, <MoreVertical size={16} />)}
            </div>
          )}

          <div className="relative mb-2">
            <Input
              ref={titleRef}
              value={title}
              onChange={e => setTitle(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !busy) submit() }}
              placeholder={t('quick_title', { defaultValue: 'Ajouter un titre et une heure' })}
              className={titleIsShared ? 'pr-8' : undefined}
            />
            {titleIsShared && (
              <span
                className="pointer-events-auto absolute right-2 top-1/2 -translate-y-1/2 text-text-tertiary"
                aria-label={t('title_linked', { defaultValue: 'Titre lié' })}
                title={t('title_linked_hint', { defaultValue: 'La visioconférence porte le même nom : le changer ici le change aussi là-bas.' })}
              >
                <Link2 size={14} />
              </span>
            )}
          </div>

          {row(<Clock size={17} />, true, '', true, () => {}, (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm text-text-primary">
                {cap(dateLabel(from))}
                {from.toDateString() !== to.toDateString() && ` – ${dateLabel(to)}`}
                {editing && <span className="text-text-tertiary"> · {durationText}</span>}
              </span>
              {showTime ? (
                <span className="flex items-center gap-1">
                  <DatePicker mode="time" value={hhmm(from)} onChange={v => {
                    if (!v) return
                    const [h, m] = v.split(':').map(Number)
                    const d = new Date(from); d.setHours(h, m, 0, 0); setFrom(d); setDayLong(false)
                  }} />
                  <span className="text-text-tertiary">–</span>
                  <DatePicker mode="time" value={hhmm(to)} onChange={v => {
                    if (!v) return
                    const [h, m] = v.split(':').map(Number)
                    const d = new Date(to); d.setHours(h, m, 0, 0); setTo(d); setDayLong(false)
                  }} />
                </span>
              ) : (
                <button type="button"
                  onClick={() => { setShowTime(true); setDayLong(false) }}
                  className="rounded-full border border-border px-3 py-1 text-sm text-primary hover:bg-surface-1">
                  {t('quick_set_time', { defaultValue: 'Préciser l’heure' })}
                </button>
              )}
              {/* Read, not edited: the rule itself is written in the editor,
                  where the whole series is in view. */}
              {recurrenceText && (
                <span className="w-full text-sm text-text-secondary">{recurrenceText}</span>
              )}
            </div>
          ))}

          {/* Guests of an event that already exists are invited live, one by
              one, with an answer each — that belongs to the editor's panel, not
              to a list this card would pretend to save. */}
          {!editing && row(<Users size={17} />, guests.length > 0, t('add_guests', { defaultValue: 'Ajouter des invités' }),
            openRow === 'guests', () => setOpenRow('guests'), (
            <div>
              {/* The SAME field and the same line as the full editor. This card
                  used to carry its own plain input and its own chips, which is
                  how a suggestion list and a face existed in one place and not
                  in the other, an inch apart. */}
              <GuestField value={guestDraft} onChange={setGuestDraft}
                exclude={guests.map(g => g.email)}
                onPick={g => {
                  const address = g.email.trim()
                  if (!address.includes('@') && !g.user_id) return
                  const key = address.toLowerCase() || `id:${g.user_id}`
                  if (guests.some(x => (x.email.toLowerCase() || `id:${x.user_id}`) === key)) { setGuestDraft(''); return }
                  setGuests(list => [...list, {
                    email: address, user_id: g.user_id,
                    display_name: g.display_name ?? undefined,
                    avatar_url: g.avatar_url ?? undefined,
                  }])
                  setGuestDraft('')
                }} />
              {guests.length > 0 && (
                <div className="mt-1 space-y-0.5">
                  {guests.map(g => (
                    <GuestRow key={g.email || g.user_id}
                      guest={{ email: g.email, user_id: g.user_id, display_name: g.display_name,
                               avatar_url: g.avatar_url, optional: g.optional }}
                      conflict={Boolean(g.user_id && guestBusy.has(g.user_id))}
                      onToggleOptional={() => setGuests(list => list.map(x =>
                        x.email === g.email ? { ...x, optional: !x.optional } : x))}
                      onRemove={() => setGuests(list => list.filter(x => x.email !== g.email))} />
                  ))}
                  {guests.some(g => calendarUnknown({ email: g.email, user_id: g.user_id })) && <GuestCalendarNote />}
                </div>
              )}
            </div>
          ))}

          {/* The video call. Whoever hosts meetings on this instance dresses the
              row — its own mark in the gutter, its own card in the line — and
              the plain link field stands in when nobody does. Identical to the
              full editor because it IS the editor's row, and it carries the
              join link, so no separate "Join" button is needed here. */}
          {VideoMeeting ? (
            <div className="flex items-start gap-3 px-1 py-1.5">
              <span className="mt-1 shrink-0 text-text-secondary">
                <VideoMeeting part="icon" url={url} title={title} onChange={setUrl} />
              </span>
              <div className="min-w-0 flex-1">
                <VideoMeeting url={url} title={title} onChange={setUrl} onDraft={onMeetingDraft} />
              </div>
            </div>
          ) : (
            row(<Video size={17} />, url !== '', t('add_video_link', { defaultValue: 'Ajouter un lien de visioconférence' }),
              openRow === 'url', () => setOpenRow('url'), (
              <Input type="url" inputMode="url" autoComplete="off" spellCheck={false}
                value={url} onChange={e => setUrl(e.target.value)}
                placeholder={t('add_video_link', { defaultValue: 'Ajouter un lien de visioconférence' })}
                className="w-full" />
            ))
          )}

          {row(<MapPin size={17} />, location !== '', t('add_location', { defaultValue: 'Ajouter un lieu' }),
            openRow === 'location', () => setOpenRow('location'), (
            <Input value={location} onChange={e => setLocation(e.target.value)}
              placeholder={t('add_location', { defaultValue: 'Ajouter un lieu' })} className="w-full" />
          ))}

          {/* The same description editor as the full form, and for a reason
              beyond consistency: a description is stored as rich text, so a
              plain box shows its markup instead of the words — a description
              written with a mention in it came back here as its own source. */}
          {row(<AlignLeft size={17} />, desc !== '', t('add_description', { defaultValue: 'Ajouter une description' }),
            openRow === 'description', () => setOpenRow('description'), (
            <RichText value={desc} onChange={setDesc} mentions={{ enabled: true }}
              placeholder={t('add_description', { defaultValue: 'Ajouter une description' })}
              minHeight={64} className="w-full" />
          ))}

          {/* Labels. Offered on a NEW event too: they are held until there is
              something to attach them to, which is what the form is for. */}
          {row(<Tag size={17} />, labelIds.length > 0, t('add_labels', { defaultValue: 'Ajouter des étiquettes' }),
            openRow === 'labels', () => setOpenRow('labels'), (
            <LabelField
              options={(labelOptions.data ?? []).map(l => ({ id: l.id, name: l.name, color: l.color }))}
              value={labelIds} onChange={setLabelIds}
              placeholder={t('add_labels', { defaultValue: 'Ajouter des étiquettes' })}
              emptyHint={t('labels_none_yet', { defaultValue: 'Aucune étiquette. Créez-en depuis la page Étiquettes.' })}
              searchPlaceholder={t('search', { defaultValue: 'Rechercher' })} />
          ))}

          {/* Reminders and visibility: shown on an existing event, because that
              is what the card it replaces showed — and editable, because a card
              that displays a setting it will not let you change is a dead end. */}
          {editing && row(<Bell size={17} />, reminders.length > 0, t('add_reminder', { defaultValue: 'Ajouter un rappel' }),
            openRow === 'reminders', () => setOpenRow('reminders'), (
            <RemindersSection reminders={reminders} onChange={setReminders} />
          ))}

          {editing && row(
            visibility === 'private' ? <Lock size={17} /> : <Globe size={17} />,
            true, '', true, () => {}, (
            <Dropdown value={visibility || 'default'} onChange={setVisibility} width="100%"
              options={[
                { value: 'default', label: t('vis_default', { defaultValue: 'Visibilité par défaut' }) },
                { value: 'public',  label: t('vis_public', { defaultValue: 'Public' }) },
                { value: 'private', label: t('vis_private', { defaultValue: 'Privé' }) },
              ]} />
          ))}

          {row(<CalendarIcon size={17} />, true, '', true, () => {}, (
            <div>
              <Dropdown value={calId} onChange={setCalId} width="100%"
                options={calendars.map(c => ({ value: c.id, label: c.name }))} />
              {editing && ownerName && (
                <div className="mt-1 flex items-center gap-1 text-xs text-text-secondary">
                  <UserIcon size={13} className="text-text-tertiary" /> {ownerName}
                </div>
              )}
            </div>
          ))}

          <div className="mt-2 flex items-center justify-end gap-2">
            {/* Settled, but neither committed nor discarded: the room travels
                with the link, and the editor adopts it. */}
            <button type="button"
              onClick={() => { settled.current = true; editing ? onEdit?.() : onMore?.(draft()) }}
              className="rounded px-2 py-1 text-sm font-medium text-primary hover:bg-surface-1">
              {t('quick_more_options', { defaultValue: 'Autres options' })}
            </button>
            <Button onClick={submit} disabled={busy} loading={busy}>
              {t('save', { defaultValue: 'Enregistrer' })}
            </Button>
          </div>
        </div>
      </AnchoredPopover>

      {/* One question, two verbs: a series is changed or dropped by the same
          three choices, and asking them in one place keeps the wording the
          same whichever the reader picked. */}
      {askScope && (
        <div className="fixed inset-0 z-[90] flex items-center justify-center" onClick={() => setAskScope(null)}>
          <div className="absolute inset-0 bg-black/30" />
          <div className="relative w-full max-w-sm rounded-2xl bg-surface-0 p-5 shadow-xl" onClick={e => e.stopPropagation()}>
            <h3 className="mb-1 text-base font-medium text-text-primary">
              {askScope === 'delete'
                ? t('delete_recurring_title', { defaultValue: 'Supprimer l’événement récurrent' })
                : t('edit_recurring_title', { defaultValue: 'Modifier l’événement récurrent' })}
            </h3>
            <p className="mb-4 text-sm text-text-secondary">
              {askScope === 'delete'
                ? t('delete_recurring_desc', { defaultValue: 'Quels événements de la série supprimer ?' })
                : t('edit_recurring_desc', { defaultValue: 'Quels événements de la série modifier ?' })}
            </p>
            <div className="space-y-2">
              {(['this', 'following', 'all'] as const).map(scope => (
                <button key={scope} disabled={busy}
                  onClick={() => { setAskScope(null); askScope === 'delete' ? remove(scope) : update(scope) }}
                  className="w-full rounded-lg border border-border px-3 py-2 text-left text-sm hover:bg-surface-1">
                  {scope === 'this'      ? t('move_this_only', { defaultValue: 'Cet événement seulement' })
                   : scope === 'following' ? t('move_this_following', { defaultValue: 'Celui-ci et les suivants' })
                   : askScope === 'delete' ? t('delete_all_events', { defaultValue: 'Tous les événements' })
                   : t('edit_all_events', { defaultValue: 'Tous les événements' })}
                </button>
              ))}
              <button onClick={() => setAskScope(null)} className="w-full px-3 py-1.5 text-sm text-text-secondary">
                {t('cancel')}
              </button>
            </div>
          </div>
        </div>
      )}

      {moreMenu && <MenuDropdown items={moreItems} pos={moreMenu} onClose={() => setMoreMenu(null)} />}
    </>
  )
}
