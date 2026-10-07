import { useState, useMemo, useEffect, useCallback, useRef, Fragment } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueries, useMutation, useQueryClient } from '@tanstack/react-query'
import { useCalendarStore, type ViewMode } from './store'
import { useInstancePolicy, isInternalAddress } from './instancePolicy'
import { userTimezone } from './timezones'
import {
  X, Calendar as CalendarIcon,
  Clock, MapPin, Search, Plus, Edit2, Copy, Trash2, Bell,
  Share2, AlignLeft, Check, User as UserIcon,
  MoreVertical, Menu, Printer, Link2, Lock, Globe,
  Repeat, Users, UserMinus, Briefcase, ChevronDown, Pipette, Video, Tag,
  LayoutGrid, Home, Building, Building2,
} from 'lucide-react'
import { useAuthStore, useModulesStore, SlotRegistry, toISODate, toDate, formatDate, addDays, ExtensionRegistry, ModuleServiceRegistry, CALENDAR_OVERLAY, type CalendarOverlayItem, type CalendarOverlayProvider } from '@kubuno/sdk'
import { VIDEO_MEETING_FIELD, type VideoMeetingFieldProps, type VideoMeetingDraft } from './videoMeetingField'
import { FloatingWindow, MenuDropdown, type MenuItem, type MenuDropdownPos } from '@ui'
import { Dropdown, Checkbox, Button, Callout, DatePicker, Input, RichText, ColorPicker, Tabs, useAppPickerTheme, useIsMobile } from '@ui'
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
import { ScheduleGrid } from './ScheduleGrid'
import { MonoText } from './MonoText'
import {
  MoonIcon, PrincipalMoonIcon, moonPhase, moonIllumination,
  moonPhaseName, principalPhaseOfDay, principalPhaseName,
} from './moon'
import { Link, useParams, useNavigate, useLocation } from 'react-router-dom'
import { EVENT_SWATCHES, MEETING_LINK_RE, writableCalendars } from './calendarUtils'
import { RemindersSection } from './RemindersField'
import { LabelField, useLabelOptions, useEventLabels, saveEventLabels } from './labels'
import { GuestField, looksLikeAddress } from './GuestField'
import { GuestRow, GuestCalendarNote, calendarUnknown, useGuestConflicts } from './GuestRow'
import { GuestPermissions, DEFAULT_GUEST_PERMS, type GuestPerms } from './GuestPermissions'

// ── Reminders section (shared between create and edit) ────────────────────────

// ── Recurrence (rrule) — shared helpers in ./rrule.ts ────────────────────────
function RecurrenceField({ preset, customRrule, onChange, onCustomRrule, start }: {
  preset: string
  /** RRULE when preset === 'custom' (edited through the dedicated dialog). */
  customRrule: string | null
  onChange: (p: string) => void
  onCustomRrule: (rrule: string) => void
  start: Date
}) {
  const { t, i18n } = useTranslation('calendar')
  const [showCustom, setShowCustom] = useState(false)
  const dayName = formatDate(start, 'weekday')
  const opts = [
    { value: 'none',    label: t('recur_none', { defaultValue: 'Ne se répète pas' }) },
    { value: 'daily',   label: t('recur_daily', { defaultValue: 'Tous les jours' }) },
    { value: 'weekly',  label: `${t('recur_weekly_prefix', { defaultValue: 'Toutes les semaines le' })} ${dayName}` },
    { value: 'weekday', label: t('recur_weekday', { defaultValue: 'Du lundi au vendredi' }) },
    { value: 'monthly', label: t('recur_monthly', { defaultValue: 'Tous les mois' }) },
    { value: 'yearly',  label: t('recur_yearly', { defaultValue: 'Tous les ans' }) },
  ]
  const isCustom = preset === 'custom'
  // Label of the "custom" entry: humanized summary of the current rule.
  const customLabel = (isCustom && describeRrule(customRrule, i18n.language, start))
    || t('recur_custom', { defaultValue: 'Récurrence personnalisée' })
  return (
    <div className="flex items-center gap-3">
      <Repeat size={18} className="shrink-0 text-text-tertiary" />
      <Dropdown
        className="flex-1"
        value={isCustom ? 'custom' : preset}
        onChange={(v: string) => {
          if (v === 'custom-open') setShowCustom(true)
          else onChange(v)
        }}
        options={[
          ...(isCustom ? [{ value: 'custom', label: customLabel }] : []),
          ...opts,
          { value: 'custom-open', label: `${t('recur_custom', { defaultValue: 'Récurrence personnalisée' })}…` },
        ]}
      />
      {isCustom && (
        <button
          onClick={() => setShowCustom(true)}
          title={t('recur_edit_custom', { defaultValue: 'Modifier la récurrence' })}
          className="shrink-0 p-1.5 rounded-lg text-text-tertiary hover:text-primary hover:bg-surface-2 transition-colors"
        >
          <Edit2 size={14} />
        </button>
      )}
      {showCustom && (
        <RecurrenceCustomDialog
          initialRrule={customRrule}
          start={start}
          onSave={onCustomRrule}
          onClose={() => setShowCustom(false)}
        />
      )}
    </div>
  )
}

// ── Event creation modal ──────────────────────────────────────────────────────

interface CreateModalProps {
  initialDate: Date | null
  /** Preselected end (creation by dragging on the grid). */
  initialEnd?: Date | null
  /** What was already typed in the quick card before "More options" was pressed.
   *  Handing it over is the whole point: the reader must never retype. */
  initialDraft?: QuickHandover | null
  calendars: Calendar[]
  onClose: () => void
}

/** The fields the quick card can already carry. */
export interface QuickHandover {
  title:       string
  allDay:      boolean
  guests:      Array<{ email: string; user_id?: string; display_name?: string; avatar_url?: string; optional?: boolean }>
  location:    string
  /** The video call's link, which may point at a room the quick card created
   *  and that nothing has confirmed yet — the editor takes it over as its own. */
  url:         string
  description: string
  calendarId:  string
  /** Chosen in the quick card before the event existed. */
  labelIds:    string[]
}

interface EditModalProps {
  event: EventInstance
  calendars: Calendar[]
  onClose: () => void
}

// ── Editor "More actions" menu ────────────────────────────────────────────────
function EditEventActionsMenu({ event, onClose }: { event: EventInstance; calendars: Calendar[]; onClose: () => void }) {
  const { t } = useTranslation('calendar')
  const qc = useQueryClient()
  const [pos, setPos] = useState<MenuDropdownPos | null>(null)
  const duplicate = () => {
    calendarApi.createEvent({
      calendar_id: event.calendar_id,
      title:       t('copy_suffix', { title: event.title }),
      description: event.description ?? undefined,
      location:    event.location ?? undefined,
      starts_at:   event.starts_at,
      ends_at:     event.ends_at,
      all_day:     event.all_day,
      rrule:       event.rrule ?? undefined,
      reminders:   event.reminders?.length ? event.reminders : undefined,
      visibility:  event.visibility,
    }).then(() => { qc.invalidateQueries({ queryKey: ['calendar-events'] }); onClose() })
  }
  const del = () => calendarApi.deleteEvent(event.event_id, 'all').then(() => {
    qc.invalidateQueries({ queryKey: ['calendar-events'] }); onClose()
  })
  return (
    <>
      {/* A glyph, not a label. The band is the window's own narrow strip and it
          already carries the title and the close button; two words there wrapped
          onto a second line and crowded the ✕. The name lives in the tooltip,
          where it costs no width.
          A menu bar, not an ellipsis: three dots are almost no ink, and on a
          coloured band seen from a normal distance they read as a smudge — the
          reader has to go looking for the button. This says "a menu" with the
          same certainty and ten times the mass. Not a gear either: the menu
          holds Print, Duplicate and Delete, which are acts, and a gear promises
          settings. */}
      <button type="button"
        title={t('more_actions', { defaultValue: 'Autres actions' })}
        aria-label={t('more_actions', { defaultValue: 'Autres actions' })}
        aria-haspopup="menu"
        onClick={e => { const r = e.currentTarget.getBoundingClientRect(); setPos(p => p ? null : { top: r.bottom + 4, left: r.right - 220 }) }}
        className="grid h-8 w-8 place-items-center rounded-md transition-colors">
        <Menu size={18} />
      </button>
      {pos && (
        <MenuDropdown pos={pos} onClose={() => setPos(null)} items={[
          { type: 'action', label: t('print', { defaultValue: 'Imprimer' }), icon: <Printer size={14} />, onClick: () => window.print() },
          { type: 'action', label: t('delete'), icon: <Trash2 size={14} />, danger: true, onClick: del },
          { type: 'action', label: t('duplicate'), icon: <Copy size={14} />, onClick: duplicate },
        ]} />
      )}
    </>
  )
}

