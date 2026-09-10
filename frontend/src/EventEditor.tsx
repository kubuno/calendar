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
  MoreVertical, Printer, Link2, Lock, Globe,
  Repeat, Users, Briefcase, ChevronDown, Pipette, Video, Tag,
  LayoutGrid, Home, Building, Building2,
} from 'lucide-react'
import { useAuthStore, toISODate, toDate, formatDate, addDays, ExtensionRegistry, ModuleServiceRegistry, CALENDAR_OVERLAY, type CalendarOverlayItem, type CalendarOverlayProvider } from '@kubuno/sdk'
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
import { EVENT_SWATCHES, getMeetingProvider, MEETING_LINK_RE, REMINDER_OPTIONS, writableCalendars } from './calendarUtils'

// ── Reminders section (shared between create and edit) ────────────────────────

function RemindersSection({
  reminders,
  onChange,
}: {
  reminders: EventReminder[]
  onChange: (r: EventReminder[]) => void
}) {
  const { t } = useTranslation('calendar')
  const addReminder = () =>
    onChange([...reminders, { type: 'popup', minutes_before: 15 }])

  const removeReminder = (idx: number) =>
    onChange(reminders.filter((_, i) => i !== idx))

  const updateMinutes = (idx: number, minutes_before: number) =>
    onChange(reminders.map((r, i) => i === idx ? { ...r, minutes_before } : r))

  const updateType = (idx: number, type: string) =>
    onChange(reminders.map((r, i) => i === idx ? { ...r, type } : r))

  const TYPE_OPTS = [
    { value: 'popup', label: t('rem_type_notification', { defaultValue: 'Notification' }) },
    { value: 'email', label: t('rem_type_email', { defaultValue: 'E-mail' }) },
  ]

  return (
    <div className="flex items-start gap-3">
      <Bell size={18} className="shrink-0 text-text-tertiary mt-1.5" />
      <div className="flex-1 space-y-1.5">
        {reminders.map((r, idx) => (
          <div key={idx} className="flex items-center gap-1.5">
            <Dropdown
              className="w-32"
              value={r.type === 'email' ? 'email' : 'popup'}
              onChange={v => updateType(idx, v)}
              options={TYPE_OPTS}
            />
            <Dropdown
              className="flex-1"
              value={String(r.minutes_before)}
              onChange={v => updateMinutes(idx, Number(v))}
              options={REMINDER_OPTIONS.map(opt => ({ value: String(opt.value), label: t('reminder_before', { time: t(opt.labelKey) }) }))}
            />
            <button
              type="button"
              onClick={() => removeReminder(idx)}
              className="p-1 text-text-tertiary hover:text-danger transition-colors"
              aria-label={t('del_reminder')}
            >
              <X size={14} />
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={addReminder}
          className="flex items-center gap-1 text-xs text-primary hover:text-primary-hover
                     transition-colors py-1"
        >
          <Plus size={12} />
          {t('add_reminder')}
        </button>
      </div>
    </div>
  )
}

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
  calendars: Calendar[]
  onClose: () => void
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
      <button type="button"
        onClick={e => { const r = e.currentTarget.getBoundingClientRect(); setPos(p => p ? null : { top: r.bottom + 4, left: r.right - 220 }) }}
        className="flex items-center gap-1 px-3 py-2 rounded-md text-sm font-medium text-primary hover:bg-primary/5 transition-colors">
        {t('more_actions', { defaultValue: 'Autres actions' })} <ChevronDown size={14} />
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
function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick}
      className={`px-1 py-3 text-sm border-b-2 -mb-px transition-colors whitespace-nowrap ${active ? 'border-primary text-primary font-medium' : 'border-transparent text-text-secondary hover:text-text-primary'}`}>
      {children}
    </button>
  )
}

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
      style={{ width: 28, height: 28, borderRadius: '9999px', backgroundColor: c, outline: active ? '2px solid #4D38DB' : 'none', outlineOffset: 2 }} />
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
function CreateGuestsPanel({
  guests,
  onChange,
}: {
  guests: { email: string; display_name?: string }[]
  onChange: (g: { email: string; display_name?: string }[]) => void
}) {
  const { t } = useTranslation('calendar')
  const [email, setEmail] = useState('')
  const policy = useInstancePolicy()
  const typed  = email.trim()
  const isOutside = typed.includes('@')
    && policy.internalDomains.length > 0
    && !isInternalAddress(typed, policy.internalDomains)
  const blocked = isOutside && !policy.allowExternalGuests
  const already = guests.some(g => g.email.toLowerCase() === typed.toLowerCase())
  const guestLimitReached = policy.maxEventGuests > 0 && guests.length >= policy.maxEventGuests
  const canAdd = typed.includes('@') && !blocked && !already && !guestLimitReached
  const add = () => {
    if (!canAdd) return
    onChange([...guests, { email: typed }])
    setEmail('')
  }
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-1.5">
        <Input type="email" placeholder={t('guests_add', { defaultValue: 'Ajouter des invités' })}
          value={email} onChange={e => setEmail(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); add() } }}
          className="w-full" />
        <Button type="button" size="sm" disabled={!canAdd} onClick={add}>
          {t('guests_invite', { defaultValue: 'Inviter' })}
        </Button>
      </div>
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
            <div key={g.email} className="group flex items-center gap-2 text-sm">
              <span className="w-7 h-7 rounded-full bg-surface-2 flex items-center justify-center text-xs shrink-0">
                {g.email[0]?.toUpperCase()}
              </span>
              <span className="flex-1 min-w-0 truncate">{g.email}</span>
              <button type="button" onClick={() => onChange(guests.filter(x => x.email !== g.email))}
                className="p-1 text-text-tertiary hover:text-danger" aria-label={t('delete')}>
                <X size={14} />
              </button>
            </div>
          ))}
          <p className="text-xs text-text-tertiary pt-1">
            {t('guests_will_be_invited', { defaultValue: 'Les invitations seront envoyées à l’enregistrement.' })}
          </p>
        </div>
      )}
    </div>
  )
}