// ── Onglet ────────────────────────────────────────────────────────────────────
// ── Compact color picker ──────────────────────────────────────────────────────
// "Custom" colors added by the user — persisted locally and SHARED with the
// rest of the app (same key as @ui's ColorSwatchPicker, so colors created in
// Documents reappear here, and vice versa).
const CUSTOM_COLORS_KEY = 'kubuno:picker:custom-swatches'
function loadCustomColors(): string[] {
  if (typeof localStorage === 'undefined') return []
  try { const v = JSON.parse(localStorage.getItem(CUSTOM_COLORS_KEY) || '[]'); return Array.isArray(v) ? v.slice(0, 20) : [] }
  catch { return [] }
}

function ColorField({ color, calColor, setColor }: { color: string | null; calColor: string; setColor: (c: string | null) => void }) {
  const { t } = useTranslation('calendar')
  const C = useAppPickerTheme()
  const [open, setOpen] = useState(false)
  const [customOpen, setCustomOpen] = useState(false)   // full ColorPicker screen
  const [draft, setDraft] = useState(color ?? calColor) // color being edited (not applied yet)
  const [custom, setCustom] = useState<string[]>(loadCustomColors)
  const cur = color ?? calColor

  const close = () => { setOpen(false); setCustomOpen(false) }

  const addCustom = (hex: string) => setCustom(prev => {
    const next = [hex, ...prev.filter(c => c.toLowerCase() !== hex.toLowerCase())].slice(0, 20)
    try { localStorage.setItem(CUSTOM_COLORS_KEY, JSON.stringify(next)) } catch { /* quota / SSR */ }
    return next
  })

  const pickEyedropper = async () => {
    const ED = (window as unknown as { EyeDropper?: new () => { open: () => Promise<{ sRGBHex: string }> } }).EyeDropper
    if (!ED) return
    try { const r = await new ED().open(); addCustom(r.sRGBHex); setColor(r.sRGBHex); close() } catch { /* cancelled */ }
  }

  const swatch = (c: string, onClick: () => void, key?: string, active?: boolean) => (
    <button key={key ?? c} type="button" title={c} onClick={onClick}
      style={{ width: 28, height: 28, borderRadius: '9999px', backgroundColor: c, outline: active ? '2px solid #1a73e8' : 'none', outlineOffset: 2 }} />
  )
  const actionBtn = (icon: React.ReactNode, onClick: () => void, title: string) => (
    <button type="button" title={title} onClick={onClick}
      style={{ width: 28, height: 28, borderRadius: '9999px', border: '1px solid #dadce0', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#5f6368' }}>{icon}</button>
  )

  return (
    <div className="relative">
      <button type="button" onClick={() => setOpen(o => !o)}
        className="w-9 h-9 rounded-full border border-border flex items-center justify-center hover:bg-surface-1">
        <span className="w-4 h-4 rounded-full" style={{ backgroundColor: cur }} />
      </button>
      {open && (
        <>
          <div onClick={close} style={{ position: 'fixed', inset: 0, zIndex: 90 }} />
          {customOpen ? (
            // Full ColorPicker: centered with `fixed` so it NEVER overflows the
            // dialog/viewport (otherwise the Add/Cancel footer leaves the screen).
            // No `t`: the picker uses its built-in labels (`layer_*` keys absent
            // from the calendar namespace); only Add/Cancel are translated.
            <div style={{ position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', zIndex: 92 }}>
              <ColorPicker C={C} color={draft}
                onChange={setDraft}
                onClose={() => setCustomOpen(false)}
                confirmLabel={t('color_add', { defaultValue: 'Ajouter' })}
                cancelLabel={t('color_cancel', { defaultValue: 'Annuler' })}
                onConfirm={hex => { addCustom(hex); setColor(hex); close() }}
                onCancel={() => setCustomOpen(false)} />
            </div>
          ) : (
            <div style={{
              position: 'absolute', right: 0, top: '100%', marginTop: 4, zIndex: 91,
              background: '#fff', border: '1px solid #e0e0e0', borderRadius: 12,
              boxShadow: '0 4px 16px rgba(0,0,0,.18)', padding: 8,
              display: 'flex', flexWrap: 'wrap', gap: 6, width: 156,
            }}>
              {/* "Calendar color" swatch (default) */}
              {swatch(calColor, () => { setColor(calColor); close() }, 'cal', cur === calColor)}
              {EVENT_SWATCHES.filter(c => c.toLowerCase() !== calColor.toLowerCase()).map(c =>
                swatch(c, () => { setColor(c); close() }, c, color === c))}
              {/* Saved custom colors (deduplicated against the palette above) */}
              {custom.filter(c => {
                const lc = c.toLowerCase()
                return lc !== calColor.toLowerCase() && !EVENT_SWATCHES.some(s => s.toLowerCase() === lc)
              }).map(c => swatch(c, () => { setColor(c); close() }, 'cust-' + c, color === c))}
              {/* +: opens the full ColorPicker (like in Documents) */}
              <button type="button" title={t('custom_color', { defaultValue: 'Personnalisé' })}
                onClick={() => { setDraft(cur); setCustomOpen(true) }}
                style={{ width: 28, height: 28, borderRadius: '9999px', border: '1px solid #dadce0', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#5f6368' }}>
                <Plus size={14} />
              </button>
              {typeof window !== 'undefined' && 'EyeDropper' in window &&
                actionBtn(<Pipette size={13} />, pickEyedropper, t('eyedropper', { defaultValue: 'Pipette' }))}
            </div>
          )}
        </>
      )}
    </div>
  )
}

// ── Attendees panel (creation) ────────────────────────────────────────────────
// Collects the guest list before the event exists; the addresses ride along in
// the create request (`attendees`) and the server sends the invitations.
/**
 * Choosing a room while composing the invitation.
 *
 * ## Why availability is shown, and why a busy room is still selectable
 *
 * The hour is picked first and the room second, so the list has to answer the
 * question the reader has: is it free *then*? Showing names alone asks them to
 * choose blind and be refused. But a taken room stays SELECTABLE: the meeting is
 * not the room's to cancel — the room answers, and its refusal is a status the
 * organiser reads beside everyone else's, with the meeting that holds it named
 * so they can go and ask.
 *
 * The search matches the composed name, which carries the building, the floor
 * and the equipment — so typing a building narrows to a building.
 */
function RoomPicker({
  from, to, rrule, timezone, eventId, selected, onToggle,
}: {
  from:      string
  to:        string
  rrule?:    string | null
  timezone?: string
  /** The meeting being edited, so it is not counted as holding the room. */
  eventId?:  string
  selected:  string[]
  onToggle:  (id: string) => void
}) {
  const { t } = useTranslation('calendar')
  const [q, setQ] = useState('')

  const { data, isLoading } = useQuery({
    queryKey: ['rooms-availability', from, to, rrule ?? '', eventId ?? ''],
    queryFn:  () => calendarApi.roomAvailability(from, to, { rrule, timezone, eventId }).then(r => r.rooms),
    // Times change as the form is filled; asking again is the point.
    staleTime: 10_000,
    retry: false,
  })

  const rooms = data ?? []
  const shown = q.trim() === ''
    ? rooms
    : rooms.filter(r => r.generated_name.toLowerCase().includes(q.trim().toLowerCase()))

  // An instance with no rooms at all: the control has nothing to offer and says
  // nothing, rather than shouting about an inventory nobody has filled in.
  if (!isLoading && rooms.length === 0) return null

  const when = (iso: string) =>
    new Date(iso).toLocaleString(undefined, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })

  return (
    <div>
      {rooms.length > 4 && (
        <Input
          value={q}
          onChange={e => setQ(e.target.value)}
          placeholder={t('room_search', { defaultValue: 'Rechercher une salle ou un bâtiment…' })}
          className="mb-2 w-full"
        />
      )}
      <ul className="flex flex-col gap-1">
        {shown.map(r => {
          const on = selected.includes(r.id)
          return (
            <li key={r.id}>
              <button
                type="button"
                onClick={() => onToggle(r.id)}
                className={`flex w-full items-start gap-2 rounded-md border px-3 py-2 text-left transition-colors ${
                  on ? 'border-primary bg-primary-light' : 'border-border hover:bg-surface-1'}`}
              >
                <Building2 size={15} className="mt-0.5 shrink-0 text-text-tertiary" />
                <span className="min-w-0 flex-1">
                  {/* Name, then WHERE, then what it holds — read as columns
                      rather than as the one composed string, which packs the
                      building, the floor, the capacity and the equipment into a
                      line nobody scans. The composed name stays the label
                      everywhere a single string is needed. */}
                  <span className="block truncate text-sm text-text-primary">
                    {r.name || r.generated_name}
                    {(r.building?.name || r.building?.key) && (
                      <span className="ml-2 text-xs font-normal text-text-secondary">
                        {r.building?.name || r.building?.key}
                        {r.floor_name ? ` · ${r.floor_name}` : ''}
                        {r.floor_section ? ` ${r.floor_section}` : ''}
                      </span>
                    )}
                  </span>
                  <span className="block text-xs text-text-tertiary">
                    {t('room_capacity', { defaultValue: '{{count}} places', count: r.capacity })}
                    {r.features?.length ? ` · ${r.features.join(' · ')}` : ''}
                  </span>
                  <span className="block text-xs text-text-tertiary">
                    {r.free
                      ? t('room_free', { defaultValue: 'Libre sur ce créneau' })
                      : r.held_by
                        ? t('room_held', {
                            defaultValue: 'Prise par « {{title}} » ({{when}})',
                            title: r.held_by.title,
                            when:  when(r.held_by.starts_at),
                          })
                        : t('room_busy', { defaultValue: 'Déjà prise sur ce créneau' })}
                  </span>
                </span>
                {on && <Check size={15} className="mt-0.5 shrink-0 text-primary" />}
              </button>
            </li>
          )
        })}
      </ul>
      {shown.length === 0 && (
        <p className="text-xs text-text-tertiary">
          {t('room_none_match', { defaultValue: 'Aucune salle ne correspond.' })}
        </p>
      )}
    </div>
  )
}

function CreateGuestsPanel({
  guests,
  onChange,
  perms,
  onPerms,
  from,
  to,
}: {
  guests: { email: string; user_id?: string; display_name?: string; optional?: boolean; avatar_url?: string }[]
  onChange: (g: { email: string; user_id?: string; display_name?: string; optional?: boolean; avatar_url?: string }[]) => void
  perms: GuestPerms
  onPerms: (p: GuestPerms) => void
  /** The hour being proposed — what a clash is measured against. */
  from: Date
  to:   Date
}) {
  const { t } = useTranslation('calendar')
  const [email, setEmail] = useState('')
  const busy = useGuestConflicts(from, to, guests)
  const policy = useInstancePolicy()
  const typed  = email.trim()
  const isOutside = looksLikeAddress(typed)
    && policy.internalDomains.length > 0
    && !isInternalAddress(typed, policy.internalDomains)
  const blocked = isOutside && !policy.allowExternalGuests
  const guestLimitReached = policy.maxEventGuests > 0 && guests.length >= policy.maxEventGuests
  const add = (g?: { email: string; user_id?: string; display_name?: string | null; avatar_url?: string | null }) => {
    const address = (g?.email ?? typed).trim()
    // A guest picked from the directory may have no address here at all: the
    // server resolves the account. Typed in, an address is required.
    if (!looksLikeAddress(address) && !g?.user_id) return
    const key = address.toLowerCase() || `id:${g?.user_id}`
    if (guests.some(x => (x.email.toLowerCase() || `id:${x.user_id}`) === key)) { setEmail(''); return }
    if (guestLimitReached) return
    // The instance's own rule, checked here so the refusal is read where the
    // address was typed. The server checks it again, which is what enforces it.
    if (address && policy.internalDomains.length > 0 && !policy.allowExternalGuests
        && !isInternalAddress(address, policy.internalDomains)) return
    // The face travels with the name: the suggestion already had it, and
    // fetching it again once the guest is on the list would be a request for
    // something we were just handed.
    onChange([...guests, { email: address, user_id: g?.user_id,
      display_name: g?.display_name ?? undefined, avatar_url: g?.avatar_url ?? undefined }])
    setEmail('')
  }
  return (
    <div className="space-y-4">
      {/* No "Invite" button beside the field: a suggestion is taken by
          choosing it and a typed address by pressing Enter, so the button was a
          third way to do what two already did — and it took a quarter of the
          column's width to say so. */}
      <GuestField value={email} onChange={setEmail} onPick={add}
        exclude={guests.map(g => g.email)} />
      {blocked && (
        <p className="text-xs text-danger">
          {t('guests_external_blocked', { defaultValue: 'Les invités extérieurs à l’instance sont désactivés sur cette instance.' })}
        </p>
      )}
      {!blocked && isOutside && policy.warnExternalGuests && (
        <p className="text-xs text-warning">
          {t('guests_external_warning', { defaultValue: 'Cette adresse n’appartient pas à votre organisation : les détails de l’événement lui seront envoyés.' })}
        </p>
      )}
      {guestLimitReached && (
        <p className="text-xs text-danger">
          {t('guests_limit_reached', { defaultValue: 'Nombre maximal de participants atteint ({{max}}).', max: policy.maxEventGuests })}
        </p>
      )}
      {guests.length > 0 && (
        <div className="space-y-1.5">
          {guests.map(g => (
            <GuestRow key={g.email || g.user_id}
              guest={{ email: g.email, user_id: g.user_id, display_name: g.display_name,
                       optional: g.optional, avatar_url: g.avatar_url }}
              conflict={Boolean(g.user_id && busy.has(g.user_id))}
              onToggleOptional={() => onChange(guests.map(x => x.email === g.email ? { ...x, optional: !x.optional } : x))}
              onRemove={() => onChange(guests.filter(x => x.email !== g.email))} />
          ))}
          {guests.some(g => calendarUnknown({ email: g.email, user_id: g.user_id })) && <GuestCalendarNote />}
          <p className="text-xs text-text-tertiary pt-1">
            {t('guests_will_be_invited', { defaultValue: 'Les invitations seront envoyées à l’enregistrement.' })}
          </p>
        </div>
      )}
      <GuestPermissions value={perms} onChange={onPerms} />
    </div>
  )
}

// ── Rooms panel (editing) ─────────────────────────────────────────────────────
// A room is a guest that answers. Picking one puts it on the list and the server
// replies at once: it accepted, or it declined because another meeting already
// holds it — and it says WHICH, because "held by Point hebdo, 14:00" is
// actionable where "unavailable" is not. A busy room never fails the request nor
// cancels the meeting; the refusal is read where every other answer is read.
function RoomsPanel({ eventId }: { eventId: string }) {
  const { t } = useTranslation('calendar')
  const qc = useQueryClient()
  const [picked, setPicked] = useState('')

  const { data: catalogue } = useQuery({
    queryKey: ['rooms-catalogue'],
    queryFn:  () => calendarApi.listRooms().then(r => r.rooms),
    staleTime: 60_000,
    // The organisation may simply have no rooms yet, and an editor that shouts
    // about it on every open would be noise.
    retry: false,
  })
  const { data: attendees } = useQuery({
    queryKey: ['event-attendees', eventId],
    queryFn:  () => calendarApi.listAttendees(eventId).then(r => r.attendees),
  })

  const booked = (attendees ?? []).filter(a => a.resource_id)
  const rooms  = catalogue ?? []
  const free   = rooms.filter(r => !booked.some(b => b.resource_id === r.id))

  const invite = useMutation({
    mutationFn: (id: string) => calendarApi.inviteRoom(eventId, id),
    onSuccess:  () => { setPicked(''); qc.invalidateQueries({ queryKey: ['event-attendees', eventId] }) },
  })
  const release = useMutation({
    mutationFn: (id: string) => calendarApi.removeRoom(eventId, id),
    onSuccess:  () => qc.invalidateQueries({ queryKey: ['event-attendees', eventId] }),
  })

  // Nothing to offer and nothing booked: the section would be a control that
  // cannot do anything. The administrator declares rooms, not the organiser.
  if (rooms.length === 0 && booked.length === 0) return null

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-1.5">
        <Dropdown
          className="w-full"
          value={picked}
          onChange={setPicked}
          options={[
            { value: '', label: t('room_pick', { defaultValue: 'Ajouter une salle' }) },
            ...free.map(r => ({ value: r.id, label: r.generated_name })),
          ]}
        />
        <Button
          type="button" size="sm"
          disabled={!picked}
          loading={invite.isPending}
          onClick={() => invite.mutate(picked)}
        >
          {t('room_add', { defaultValue: 'Réserver' })}
        </Button>
      </div>

      {booked.map(b => {
        const declined = b.status === 'declined'
        return (
          <div key={b.resource_id} className="flex items-start gap-2 text-sm">
            <span className="flex-1 min-w-0">
              <span className="block truncate text-text-primary">{b.display_name}</span>
              {/* Refused and released are both `declined`; only the stamp tells
                  them apart, and the organiser needs to know which happened —
                  one means "pick another room", the other "your meeting emptied
                  out and the room went back". */}
              <span className={declined ? 'text-danger' : 'text-success'}>
                {!declined
                  ? t('room_accepted', { defaultValue: 'A accepté' })
                  : b.released_at
                    ? t('room_released', { defaultValue: 'Libérée : la réunion s’est vidée' })
                    : t('room_declined', { defaultValue: 'A refusé : déjà réservée' })}
              </span>
            </span>
            <button
              type="button"
              onClick={() => release.mutate(b.resource_id!)}
              className="text-text-tertiary hover:text-danger"
              title={t('room_release', { defaultValue: 'Libérer la salle' })}
            >
              <X size={14} />
            </button>
          </div>
        )
      })}

      {/* Why it said no — named, not merely refused. */}
      {invite.data?.status === 'declined' && invite.data.clashes.length > 0 && (
        <p className="text-xs text-danger">
          {t('room_clash', {
            defaultValue: 'Déjà réservée par « {{title}} ».',
            title: invite.data.clashes[0].title,
          })}
        </p>
      )}
      {invite.isError && (
        <p className="text-xs text-danger">
          {invite.error instanceof Error ? invite.error.message : String(invite.error)}
        </p>
      )}
    </div>
  )
}

// ── Attendees panel (editing) ─────────────────────────────────────────────────
function GuestsPanel({ eventId, perms, onPerms, onShowAvailability, from, to }: {
  eventId: string
  from: Date
  to:   Date
  perms: GuestPerms
  onPerms: (p: GuestPerms) => void
  /** Offered on a guest's card: look at when they are free. */
  onShowAvailability?: () => void
}) {
  const { t } = useTranslation('calendar')
  const qc = useQueryClient()
  const [email, setEmail] = useState('')
  const { data } = useQuery({
    queryKey: ['event-attendees', eventId],
    queryFn:  () => calendarApi.listAttendees(eventId).then(r => r.attendees),
  })
  // People only. Rooms are attendees too since they answer like one, but they
  // belong to their own section — listing them here would count a room against
  // the guest ceiling and show it with an empty address.
  const attendees = (data ?? []).filter(a => !a.resource_id)
  const invite = useMutation({
    mutationFn: (g?: { email: string; user_id?: string; display_name?: string | null }) =>
      calendarApi.inviteAttendee(eventId, {
        email: (g?.email ?? email).trim(),
        user_id: g?.user_id,
        display_name: g?.display_name ?? undefined,
      }),
    onSuccess:  () => { setEmail(''); qc.invalidateQueries({ queryKey: ['event-attendees', eventId] }) },
  })
  // Welcome, not required. Its own call: it is the host's statement about a
  // guest, not a fresh invitation, and re-inviting to flip a flag would put
  // another e-mail in that person's inbox for nothing.
  const setOptional = useMutation({
    mutationFn: (v: { id: string; optional: boolean }) => calendarApi.setAttendeeOptional(eventId, v.id, v.optional),
    onSuccess:  () => qc.invalidateQueries({ queryKey: ['event-attendees', eventId] }),
  })
  const remove = useMutation({
    mutationFn: (aid: string) => calendarApi.removeAttendee(eventId, aid),
    onSuccess:  () => qc.invalidateQueries({ queryKey: ['event-attendees', eventId] }),
  })
  const busy = useGuestConflicts(from, to, attendees.map(a => ({ user_id: a.user_id })))
  const policy = useInstancePolicy()
  const typed  = email.trim()
  // An address outside the instance's declared domains. With no domain declared
  // the question has no local answer, and calling every colleague an outsider
  // would be worse than saying nothing — the server still asks the directory
  // and refuses on its own terms. So this only drives what the composer SAYS:
  // a warning, or the reason the button is closed.
  const isOutside = looksLikeAddress(typed)
    && policy.internalDomains.length > 0
    && !isInternalAddress(typed, policy.internalDomains)
  const blocked   = isOutside && !policy.allowExternalGuests
  const guestLimitReached =
    policy.maxEventGuests > 0 && attendees.length >= policy.maxEventGuests
  return (
    <div className="space-y-4">
      {/* Same here — and the field goes quiet while the invitation is on its
          way, which is the feedback the button's spinner used to carry. */}
      <GuestField value={email} onChange={setEmail}
        disabled={invite.isPending}
        onPick={g => invite.mutate(g)}
        exclude={attendees.map(a => a.email ?? '')} />
      {blocked && (
        <p className="text-xs text-danger">
          {t('guests_external_blocked', { defaultValue: 'Les invités extérieurs à l’instance sont désactivés sur cette instance.' })}
        </p>
      )}
      {!blocked && isOutside && policy.warnExternalGuests && (
        <p className="text-xs text-warning">
          {t('guests_external_warning', { defaultValue: 'Cette adresse n’appartient pas à votre organisation : les détails de l’événement lui seront envoyés.' })}
        </p>
      )}
      {guestLimitReached && (
        <p className="text-xs text-danger">
          {t('guests_limit_reached', { defaultValue: 'Nombre maximal de participants atteint ({{max}}).', max: policy.maxEventGuests })}
        </p>
      )}
      {invite.isError && (
        <p className="text-xs text-danger">
          {invite.error instanceof Error ? invite.error.message : String(invite.error)}
        </p>
      )}
      {attendees.length > 0 && (
        <div className="space-y-1.5">
          {/* Response summary: 2 yes · 1 pending… */}
          <p className="text-xs text-text-tertiary">
            {(['accepted', 'tentative', 'declined', 'needs-action'] as const)
              .map(s => [s, attendees.filter(a => (a.status || 'needs-action') === s).length] as const)
              .filter(([, n]) => n > 0)
              .map(([s, n]) => `${n} ${t(`rsvp_count_${s.replace('-', '_')}`, {
                defaultValue: { accepted: 'oui', tentative: 'peut-être', declined: 'non', 'needs-action': 'en attente' }[s],
              })}`)
              .join(' · ')}
          </p>
          {attendees.map(a => {
            const status = a.status || 'needs-action'
            const statusLabel = {
              accepted:       t('rsvp_yes',      { defaultValue: 'A accepté' }),
              declined:       t('rsvp_no',       { defaultValue: 'A refusé' }),
              tentative:      t('rsvp_maybe',    { defaultValue: 'Peut-être' }),
              'needs-action': t('rsvp_pending',  { defaultValue: 'En attente' }),
            }[status] ?? status
            return (
              <GuestRow key={a.id}
                guest={{
                  id: a.id, email: a.email, user_id: a.user_id,
                  display_name: a.display_name, is_organizer: a.is_organizer,
                  optional: a.optional,
                  subtitle: a.is_organizer ? t('organizer', { defaultValue: 'Organisateur' }) : statusLabel,
                }}
                /* Neither is offered on the organiser's own line: they cannot be
                   uninvited, and "welcome, not required" is not a thing one says
                   about the person holding the meeting. */
                onToggleOptional={a.is_organizer ? undefined : () => setOptional.mutate({ id: a.id, optional: !a.optional })}
                onRemove={a.is_organizer ? undefined : () => remove.mutate(a.id)}
                conflict={Boolean(a.user_id && !a.is_organizer && busy.has(a.user_id))}
                onShowAvailability={onShowAvailability} />
            )
          })}
          {attendees.some(a => calendarUnknown({ user_id: a.user_id, is_organizer: a.is_organizer })) && <GuestCalendarNote />}
        </div>
      )}
      {/* Was three checkboxes wired to a local state nobody read: they looked
          like settings and changed nothing. They are the event's own fields
          now, saved with it and enforced by the server. */}
      <GuestPermissions value={perms} onChange={onPerms} />
    </div>
  )
}

// ── "Find a time" tab ─────────────────────────────────────────────────────────
// ── Event editor (create + edit) ──────────────────────────────────────────────
// Responsive control in JS (`useIsMobile` from @ui): a MODULE's `sm:`/`lg:`
// variants that cancel a base class (px-4, flex-col, w-full…) are overridden by
// the host's base utility (utilities layer > kubuno-module). Hence matchMedia.

function EventEditor({ mode, event, initialDate, initialEnd, initialDraft, calendars, onClose }: {
  mode: 'create' | 'edit'; event?: EventInstance; initialDate?: Date | null; initialEnd?: Date | null
  initialDraft?: QuickHandover | null; calendars: Calendar[]; onClose: () => void
}) {
  const { t } = useTranslation('calendar')
  const isMobile = useIsMobile()
  // The window's own side margin. Everything laid out directly on the canvas —
  // the date row, the alert, the two regions — starts here, so there is one
  // number to change rather than a margin per row.
  const PX = isMobile ? 'px-4' : 'px-6'
  const qc = useQueryClient()
  const ev = event

  // The window itself — dragging, resizing, the band, the ✕, Escape, the phone's
  // full screen — is the shared `FloatingWindow`. This screen used to carry a
  // hand-made copy of all of it; a card that imitates a window ends up being the
  // one window in the product that behaves differently.

  // The `<input type="time">` value is always HH:mm regardless of the 12 h/24 h
  // display preference — the browser renders it in the user's locale.
  const parseTime = (iso: string) => formatDate(toDate(iso), 'time')
  const parseDate = (iso: string) => toISODate(toDate(iso))

  const settings = useCalendarSettings()

  /** End of a new event: default duration, shortened by the "speedy meetings"
   *  preference (‑5 min up to 30 min, ‑10 min beyond). */
  const defaultEndOf = (start: Date): Date => {
    let minutes = settings.defaultDurationMin
    if (settings.speedyMeetings) minutes -= minutes <= 30 ? 5 : 10
    return new Date(start.getTime() + Math.max(5, minutes) * 60_000)
  }

  const [tab,        setTab]        = useState<'details' | 'schedule'>('details')
  const [title,      setTitle]      = useState(ev?.title ?? initialDraft?.title ?? '')
  const [calId,      setCalId]      = useState(ev?.calendar_id ?? '')
  // A preselected range (dragging on the grid) prefills the times.
  const initialHasTime = !!initialDate && (initialDate.getHours() !== 0 || initialDate.getMinutes() !== 0 || !!initialEnd)
  const [date,       setDate]       = useState(ev ? parseDate(ev.starts_at) : toISODate(initialDate ?? new Date()))
  const [endDate,    setEndDate]    = useState(ev ? parseDate(ev.ends_at) : toISODate(initialEnd ?? initialDate ?? new Date()))
  const [startTime,  setStartTime]  = useState(ev ? parseTime(ev.starts_at) : initialHasTime ? formatDate(initialDate!, 'time') : '09:00')
  const [endTime,    setEndTime]    = useState(() => {
    if (ev) return parseTime(ev.ends_at)
    // A dragged range wins over the default duration — the user drew it.
    if (initialEnd) return formatDate(initialEnd, 'time')
    if (initialHasTime) return formatDate(defaultEndOf(initialDate!), 'time')
    const nine = new Date(); nine.setHours(9, 0, 0, 0)
    return formatDate(defaultEndOf(nine), 'time')
  })
  const [allDay,     setAllDay]     = useState(ev?.all_day ?? initialDraft?.allDay ?? false)

  // ── The two dates move together ──────────────────────────────────────────
  // Moving the start moves the end with it, so the event keeps its length.
  // Without this, pushing a one-day event two weeks forward leaves its end
  // where it was: an event that finishes before it begins, which the database
  // refuses and which nothing on screen explains.
  const moveStartDate = useCallback((v: string) => {
    if (!v) return
    setEndDate(prev => {
      if (!prev) return prev
      const day = 86_400_000
      const span = Math.round((new Date(`${prev}T00:00:00`).getTime() - new Date(`${date}T00:00:00`).getTime()) / day)
      // A span read as negative means the two dates were already crossed;
      // clamping it to zero repairs the event instead of carrying the fault
      // forward.
      return toISODate(new Date(new Date(`${v}T00:00:00`).getTime() + Math.max(0, span) * day))
    })
    setDate(v)
  }, [date])

  // And the end is never dragged behind the start: it stops on the first day
  // rather than producing a range that cannot be saved.
  const moveEndDate = useCallback((v: string) => setEndDate(v && v < date ? date : v), [date])
  // The meeting link and the place are two things. Events saved before the
  // link had a field of its own carried it in the place; they are read back
  // into the right field here and written back there on save.
  const legacyLink = ev && !ev.url && ev.location ? ev.location.match(MEETING_LINK_RE)?.[0] ?? null : null
  const [location,   setLocation]   = useState(legacyLink ? '' : (ev?.location ?? initialDraft?.location ?? ''))
  const [url,        setUrl]        = useState(ev?.url ?? legacyLink ?? initialDraft?.url ?? '')
  // Guests collected before the event exists (creation only). On an existing
  // event guests are managed live through GuestsPanel.
  const [pendingGuests, setPendingGuests] = useState<{ email: string; display_name?: string }[]>(
    () => (initialDraft?.guests ?? []),
  )
  // Rooms chosen before the meeting exists. They are invited right after it is
  // created — a room answers against the meeting's own times, so there is
  // nothing to ask until those times are saved.
  const [pendingRooms, setPendingRooms] = useState<string[]>([])

  // Which of the two lists is showing, and whether the second one has anything
  // to show at all: the catalogue belongs to the organisation, and an instance
  // that has declared no room must not be offered a tab leading nowhere.
  const [sideTab, setSideTab] = useState<'guests' | 'rooms'>('guests')
  const { data: roomCatalogue } = useQuery({
    queryKey: ['rooms-catalogue'],
    queryFn:  () => calendarApi.listRooms().then(r => r.rooms),
    staleTime: 5 * 60_000,
    retry: false,
  })
  const hasRooms = (roomCatalogue?.length ?? 0) > 0
  const [desc,       setDesc]       = useState(ev?.description ?? initialDraft?.description ?? '')
  // Whoever hosts meetings on this instance may replace the link field with
  // something that knows how to create a room. `loadedVersion` is in the
  // dependencies on purpose: the module list arrives BEFORE the bundles that
  // register anything, so a lookup keyed on the list alone would settle on
  // "nobody" a beat too early and never look again.
  const { activeModules, loadedVersion } = useModulesStore()
  const VideoMeeting = useMemo(
    () => SlotRegistry.getActiveOverride<VideoMeetingFieldProps>(
      VIDEO_MEETING_FIELD,
      new Set(activeModules.map(m => m.module_id)),
    ),
    [activeModules, loadedVersion],
  )
  // What the meeting provider is holding for this form, while the form is
  // still a draft. A ref rather than state: it changes nothing on screen, and
  // it must be readable at the exact moment the window closes.
  const meetingDraft = useRef<VideoMeetingDraft | null>(null)
  const onMeetingDraft = useCallback((d: VideoMeetingDraft | null) => { meetingDraft.current = d }, [])
  // Leaving without saving. Anything created for this draft — a room made so
  // that its link could be typed into the event — goes with the draft: it was
  // only ever there for an event that now does not exist. Every way out of the
  // window comes through here; the one that does not is a successful save.
  const closeAbandoningDraft = useCallback(() => {
    meetingDraft.current?.discard()
    meetingDraft.current = null
    onClose()
  }, [onClose])
  const [reminders,  setReminders]  = useState<EventReminder[]>(() => {
    if (ev?.reminders) return ev.reminders
    return settings.defaultReminderMin > 0
      ? [{ type: 'notification', minutes_before: settings.defaultReminderMin }]
      : []
  })
  const [color,      setColor]      = useState<string | null>(ev?.color ?? null)
  const [recur,      setRecur]      = useState(mode === 'edit' ? presetFromRrule(ev?.rrule) : 'none')
  // Full RRULE when the recurrence is "custom" (dedicated editor).
  const [customRrule, setCustomRrule] = useState<string | null>(ev?.rrule ?? null)
  const [busy,       setBusy]       = useState(ev?.busy ?? true)
  const [visibility, setVisibility] = useState(ev?.visibility || 'default')
  // The instance's labels: read from the core for an event that exists, held
  // here for one that does not — and taken over from the quick card when the
  // form was opened through "Other options".
  const labelOptions = useLabelOptions()
  const eventLabels  = useEventLabels(ev)
  const [labelIds, setLabelIds] = useState<string[]>(initialDraft?.labelIds ?? [])
  const labelsLoaded = useRef(false)
  useEffect(() => {
    if (!labelsLoaded.current && eventLabels.data) { labelsLoaded.current = true; setLabelIds(eventLabels.data) }
  }, [eventLabels.data])
  // What the guests may do. Read from the event when there is one, so opening
  // an existing meeting shows what was decided rather than the defaults.
  const [perms, setPerms] = useState<GuestPerms>(() => ev
    ? { guests_can_modify:     ev.guests_can_modify ?? false,
        guests_can_invite:     ev.guests_can_invite ?? true,
        guests_can_see_guests: ev.guests_can_see_guests ?? true }
    : DEFAULT_GUEST_PERMS)
  // Editing a series: ask for the scope (this event / following / all).
  const [askScope,   setAskScope]   = useState(false)

  // Possible targets = calendars writable by the user (never a read-only shared
  // calendar nor a subscription — the API would answer "Access denied").
  // When editing, the event's current calendar stays listed even when locked,
  // so the field is never empty.
  const targetCals = useMemo(() => {
    const writable = writableCalendars(calendars)
    const current = calId ? calendars.find(c => c.id === calId) : undefined
    return current && !writable.some(c => c.id === current.id) ? [current, ...writable] : writable
  }, [calendars, calId])

  useEffect(() => {
    if (calId) return
    const writable = writableCalendars(calendars)
    if (writable.length > 0) setCalId((writable.find(c => c.is_default) ?? writable[0]).id)
  }, [calendars, calId])

  // Was the recurrence modified? (⇒ "this event only" would make no sense)
  const recurChanged = mode === 'edit' && recur !== presetFromRrule(ev?.rrule)
    || (recur === 'custom' && customRrule !== (ev?.rrule ?? null))

  /**
   * The slot as the form currently states it.
   *
   * The same arithmetic the save uses, lifted out of the mutation because the
   * room list is drawn against it: asking "which rooms are free" needs the hour
   * the reader is looking at, not the one they will eventually save.
   */
  const slot = useMemo(() => {
    if (allDay) {
      return { from: `${date}T00:00:00.000Z`, to: `${endDate || date}T23:59:59.000Z` }
    }
    const ed = endDate || (endTime < startTime ? toISODate(addDays(new Date(`${date}T00:00:00`), 1)) : date)
    return {
      from: new Date(`${date}T${startTime}:00`).toISOString(),
      to:   new Date(`${ed}T${endTime}:00`).toISOString(),
    }
  }, [allDay, date, endDate, startTime, endTime])

  const slotRrule = useMemo(
    () => (recur === 'custom' ? customRrule : buildRrule(recur, new Date(`${date}T${allDay ? '00:00' : startTime}:00`))) ?? null,
    [recur, customRrule, date, allDay, startTime],
  )

  const { mutate, isPending, error } = useMutation<unknown, Error, string | undefined>({
    mutationFn: async (scope?: string) => {
      let startsAt: string, endsAt: string
      if (allDay) {
        startsAt = `${date}T00:00:00.000Z`
        endsAt   = `${endDate || date}T23:59:59.000Z`
      } else {
        startsAt = new Date(`${date}T${startTime}:00`).toISOString()
        // An end time before the start time on the SAME day means the evening
        // ran past midnight — 22:00–01:00 is a three-hour event, not a negative
        // one. A later end DATE was chosen deliberately and is left alone.
        const ed = (endDate || date) === date && endTime < startTime
          ? toISODate(addDays(new Date(`${date}T00:00:00`), 1))
          : (endDate || date)
        endsAt   = new Date(`${ed}T${endTime}:00`).toISOString()
      }
      const calColor = calendars.find(c => c.id === calId)?.color
      const tz       = calendars.find(c => c.id === calId)?.timezone
      const start    = new Date(`${date}T${allDay ? '00:00' : startTime}:00`)
      // Effective RRULE per the choice: preset, custom, or none.
      const effectiveRrule = recur === 'custom' ? (customRrule ?? undefined) : buildRrule(recur, start) ?? undefined
      // The call's room was created before this event existed — a link has to
      // point somewhere to be saved. Saving is what makes it real, so it is
      // confirmed HERE, before the write: the one order that cannot leave a
      // saved event pointing at a room still counting down to its own removal.
      await meetingDraft.current?.commit()
      meetingDraft.current = null

      const text = (v: string) => (mode === 'create' ? v.trim() || undefined : v.trim())
      const base = {
        calendar_id: calId, title: title.trim(),
        description: text(desc), location: text(location), url: text(url),
        starts_at: startsAt, ends_at: endsAt, all_day: allDay,
        reminders: reminders.length ? reminders : undefined,
        // "Default visibility" (UI) = the backend's default visibility = 'public'.
        // Le backend n'accepte que public/private/confidential (contrainte CHECK).
        busy, visibility: visibility === 'default' ? 'public' : visibility, timezone: tz,
        ...perms,
      }
      if (mode === 'create') {
        const created = await calendarApi.createEvent({ ...base,
          rrule: effectiveRrule,
          ...(color && color !== calColor ? { color } : {}),
          ...(pendingGuests.length ? { attendees: pendingGuests } : {}),
        })
        // Sequentially, and never fatally: a room that answers "no" is an
        // answer, not a failed save. The meeting exists either way, and the
        // refusal is read in the guest list like anyone else's.
        for (const id of pendingRooms) {
          try { await calendarApi.inviteRoom(created.event.event_id, id) } catch { /* la salle répondra */ }
        }
        // Labels last, for the same reason as the room: a link needs something
        // to point at, and until now there was nothing. Never fatally — the
        // event is created either way.
        if (labelIds.length) {
          try { await saveEventLabels(created.event, labelIds) } catch { /* l'évènement est créé */ }
        }
        return created
      }
      return calendarApi.updateEvent(ev!.event_id, { ...base,
        // "Does not repeat" on a recurring event = explicit removal of the
        // rule (an absent rrule means "unchanged" backend-side).
        ...(recur === 'none' && ev?.rrule ? { clear_rrule: true }
          : effectiveRrule && effectiveRrule !== ev?.rrule ? { rrule: effectiveRrule } : {}),
        ...(color && color !== calColor ? { color } : { clear_color: true }),
        ...(scope ? { scope, ...(scope !== 'all' ? { occurrence: ev!.starts_at } : {}) } : {}),
      })
    },
    onSuccess: async () => {
      // On an existing event the labels are written here, after the event
      // itself: they live in the core, so they are a second write that must not
      // be able to undo the first.
      if (mode === 'edit' && ev) {
        try { await saveEventLabels(ev, labelIds) } catch { /* l'évènement, lui, est enregistré */ }
      }
      qc.invalidateQueries({ queryKey: ['calendar-events'] })
      qc.invalidateQueries({ queryKey: ['event-labels'] })
      onClose()
    },
  })

  // Save: on an existing series, ask for the scope first.
  const save = () => {
    if (mode === 'edit' && ev?.is_recurring) setAskScope(true)
    else mutate(undefined)
  }

  const canSave  = title.trim().length > 0 && calId !== '' && !isPending
  const calColor = calendars.find(c => c.id === calId)?.color ?? '#1a73e8'
  // Not a hook: this line sits past the component's early returns, and a hook
  // added here would be the conditional one that breaks the render on a resize.
  const tzName   = calendars.find(c => c.id === calId)?.timezone ?? userTimezone()

  const row = (icon: React.ReactNode, children: React.ReactNode) => (
    <div className="flex items-start gap-4">
      <div className="w-5 shrink-0 text-text-tertiary mt-2 flex justify-center">{icon}</div>
      <div className="flex-1 min-w-0">{children}</div>
    </div>
  )

  return (
    <FloatingWindow
      t={t}
      onClose={closeAbandoningDraft}
      backdrop
      resizable
      defaultWidth={1024}
      minWidth={360}
      /* This window is a form: its canvas is tinted so the white fields read as
         fields and not as the sheet they sit on. */
      className="kb-window-form-canvas"
      /* The band NAMES the window; it does not host the form. The title is
         edited at the top of the form itself, and the band says what is being
         written so a window buried under others is still identifiable. An event
         with no title yet says so rather than showing a blank band. */
      title={title.trim() || (mode === 'edit'
        ? t('event_edit_title', { defaultValue: 'Modifier l’événement' })
        : t('event_new_title',  { defaultValue: 'Nouvel événement' }))}
      titleActions={mode === 'edit' && ev
        ? <EditEventActionsMenu event={ev} calendars={calendars} onClose={closeAbandoningDraft} />
        : undefined}
      /* The window's own footer draws the pair: the action on the left of the
         cancel, both at the bottom right, in the order and at the widths every
         other window of the product uses. Nothing here decides that. */
      actions={{
        confirm: {
          label:   t('save', { defaultValue: 'Enregistrer' }),
          onClick: () => { if (canSave) save() },
          disabled: !canSave,
          loading:  isPending,
        },
        // No second button: the window already carries a ✕ and answers Escape,
        // and a footer that repeats them would put the one action this window
        // exists for anywhere but the corner the eye goes to.
        cancel: false,
      }}
    >
      <div className="flex flex-col">
        {/* ⚠️ L'alerte devrait être HORS du défilement, sous le bandeau : c'est
            la prop `banner` de `FloatingWindow`, ajoutée au core mais pas encore
            dans les types publiés de `@kubuno/ui`. En attendant, elle est au
            MOINS en tête du contenu — au premier endroit que l'œil lit — et non
            plus tout en bas où il fallait défiler pour la trouver. À basculer
            sur `banner` à la prochaine publication de la bibliothèque. */}
        {(error || targetCals.length === 0) && (
          <div className={`${PX} pt-4`}>
            {error && (
              <Callout variant="danger" t={t}>
                {/* A raw "Access denied" explains nothing: spell out the most common case. */}
                {/(403|refusé|forbidden)/i.test(error.message)
                  ? t('event_forbidden_hint', { defaultValue: 'Accès refusé : vous n’avez pas le droit d’écrire dans cet agenda. Choisissez un agenda dont vous êtes propriétaire ou partagé en modification.' })
                  : error.message}
              </Callout>
            )}
            {targetCals.length === 0 && (
              <Callout variant="warning" t={t} className={error ? 'mt-2' : ''}>
                {t('no_writable_calendar', { defaultValue: 'Aucun agenda modifiable : créez un agenda ou demandez un partage en modification.' })}
              </Callout>
            )}
          </div>
        )}

        {/* Scope of the modification of a recurring event */}
        {askScope && (
          <div className="fixed inset-0 z-[90] flex items-center justify-center" onClick={() => setAskScope(false)}>
            <div className="absolute inset-0 bg-black/30" />
            <div className="relative bg-surface-0 rounded-2xl shadow-xl w-full max-w-sm p-5" onClick={e => e.stopPropagation()}>
              <h3 className="text-sm font-semibold text-text-primary mb-1">
                {t('edit_recurring_title', { defaultValue: 'Modifier l’événement récurrent' })}
              </h3>
              <p className="text-xs text-text-secondary mb-4">
                {recurChanged
                  ? t('edit_recurring_desc_rrule', { defaultValue: 'La récurrence a été modifiée : le changement s’applique à la série.' })
                  : t('edit_recurring_desc', { defaultValue: 'Quels événements de la série modifier ?' })}
              </p>
              <div className="flex flex-col gap-2">
                {!recurChanged && (
                  <button onClick={() => { setAskScope(false); mutate('this') }}
                    className="w-full text-sm px-3 py-2 rounded-lg border border-border hover:bg-surface-1 text-left">
                    {t('move_this_only', { defaultValue: 'Cet événement seulement' })}
                  </button>
                )}
                <button onClick={() => { setAskScope(false); mutate('following') }}
                  className="w-full text-sm px-3 py-2 rounded-lg border border-border hover:bg-surface-1 text-left">
                  {t('move_this_following', { defaultValue: 'Celui-ci et les suivants' })}
                </button>
                <button onClick={() => { setAskScope(false); mutate('all') }}
                  className="w-full text-sm px-3 py-2 rounded-lg bg-primary text-white hover:bg-primary-hover text-left">
                  {t('edit_all_events', { defaultValue: 'Tous les événements' })}
                </button>
                <button onClick={() => setAskScope(false)} className="w-full text-sm px-3 py-1.5 text-text-secondary">
                  {t('cancel')}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* The event's name, at the head of the form it names.
            ⚠️ Dernier champ brut de cet écran, et c'est une dette DATÉE, pas un
            oubli : une ligne de titre n'est pas un champ de formulaire et ne
            doit pas en porter le cadre. La variante existe désormais dans la
            primitive (`<Input bare>`), mais ce module compile contre les TYPES
            PUBLIÉS de `@kubuno/ui` — elle devient utilisable ici à la prochaine
            publication de la bibliothèque. À remplacer alors. */}
        <div className={`${PX} pt-5 pb-2 flex items-center gap-2`}>
          <input autoFocus value={title} onChange={e => setTitle(e.target.value)}
            placeholder={t('event_title')} maxLength={500}
            className="kb-form-title-field" />
          {/* The call hosted here carries this name too. Shown beside the title
              rather than beside the call: it is the title that is about to be
              typed, and the consequence belongs where the action is. */}
          {MEETING_LINK_RE.test(url.trim()) && (
            <span className="shrink-0 text-text-tertiary"
              aria-label={t('title_linked', { defaultValue: 'Titre lié' })}
              title={t('title_linked_hint', { defaultValue: 'La visioconférence porte le même nom : le changer ici le change aussi là-bas.' })}>
              <Link2 size={15} />
            </span>
          )}
        </div>

        {/* Date / heure / fuseau */}
        <div className={`${PX} pb-2 flex flex-wrap items-center gap-2`}>
          <div className="w-40"><DatePicker mode="date" value={date} onChange={v => moveStartDate(v ?? '')} /></div>
          {!allDay && <>
            <DatePicker mode="time" value={startTime} onChange={v => setStartTime(v ?? '')} />
            <span className="text-text-tertiary">–</span>
            <DatePicker mode="time" value={endTime} onChange={v => setEndTime(v ?? '')} />
          </>}
          <div className="w-40"><DatePicker mode="date" value={endDate} onChange={v => moveEndDate(v ?? '')} /></div>
          <span className="text-text-tertiary text-xs ml-1">{tzName}</span>
        </div>
        <div className={`${PX} pb-2 flex items-center gap-4`}>
          <Checkbox label={t('all_day')} checked={allDay} onChange={setAllDay} />
          <div className="w-72">
            <RecurrenceField
              preset={recur}
              customRrule={recur === 'custom' ? customRrule : null}
              onChange={setRecur}
              onCustomRrule={(r) => { setCustomRrule(r); setRecur('custom') }}
              start={new Date(`${date}T${allDay ? '00:00' : startTime}:00`)}
            />
          </div>
        </div>

        {/* TWO regions of equal rank, side by side: on the left what the event
            IS — its details, or the search for an hour — and on the right who
            comes to it.

            The guest list used to sit INSIDE the details panel. Two things were
            wrong with that: it vanished the moment you went looking for an hour,
            which is exactly when you want to see who you are trying to gather;
            and the tab rule ran on under a column those tabs do not command.
            Out here it stays put whichever tab is open, and each strip rules
            only its own region.

            The left region is a card on the canvas — the tabs and their content
            are one object — while the guests stand on the canvas itself. */}
        <div className={`${PX} pb-6 flex ${isMobile ? 'flex-col gap-6' : 'flex-row gap-12 items-start'}`}>
          <div className="min-w-0 flex-1 rounded-xl kb-form-card">
            {/* Onglets — la primitive, pas une imitation : elle porte la sémantique
                (tablist/tab, flèches), le débordement et le repère d'onglet actif.
                Le conteneur cale le FILET sur le bord gauche des champs (24 px de
                marge de carte + la colonne d'icône de 36 px) : c'est cette ligne
                que l'œil prend pour le bord de la région. Le libellé se pose
                naturellement 16 px à l'intérieur, marge interne de la primitive. */}
            <div className={isMobile ? '' : 'pl-15 pr-6'}>
              <Tabs
                t={t}
                value={tab}
                onChange={v => setTab(v as 'details' | 'schedule')}
                tabs={[
                  { id: 'details',  label: t('tab_details',  { defaultValue: "Détails de l'événement" }) },
                  { id: 'schedule', label: t('tab_schedule', { defaultValue: 'Rechercher un horaire' }) },
                ]}
              />
            </div>

            {/* Corps.
                One rhythm for the whole form: 8 px between rows, and the same
                8 px inside a row that stacks something under its field. Gaps of
                20, 6 and 4 px read as though some fields belong together and
                others do not, which is not what is meant here. */}
            {tab === 'details' ? (
              <div className={`${isMobile ? 'px-4' : 'px-6'} py-6 space-y-2`}>
              {row(<MapPin size={18} />, <Input placeholder={t('add_location', { defaultValue: 'Ajouter un lieu' })} value={location} onChange={e => setLocation(e.target.value)} className="w-full" />)}
              {/* The video meeting is a LINK, typed or pasted like any other —
                  a call hosted anywhere is a call. When a module of this
                  instance hosts meetings, it offers to write the link for you;
                  it never replaces the field. */}
              {row(VideoMeeting ? <VideoMeeting part="icon" url={url} title={title} onChange={setUrl} /> : <Video size={18} />, VideoMeeting ? (
                <VideoMeeting url={url} title={title} onChange={setUrl} onDraft={onMeetingDraft} />
              ) : (
                /* Nobody hosts meetings here: a link typed or pasted is still a
                   call. One mechanism — the extension point above — and this
                   field when it is unclaimed; a second, private way to make a
                   room is how the quick card and this form drifted apart. */
                <Input type="url" inputMode="url" autoComplete="off" spellCheck={false}
                  placeholder={t('add_video_link', { defaultValue: 'Ajouter un lien de visioconférence' })}
                  value={url} onChange={e => setUrl(e.target.value)} className="w-full" />
              ))}
              {row(<Bell size={18} />, <RemindersSection reminders={reminders} onChange={setReminders} />)}
              {row(<CalendarIcon size={18} />, (
                <div className="flex items-center gap-2">
                  <Dropdown className="flex-1" value={calId} onChange={setCalId} options={targetCals.map(c => ({ value: c.id, label: c.name }))} />
                  <ColorField color={color} calColor={calColor} setColor={setColor} />
                </div>
              ))}
              {row(<Briefcase size={18} />, (
                <div className="flex gap-2 min-w-0">
                  <Dropdown className="flex-1" value={busy ? 'busy' : 'free'} onChange={v => setBusy(v === 'busy')}
                    options={[{ value: 'busy', label: t('busy_busy', { defaultValue: 'Occupé' }) }, { value: 'free', label: t('busy_free', { defaultValue: 'Disponible' }) }]} />
                  <Dropdown className="flex-1" value={visibility || 'default'} onChange={setVisibility}
                    options={[
                      { value: 'default', label: t('vis_default', { defaultValue: 'Visibilité par défaut' }) },
                      { value: 'public',  label: t('vis_public', { defaultValue: 'Public' }) },
                      { value: 'private', label: t('vis_private', { defaultValue: 'Privé' }) },
                    ]} />
                </div>
              ))}
              {/* `@` names a person here, from whatever this instance can
                  suggest — the shared mention point, so nothing names a module
                  and an instance with no provider simply sees nothing happen.
                  Enabled on the DESCRIPTION and nowhere else in this form: in
                  the guest field `@` is part of an address, and a title is a
                  title. Context decides, not a global switch. */}
              {row(<Tag size={18} />, (
                <LabelField
                  options={(labelOptions.data ?? []).map(l => ({ id: l.id, name: l.name, color: l.color }))}
                  value={labelIds} onChange={setLabelIds}
                  placeholder={t('add_labels', { defaultValue: 'Ajouter des étiquettes' })}
                  emptyHint={t('labels_none_yet', { defaultValue: 'Aucune étiquette. Créez-en depuis la page Étiquettes.' })}
                  searchPlaceholder={t('search', { defaultValue: 'Rechercher' })} />
              ))}
              {row(<AlignLeft size={18} />, <RichText value={desc} onChange={setDesc}
                mentions={{ enabled: true }}
                placeholder={t('add_description', { defaultValue: 'Ajouter une description' })} minHeight={140} className="w-full" />)}
              </div>
            ) : (
              <ScheduleGrid
                start={new Date(slot.from)}
                end={new Date(slot.to)}
                calendars={calendars}
                eventId={mode === 'edit' ? ev?.event_id : undefined}
                onPick={(s, e) => {
                  setDate(toISODate(s))
                  setEndDate(toISODate(e))
                  setStartTime(formatDate(s, 'time'))
                  setEndTime(formatDate(e, 'time'))
                  setAllDay(false)
                }}
              />
            )}
          </div>

          {/* Who comes, and where they sit — two lists of the same rank, so two
              tabs rather than one stacked under the other. The rooms tab is
              absent when the organisation has no room to offer: an empty tab is
              a promise the instance cannot keep. The strip lines up with the
              other one, and its rule with the field under it. */}
          <div className={`${isMobile ? 'w-full' : 'w-[320px]'} shrink-0`}>
            <div>
              <Tabs
                t={t}
                value={sideTab}
                onChange={v => setSideTab(v as 'guests' | 'rooms')}
                tabs={[
                  { id: 'guests', label: t('guests', { defaultValue: 'Invités' }) },
                  ...(hasRooms ? [{ id: 'rooms', label: t('rooms', { defaultValue: 'Salles' }) }] : []),
                ]}
              />
            </div>
            {/* The same inset the card gives its first field, so the two regions
                start their content on one line rather than two. */}
            <div className="pt-6">
              {sideTab === 'guests' ? (
                mode === 'edit' && ev
                  ? <GuestsPanel eventId={ev.event_id} perms={perms} onPerms={setPerms}
                      from={new Date(slot.from)} to={new Date(slot.to)}
                      onShowAvailability={() => setTab('schedule')} />
                  : <CreateGuestsPanel guests={pendingGuests} onChange={setPendingGuests}
                      perms={perms} onPerms={setPerms} from={new Date(slot.from)} to={new Date(slot.to)} />
              ) : mode === 'edit' && ev ? (
                <RoomsPanel eventId={ev.event_id} />
              ) : (
                <RoomPicker
                  from={slot.from}
                  to={slot.to}
                  rrule={slotRrule}
                  timezone={calendars.find(c => c.id === calId)?.timezone}
                  selected={pendingRooms}
                  onToggle={id => setPendingRooms(p => p.includes(id) ? p.filter(x => x !== id) : [...p, id])}
                />
              )}
            </div>
          </div>
        </div>

      </div>
    </FloatingWindow>
  )
}

export function CreateEventModal({ initialDate, initialEnd, initialDraft, calendars, onClose }: CreateModalProps) {
  return <EventEditor mode="create" initialDate={initialDate} initialEnd={initialEnd}
                      initialDraft={initialDraft} calendars={calendars} onClose={onClose} />
}

export function EditEventModal({ event, calendars, onClose }: EditModalProps) {
  return <EventEditor mode="edit" event={event} calendars={calendars} onClose={onClose} />
}

// ── Event detail ──────────────────────────────────────────────────────────────