// ── Attendees panel (editing) ─────────────────────────────────────────────────
function GuestsPanel({ eventId }: { eventId: string }) {
  const { t } = useTranslation('calendar')
  const qc = useQueryClient()
  const [email, setEmail] = useState('')
  const [perm, setPerm] = useState({ modify: false, invite: true, seeList: true })
  const { data } = useQuery({
    queryKey: ['event-attendees', eventId],
    queryFn:  () => calendarApi.listAttendees(eventId).then(r => r.attendees),
  })
  const attendees = data ?? []
  const invite = useMutation({
    mutationFn: () => calendarApi.inviteAttendee(eventId, { email: email.trim() }),
    onSuccess:  () => { setEmail(''); qc.invalidateQueries({ queryKey: ['event-attendees', eventId] }) },
  })
  const remove = useMutation({
    mutationFn: (aid: string) => calendarApi.removeAttendee(eventId, aid),
    onSuccess:  () => qc.invalidateQueries({ queryKey: ['event-attendees', eventId] }),
  })
  const policy = useInstancePolicy()
  const typed  = email.trim()
  // An address outside the instance's declared domains. With no domain declared
  // the question has no local answer, and calling every colleague an outsider
  // would be worse than saying nothing — the server still asks the directory
  // and refuses on its own terms. So this only drives what the composer SAYS:
  // a warning, or the reason the button is closed.
  const isOutside = typed.includes('@')
    && policy.internalDomains.length > 0
    && !isInternalAddress(typed, policy.internalDomains)
  const blocked   = isOutside && !policy.allowExternalGuests
  const guestLimitReached =
    policy.maxEventGuests > 0 && attendees.length >= policy.maxEventGuests
  const canAdd = typed.includes('@') && !blocked && !guestLimitReached
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-1.5">
        <Input type="email" placeholder={t('guests_add', { defaultValue: 'Ajouter des invités' })}
          value={email} onChange={e => setEmail(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); if (canAdd) invite.mutate() } }}
          className="w-full" />
        <Button type="button" size="sm" disabled={!canAdd} loading={invite.isPending} onClick={() => invite.mutate()}>
          {t('guests_invite', { defaultValue: 'Inviter' })}
        </Button>
      </div>
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
            const rsvpUrl = calendarApi.rsvpPageUrl(a)
            const statusDot = {
              accepted: 'bg-success', declined: 'bg-danger', tentative: 'bg-warning', 'needs-action': 'bg-surface-3',
            }[status] ?? 'bg-surface-3'
            const statusLabel = {
              accepted:       t('rsvp_yes',      { defaultValue: 'A accepté' }),
              declined:       t('rsvp_no',       { defaultValue: 'A refusé' }),
              tentative:      t('rsvp_maybe',    { defaultValue: 'Peut-être' }),
              'needs-action': t('rsvp_pending',  { defaultValue: 'En attente' }),
            }[status] ?? status
            return (
              <div key={a.id} className="group flex items-center gap-2 text-sm">
                <span className="relative w-7 h-7 rounded-full bg-surface-2 flex items-center justify-center text-xs shrink-0">
                  {(a.display_name || a.email)[0]?.toUpperCase()}
                  <span className={`absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-surface-0 ${statusDot}`} />
                </span>
                <span className="flex-1 min-w-0">
                  <span className="block truncate">{a.display_name || a.email}</span>
                  <span className="block text-[11px] text-text-tertiary truncate">
                    {a.is_organizer ? t('organizer', { defaultValue: 'organisateur' }) : statusLabel}
                  </span>
                </span>
                {/* The invitation e-mail is now sent automatically by the
                    server (via the Mail module); the copy-link stays as a
                    fallback for sharing the RSVP page out of band. */}
                {!a.is_organizer && rsvpUrl && (
                  <button type="button"
                    onClick={() => { navigator.clipboard.writeText(rsvpUrl).catch(() => {}) }}
                    title={t('rsvp_copy_link', { defaultValue: 'Copier le lien d’invitation' })}
                    className="p-1 text-text-tertiary hover:text-primary opacity-0 group-hover:opacity-100 transition-opacity">
                    <Link2 size={13} />
                  </button>
                )}
                {!a.is_organizer && (
                  <button type="button" onClick={() => remove.mutate(a.id)} className="p-1 text-text-tertiary hover:text-danger" aria-label={t('delete')}>
                    <X size={14} />
                  </button>
                )}
              </div>
            )
          })}
        </div>
      )}
      <div className="pt-2">
        <p className="text-sm font-medium text-text-primary mb-2">{t('guest_perms', { defaultValue: 'Autorisations des invités' })}</p>
        <div className="space-y-2">
          <Checkbox checked={perm.modify} onChange={v => setPerm(p => ({ ...p, modify: v }))} label={t('perm_modify', { defaultValue: "Modifier l'événement" })} labelClassName="text-sm text-text-secondary" />
          <Checkbox checked={perm.invite} onChange={v => setPerm(p => ({ ...p, invite: v }))} label={t('perm_invite', { defaultValue: "Inviter d'autres personnes" })} labelClassName="text-sm text-text-secondary" />
          <Checkbox checked={perm.seeList} onChange={v => setPerm(p => ({ ...p, seeList: v }))} label={t('perm_see_list', { defaultValue: 'Voir la liste des invités' })} labelClassName="text-sm text-text-secondary" />
        </div>
      </div>
    </div>
  )
}

// ── "Find a time" tab ─────────────────────────────────────────────────────────
// Cross-references the calendars of Kubuno attendees (via /calendar/availability)
// and suggests slots where everyone is free; a click carries the slot back into
// the editor.
function ScheduleTab({ durationMinutes, defaultDate, onPick }: {
  durationMinutes: number
  defaultDate: string
  onPick: (start: Date, end: Date) => void
}) {
  const { t, i18n } = useTranslation('calendar')
  const tPattern = timePattern(useCalendarSettings().timeFormat)
  const isMobile = useIsMobile()
  const me = useAuthStore(s => s.user)

  const [participants, setParticipants] = useState<Array<{ id: string; label: string }>>([])
  const [query, setQuery] = useState('')
  const [suggestions, setSuggestions] = useState<Array<{ id: string; username: string; display_name: string | null }>>([])
  const [fromDate, setFromDate] = useState(defaultDate)
  const [days, setDays] = useState('5')
  const [workHours, setWorkHours] = useState(true)
  const [slots, setSlots] = useState<import('./api').AvailableSlot[] | null>(null)
  // Participants the instance did not let us cross-reference: they are left out
  // of the computation, so the proposals must not be read as "everyone is free".
  const [hiddenCount, setHiddenCount] = useState(0)
  const [searching, setSearching] = useState(false)
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // User suggestions (core directory), excluding myself + already added.
  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current)
    const q = query.trim()
    if (q.length < 2) { setSuggestions([]); return }
    searchTimer.current = setTimeout(async () => {
      try {
        const users = await calendarApi.searchUsers(q)
        const taken = new Set([me?.id, ...participants.map(p => p.id)])
        setSuggestions(users.filter(u => !taken.has(u.id)))
      } catch { setSuggestions([]) }
    }, 250)
    return () => { if (searchTimer.current) clearTimeout(searchTimer.current) }
  }, [query, participants, me?.id])

  const runSearch = async () => {
    if (!me?.id || searching) return
    setSearching(true)
    try {
      const from = new Date(`${fromDate}T00:00:00`)
      const until = addDays(from, Math.max(1, parseInt(days, 10) || 5))
      const r = await calendarApi.findCommonSlots({
        from: from.toISOString(), until: until.toISOString(),
        user_ids: [me.id, ...participants.map(p => p.id)],
      })
      setSlots(r.slots)
      setHiddenCount(r.hidden_user_ids?.length ?? 0)
    } catch { setSlots([]); setHiddenCount(0) }
    finally { setSearching(false) }
  }

  // Split the free ranges into slots of the event duration, filtered to
  // office hours when requested, grouped by day (max 6 per day).
  const proposals = useMemo(() => {
    if (!slots) return null
    const durMs = durationMinutes * 60_000
    const byDay = new Map<string, Array<{ start: Date; end: Date; score: number }>>()
    for (const s of slots) {
      if (s.score < 0.999) continue        // only suggest "everyone available"
      let cur = toDate(s.starts_at).getTime()
      const end = toDate(s.ends_at).getTime()
      while (cur + durMs <= end) {
        const st = new Date(cur)
        const en = new Date(cur + durMs)
        const okHours = !workHours || (st.getHours() >= 8 && (en.getHours() < 19 || (en.getHours() === 19 && en.getMinutes() === 0)))
        if (okHours) {
          const key = toISODate(st)
          const list = byDay.get(key) ?? []
          if (list.length < 6) list.push({ start: st, end: en, score: s.score })
          byDay.set(key, list)
        }
        cur += 30 * 60_000
      }
    }
    return [...byDay.entries()].filter(([, l]) => l.length).sort(([a], [b]) => a.localeCompare(b))
  }, [slots, durationMinutes, workHours])

  return (
    <div className={`${isMobile ? 'px-4' : 'px-10'} py-6 max-h-[55vh] overflow-y-auto space-y-4`}>
      {/* Participants */}
      <div>
        <p className="text-xs font-semibold text-text-secondary mb-1.5">
          {t('schedule_participants', { defaultValue: 'Participants (utilisateurs Kubuno)' })}
        </p>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="px-2.5 py-1 rounded-full bg-primary/10 text-primary text-xs font-medium">
            {me?.display_name || me?.username || t('schedule_me', { defaultValue: 'Moi' })}
          </span>
          {participants.map(p => (
            <span key={p.id} className="px-2.5 py-1 rounded-full bg-surface-2 text-text-primary text-xs flex items-center gap-1">
              {p.label}
              <button type="button" onClick={() => setParticipants(prev => prev.filter(x => x.id !== p.id))}
                className="text-text-tertiary hover:text-danger"><X size={11} /></button>
            </span>
          ))}
          <div className="relative">
            <input
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder={t('schedule_add_user', { defaultValue: 'Ajouter…' })}
              className="px-2 py-1 text-xs rounded-lg border border-border bg-surface-0 outline-none focus:border-primary w-36"
            />
            {suggestions.length > 0 && (
              <div className="absolute z-20 left-0 top-full mt-1 w-52 rounded-lg border border-border bg-surface-0 shadow-lg overflow-hidden">
                {suggestions.map(u => (
                  <button key={u.id} type="button"
                    onClick={() => { setParticipants(prev => [...prev, { id: u.id, label: u.display_name || u.username }]); setQuery(''); setSuggestions([]) }}
                    className="w-full px-3 py-1.5 text-left text-xs hover:bg-surface-1 truncate">
                    {u.display_name || u.username} <span className="text-text-tertiary">@{u.username}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Search window */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="w-40"><DatePicker mode="date" value={fromDate} onChange={v => setFromDate(v ?? fromDate)} /></div>
        <Dropdown value={days} onChange={setDays} className="w-36"
          options={[
            { value: '1',  label: t('schedule_days_1',  { defaultValue: '1 jour' }) },
            { value: '3',  label: t('schedule_days_3',  { defaultValue: '3 jours' }) },
            { value: '5',  label: t('schedule_days_5',  { defaultValue: '5 jours' }) },
            { value: '7',  label: t('schedule_days_7',  { defaultValue: '7 jours' }) },
            { value: '14', label: t('schedule_days_14', { defaultValue: '14 jours' }) },
          ]} />
        <Checkbox checked={workHours} onChange={setWorkHours}
          label={t('schedule_work_hours', { defaultValue: 'Heures de bureau (8h – 19h)' })}
          labelClassName="text-xs text-text-secondary" />
        <Button type="button" size="sm" loading={searching} onClick={runSearch}>
          {t('schedule_search', { defaultValue: 'Rechercher' })}
        </Button>
      </div>

      {/* Results */}
      {hiddenCount > 0 && (
        <p className="text-xs text-warning">
          {t('schedule_hidden_participants', {
            defaultValue: 'La disponibilité de {{n}} participant(s) n’est pas visible : ils ne sont pas pris en compte dans les créneaux proposés.',
            n: hiddenCount,
          })}
        </p>
      )}
      {proposals === null ? (
        <div className="text-center text-text-tertiary py-8">
          <Users size={28} className="mx-auto mb-3 opacity-40" />
          <p className="text-sm">{t('schedule_empty', { defaultValue: 'Choisissez des participants puis lancez la recherche : les créneaux où tout le monde est libre s’affichent ici.' })}</p>
        </div>
      ) : proposals.length === 0 ? (
        <p className="text-sm text-text-tertiary italic py-4">
          {t('schedule_no_slot', { defaultValue: 'Aucun créneau commun trouvé sur cette période.' })}
        </p>
      ) : (
        <div className="space-y-3">
          {proposals.map(([day, list]) => (
            <div key={day}>
              <p className="text-xs font-semibold text-text-secondary mb-1.5 capitalize">
                {formatDate(toDate(`${day}T00:00:00`), 'weekdayDate')}
              </p>
              <div className="flex flex-wrap gap-1.5">
                {list.map(({ start, end }) => (
                  <button
                    key={start.toISOString()}
                    type="button"
                    onClick={() => onPick(start, end)}
                    className="px-3 py-1.5 rounded-lg border border-border text-sm text-text-primary
                               hover:border-primary hover:bg-primary/5 transition-colors"
                  >
                    <MonoText>{formatDate(start, tPattern)}</MonoText> – <MonoText>{formatDate(end, tPattern)}</MonoText>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Event editor (create + edit) ──────────────────────────────────────────────
// Responsive control in JS (`useIsMobile` from @ui): a MODULE's `sm:`/`lg:`
// variants that cancel a base class (px-4, flex-col, w-full…) are overridden by
// the host's base utility (utilities layer > kubuno-module). Hence matchMedia.

function EventEditor({ mode, event, initialDate, initialEnd, calendars, onClose }: {
  mode: 'create' | 'edit'; event?: EventInstance; initialDate?: Date | null; initialEnd?: Date | null; calendars: Calendar[]; onClose: () => void
}) {
  const { t } = useTranslation('calendar')
  const isMobile = useIsMobile()
  const PX = isMobile ? 'px-4' : 'px-16'
  const qc = useQueryClient()
  const ev = event

  // Draggable edit window: the top bar acts as the handle. Clicks on interactive
  // elements (title field, buttons, menus) are ignored so they don't disturb
  // editing. The offset translates the card from its initial centered position.
  const [winOffset, setWinOffset] = useState({ x: 0, y: 0 })
  const dragRef = useRef<{ ox: number; oy: number; sx: number; sy: number } | null>(null)
  const onWindowDragStart = (e: React.MouseEvent) => {
    if (e.button !== 0) return
    if ((e.target as HTMLElement).closest('input, button, textarea, select, a, [role="menu"], [role="menuitem"]')) return
    e.preventDefault()
    dragRef.current = { ox: winOffset.x, oy: winOffset.y, sx: e.clientX, sy: e.clientY }
    const move = (me: MouseEvent) => {
      const d = dragRef.current
      if (!d) return
      setWinOffset({ x: d.ox + me.clientX - d.sx, y: d.oy + me.clientY - d.sy })
    }
    const up = () => { dragRef.current = null; window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up) }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

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
  const [title,      setTitle]      = useState(ev?.title ?? '')
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
  const [allDay,     setAllDay]     = useState(ev?.all_day ?? false)
  const [location,   setLocation]   = useState(ev?.location ?? '')
  // Guests collected before the event exists (creation only). On an existing
  // event guests are managed live through GuestsPanel.
  const [pendingGuests, setPendingGuests] = useState<{ email: string; display_name?: string }[]>([])
  const [addingMeeting, setAddingMeeting] = useState(false)
  const [desc,       setDesc]       = useState(ev?.description ?? '')
  const meetingProvider = getMeetingProvider()
  const hasMeeting = MEETING_LINK_RE.test(location)
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

  const { mutate, isPending, error } = useMutation<unknown, Error, string | undefined>({
    mutationFn: (scope?: string) => {
      let startsAt: string, endsAt: string
      if (allDay) {
        startsAt = `${date}T00:00:00.000Z`
        endsAt   = `${endDate || date}T23:59:59.000Z`
      } else {
        startsAt = new Date(`${date}T${startTime}:00`).toISOString()
        const ed = endDate || (endTime < startTime ? toISODate(addDays(new Date(`${date}T00:00:00`), 1)) : date)
        endsAt   = new Date(`${ed}T${endTime}:00`).toISOString()
      }
      const calColor = calendars.find(c => c.id === calId)?.color
      const tz       = calendars.find(c => c.id === calId)?.timezone
      const start    = new Date(`${date}T${allDay ? '00:00' : startTime}:00`)
      // Effective RRULE per the choice: preset, custom, or none.
      const effectiveRrule = recur === 'custom' ? (customRrule ?? undefined) : buildRrule(recur, start) ?? undefined
      const base = {
        calendar_id: calId, title: title.trim(),
        description: desc.trim() || undefined, location: location.trim() || undefined,
        starts_at: startsAt, ends_at: endsAt, all_day: allDay,
        reminders: reminders.length ? reminders : undefined,
        // "Default visibility" (UI) = the backend's default visibility = 'public'.
        // Le backend n'accepte que public/private/confidential (contrainte CHECK).
        busy, visibility: visibility === 'default' ? 'public' : visibility, timezone: tz,
      }
      if (mode === 'create') {
        return calendarApi.createEvent({ ...base,
          rrule: effectiveRrule,
          ...(color && color !== calColor ? { color } : {}),
          ...(pendingGuests.length ? { attendees: pendingGuests } : {}),
        })
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
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['calendar-events'] }); onClose() },
  })

  // Save: on an existing series, ask for the scope first.
  const save = () => {
    if (mode === 'edit' && ev?.is_recurring) setAskScope(true)
    else mutate(undefined)
  }

  const canSave  = title.trim().length > 0 && calId !== '' && !isPending
  const calColor = calendars.find(c => c.id === calId)?.color ?? '#4D38DB'
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
    <div className={`fixed inset-0 z-[80] bg-black/30 ${isMobile ? '' : 'flex items-start justify-center overflow-y-auto p-4'}`}
      onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      {/* Mobile: full-screen sheet (whole card scrolls, sticky top bar).
          Desktop: centered draggable card. */}
      <div className={`bg-surface-0 ${isMobile
          ? 'absolute inset-0 overflow-y-auto overscroll-contain'
          : 'rounded-2xl shadow-2xl w-full max-w-5xl my-4'}`}
        style={isMobile ? undefined : { transform: `translate(${winOffset.x}px, ${winOffset.y}px)` }}>
        {/* Top bar — acts as the window drag handle (desktop only) */}
        <div className={`flex items-center gap-3 py-3 select-none ${isMobile
            ? 'px-3 sticky top-0 z-10 bg-surface-0 border-b border-border'
            : 'px-5 cursor-move'}`}
          onMouseDown={isMobile ? undefined : onWindowDragStart}>
          <button type="button" onClick={onClose} className="p-1.5 rounded-full hover:bg-surface-2 text-text-secondary" aria-label={t('cancel')}><X size={20} /></button>
          <input autoFocus value={title} onChange={e => setTitle(e.target.value)} placeholder={t('event_title')} maxLength={500}
            className="flex-1 text-xl text-text-primary placeholder:text-text-tertiary border-b border-transparent focus:border-primary outline-none py-1 bg-transparent min-w-0" />
          <Button onClick={() => canSave && save()} disabled={!canSave} loading={isPending}>{t('save', { defaultValue: 'Enregistrer' })}</Button>
          {mode === 'edit' && ev && <EditEventActionsMenu event={ev} calendars={calendars} onClose={onClose} />}
        </div>

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

        {/* Date / heure / fuseau */}
        <div className={`${PX} pb-1 flex flex-wrap items-center gap-2`}>
          <div className="w-40"><DatePicker mode="date" value={date} onChange={v => setDate(v ?? '')} /></div>
          {!allDay && <>
            <DatePicker mode="time" value={startTime} onChange={v => setStartTime(v ?? '')} />
            <span className="text-text-tertiary">–</span>
            <DatePicker mode="time" value={endTime} onChange={v => setEndTime(v ?? '')} />
          </>}
          <div className="w-40"><DatePicker mode="date" value={endDate} onChange={v => setEndDate(v ?? '')} /></div>
          <span className="text-text-tertiary text-xs ml-1">{tzName}</span>
        </div>
        <div className={`${PX} pb-3 flex items-center gap-4`}>
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

        {/* Onglets */}
        <div className={`${PX} border-b border-border flex gap-6`}>
          <TabButton active={tab === 'details'} onClick={() => setTab('details')}>{t('tab_details', { defaultValue: "Détails de l'événement" })}</TabButton>
          <TabButton active={tab === 'schedule'} onClick={() => setTab('schedule')}>{t('tab_schedule', { defaultValue: 'Rechercher un horaire' })}</TabButton>
        </div>

        {/* Corps */}
        {tab === 'details' ? (
          <div className={`${PX} py-6 flex ${isMobile ? 'flex-col gap-6' : 'flex-row gap-12 max-h-[55vh] overflow-y-auto'}`}>
            <div className="space-y-5 min-w-0 flex-1">
              {!hasMeeting && row(<MapPin size={18} />, <Input placeholder={t('add_location', { defaultValue: 'Ajouter un lieu' })} value={location} onChange={e => setLocation(e.target.value)} className="w-full" />)}
              {/* Video meeting — provided dynamically by a module (e.g. chat) */}
              {(meetingProvider || hasMeeting) && row(<Video size={18} />, hasMeeting ? (
                <div className="flex items-center gap-3 text-sm">
                  <span className="text-primary font-medium">{t('video_meeting_added', { defaultValue: 'Réunion vidéo Kubuno' })}</span>
                  <button type="button" onClick={() => setLocation('')} className="text-xs text-danger hover:underline">{t('detail_remove', { defaultValue: 'Retirer' })}</button>
                </div>
              ) : (
                <button type="button" disabled={addingMeeting}
                  onClick={async () => {
                    if (!meetingProvider) return
                    setAddingMeeting(true)
                    try { const r = await meetingProvider(title.trim() || t('event_title'), []); setLocation(r.link) }
                    catch { /* ignore */ } finally { setAddingMeeting(false) }
                  }}
                  className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md bg-primary/10 text-primary text-sm font-medium hover:bg-primary/20 disabled:opacity-50 transition-colors">
                  <Video size={15} /> {addingMeeting ? '…' : t('add_video_meeting', { defaultValue: 'Ajouter une réunion vidéo' })}
                </button>
              ))}
              <RemindersSection reminders={reminders} onChange={setReminders} />
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
              {row(<AlignLeft size={18} />, <RichText value={desc} onChange={setDesc} placeholder={t('add_description', { defaultValue: 'Ajouter une description' })} minHeight={140} className="w-full" />)}
            </div>
            <div className={`${isMobile ? 'w-full' : 'w-[320px]'} shrink-0`}>
              <h3 className="text-sm font-medium text-text-primary border-b-2 border-primary inline-block pb-2 mb-4">{t('guests', { defaultValue: 'Invités' })}</h3>
              {mode === 'edit' && ev ? (
                <GuestsPanel eventId={ev.event_id} />
              ) : (
                <CreateGuestsPanel guests={pendingGuests} onChange={setPendingGuests} />
              )}
            </div>
          </div>
        ) : (
          <ScheduleTab
            durationMinutes={(() => {
              if (allDay) return 60
              const s = new Date(`${date}T${startTime}:00`).getTime()
              const e = new Date(`${endDate || date}T${endTime}:00`).getTime()
              return Math.max(30, Math.round((e - s) / 60_000) || 60)
            })()}
            defaultDate={date}
            onPick={(s, e) => {
              setDate(toISODate(s))
              setEndDate(toISODate(e))
              setStartTime(formatDate(s, 'time'))
              setEndTime(formatDate(e, 'time'))
              setAllDay(false)
              setTab('details')
            }}
          />
        )}

        {(error || targetCals.length === 0) && (
          <div className={`${PX} pb-4`}>
            {error && (
              <p className="text-xs text-danger">
                {/* A raw "Access denied" explains nothing: spell out the most common case. */}
                {/(403|refusé|forbidden)/i.test(error.message)
                  ? t('event_forbidden_hint', { defaultValue: 'Accès refusé : vous n’avez pas le droit d’écrire dans cet agenda. Choisissez un agenda dont vous êtes propriétaire ou partagé en modification.' })
                  : error.message}
              </p>
            )}
            {targetCals.length === 0 && (
              <p className="text-xs text-warning">
                {t('no_writable_calendar', { defaultValue: 'Aucun agenda modifiable : créez un agenda ou demandez un partage en modification.' })}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

export function CreateEventModal({ initialDate, initialEnd, calendars, onClose }: CreateModalProps) {
  return <EventEditor mode="create" initialDate={initialDate} initialEnd={initialEnd} calendars={calendars} onClose={onClose} />
}

export function EditEventModal({ event, calendars, onClose }: EditModalProps) {
  return <EventEditor mode="edit" event={event} calendars={calendars} onClose={onClose} />
}

// ── Event detail ──────────────────────────────────────────────────────────────

