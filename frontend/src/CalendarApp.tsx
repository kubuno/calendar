import { useState, useMemo, useEffect, useCallback, useRef } from 'react'
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
  LayoutGrid,
} from 'lucide-react'
import { useAuthStore } from '@kubuno/sdk'
import { FloatingWindow, MenuDropdown, type MenuItem, type MenuDropdownPos } from '@ui'
import { Dropdown, Checkbox, Button, DatePicker, Input, RichText, ColorPicker, useAppPickerTheme } from '@ui'
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
import { buildRrule, presetFromRrule, describeRrule } from './rrule'
import { copyKubunoData, eventEnvelope, openLabelPicker } from './kubunoData'
import RecurrenceCustomDialog from './RecurrenceCustomDialog'
import { MonoText } from './MonoText'
import {
  MoonIcon, PrincipalMoonIcon, moonPhase, moonIllumination,
  moonPhaseName, principalPhaseOfDay, principalPhaseName,
} from './moon'

// Contract for a video-meeting provider published by another module (e.g. chat).
// Calendar discovers it dynamically — no hard dependency on any specific module.
type MeetingProvider = (title: string, attendeeIds?: string[]) => Promise<{ link: string; roomId: string }>
const MEETING_LINK_RE = /\/chat\/meet\/[\w-]+/
function getMeetingProvider(): MeetingProvider | undefined {
  return ModuleServiceRegistry.get<MeetingProvider>('chat', 'createMeeting')
}
import { Link, useParams, useNavigate, useLocation } from 'react-router-dom'

const EVENT_SWATCHES = ['#4D38DB', '#1e8e3e', '#d93025', '#f9ab00', '#9334e6', '#e8710a', '#12b5cb', '#5f6368']

// ── Helpers ──────────────────────────────────────────────────────────────────

const REMINDER_OPTIONS: Array<{ value: number; labelKey: string }> = [
  { value: 5,    labelKey: 'rem_5min' },
  { value: 10,   labelKey: 'rem_10min' },
  { value: 15,   labelKey: 'rem_15min' },
  { value: 30,   labelKey: 'rem_30min' },
  { value: 60,   labelKey: 'rem_1h' },
  { value: 120,  labelKey: 'rem_2h' },
  { value: 1440, labelKey: 'rem_1day' },
]

function isWeekend(date: Date): boolean {
  const d = getDay(date)
  return d === 0 || d === 6
}

// Calendars the user can WRITE to: their own plus those shared with "Edit"
// access. Subscriptions (mirrors of a remote feed) are excluded: any event
// created there would be purged on the next sync.
function writableCalendars(calendars: Calendar[]): Calendar[] {
  return calendars.filter(c =>
    (c.my_permission == null || c.my_permission === 'owner' || c.my_permission === 'write')
    && !c.subscription_url)
}

// Calendar locked for event editing (read-only or subscription).
function isCalendarLocked(cal: Calendar | undefined): boolean {
  return !!cal && (cal.my_permission === 'read' || !!cal.subscription_url)
}

// Marker prefix identifying a synthetic availability block (vs a real event).
const APPT_PREFIX = 'appt::'

// Expand appointment schedules into synthetic per-day availability blocks over
// the visible range, so the owner sees when their booking pages are open
// (recurring "09:00 <title>" markers). These are non-editable events
// tagged via `event_id = appt::<scheduleId>`; clicking one opens the editor.
// Times are built in local time — correct when the browser shares the schedule's
// timezone (the default), which is the common case.
function buildAvailabilityEvents(schedules: AppointmentSchedule[], from: Date, to: Date): EventInstance[] {
  const out: EventInstance[] = []
  for (const s of schedules) {
    const rules = s.availability ?? []
    if (rules.length === 0) continue
    const color = s.color || '#4d38db'
    const cursor = new Date(from.getFullYear(), from.getMonth(), from.getDate())
    const last = new Date(to.getFullYear(), to.getMonth(), to.getDate())
    while (cursor <= last) {
      const y = cursor.getFullYear(), mo = cursor.getMonth(), d = cursor.getDate()
      const iso = `${y}-${String(mo + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`
      const weekday = (cursor.getDay() + 6) % 7                    // 0 = Mon … 6 = Sun
      const overrides = rules.filter(r => r.specific_date === iso)
      const windows = overrides.length > 0 ? overrides : rules.filter(r => r.weekday === weekday)
      for (const w of windows) {
        const start = new Date(y, mo, d, Math.floor(w.start_minute / 60), w.start_minute % 60)
        const end   = new Date(y, mo, d, Math.floor(w.end_minute / 60), w.end_minute % 60)
        out.push({
          id: `${APPT_PREFIX}${s.id}::${iso}::${w.start_minute}`,
          event_id: `${APPT_PREFIX}${s.id}`,
          calendar_id: s.calendar_id, owner_id: s.owner_id,
          title: s.title || 'Rendez-vous',
          description: null, location: null,
          starts_at: start.toISOString(), ends_at: end.toISOString(),
          all_day: false, is_recurring: true, rrule: null,
          status: 'confirmed', visibility: 'public', busy: false,
          color, ical_uid: '', etag: '', reminders: [],
        })
      }
      cursor.setDate(cursor.getDate() + 1)
    }
  }
  return out
}

// Side-by-side layout of overlapping events (day/week views): groups
// transitive overlaps into "clusters", assigns each event the first free
// column, and splits the cluster width between its columns.
function layoutDayEvents(evs: EventInstance[]): Map<string, { leftPct: number; widthPct: number }> {
  const MIN_SPAN = 30 // minutes: a very short event still takes up room
  const items = evs
    .map(ev => {
      const s = parseISO(ev.starts_at)
      const e = parseISO(ev.ends_at)
      const sMin = s.getHours() * 60 + s.getMinutes()
      return { id: ev.id, s: sMin, e: Math.max(e.getHours() * 60 + e.getMinutes(), sMin + MIN_SPAN) }
    })
    .sort((a, b) => a.s - b.s || b.e - a.e)

  const res = new Map<string, { leftPct: number; widthPct: number }>()
  let cluster: Array<{ id: string; s: number; e: number; col: number }> = []
  let clusterEnd = -1

  const flush = () => {
    if (!cluster.length) return
    const cols = Math.max(...cluster.map(c => c.col)) + 1
    for (const c of cluster) res.set(c.id, { leftPct: (c.col / cols) * 100, widthPct: 100 / cols })
    cluster = []
    clusterEnd = -1
  }

  for (const it of items) {
    if (cluster.length && it.s >= clusterEnd) flush()
    const busy = new Set(cluster.filter(c => c.e > it.s).map(c => c.col))
    let col = 0
    while (busy.has(col)) col++
    cluster.push({ ...it, col })
    clusterEnd = Math.max(clusterEnd, it.e)
  }
  flush()
  return res
}

function calendarGrid(month: Date): Date[] {
  const start = startOfWeek(startOfMonth(month), { weekStartsOn: 1 })
  const end   = endOfWeek(endOfMonth(month),   { weekStartsOn: 1 })
  return eachDayOfInterval({ start, end })
}

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
  const dayName = format(start, 'EEEE', { locale: getDateLocale(i18n.language) })
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
  const canAdd = email.trim().includes('@')
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
                {!a.is_organizer && rsvpUrl && (
                  <>
                    <button type="button"
                      onClick={() => { navigator.clipboard.writeText(rsvpUrl).catch(() => {}) }}
                      title={t('rsvp_copy_link', { defaultValue: 'Copier le lien d’invitation' })}
                      className="p-1 text-text-tertiary hover:text-primary opacity-0 group-hover:opacity-100 transition-opacity">
                      <Link2 size={13} />
                    </button>
                    <a
                      href={`mailto:${a.email}?subject=${encodeURIComponent(t('rsvp_mail_subject', { defaultValue: 'Invitation' }))}&body=${encodeURIComponent(t('rsvp_mail_body', { defaultValue: 'Bonjour,\n\nVous êtes invité(e). Merci de répondre ici : ' }) + rsvpUrl)}`}
                      title={t('rsvp_send_mail', { defaultValue: 'Envoyer l’invitation par e-mail' })}
                      className="p-1 text-text-tertiary hover:text-primary opacity-0 group-hover:opacity-100 transition-opacity">
                      <Mail size={13} />
                    </a>
                  </>
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
  const isMobile = useIsMobile()
  const me = useAuthStore(s => s.user)
  const loc = getDateLocale(i18n.language)

  const [participants, setParticipants] = useState<Array<{ id: string; label: string }>>([])
  const [query, setQuery] = useState('')
  const [suggestions, setSuggestions] = useState<Array<{ id: string; username: string; display_name: string | null }>>([])
  const [fromDate, setFromDate] = useState(defaultDate)
  const [days, setDays] = useState('5')
  const [workHours, setWorkHours] = useState(true)
  const [slots, setSlots] = useState<import('./api').AvailableSlot[] | null>(null)
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
    } catch { setSlots([]) }
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
      let cur = parseISO(s.starts_at).getTime()
      const end = parseISO(s.ends_at).getTime()
      while (cur + durMs <= end) {
        const st = new Date(cur)
        const en = new Date(cur + durMs)
        const okHours = !workHours || (st.getHours() >= 8 && (en.getHours() < 19 || (en.getHours() === 19 && en.getMinutes() === 0)))
        if (okHours) {
          const key = format(st, 'yyyy-MM-dd')
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
                {format(parseISO(`${day}T00:00:00`), 'EEEE d MMMM', { locale: loc })}
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
                    <MonoText>{format(start, 'HH:mm')}</MonoText> – <MonoText>{format(end, 'HH:mm')}</MonoText>
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
// Responsive control in JS: a MODULE's `sm:`/`lg:` variants that cancel a base
// class (px-4, flex-col, w-full…) are overridden by the host's base utility
// (utilities layer > kubuno-module). Hence matchMedia.
function useIsMobile(): boolean {
  const [m, setM] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia('(max-width: 1023px)').matches)
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 1023px)')
    const on = () => setM(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return m
}

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

  const parseTime = (iso: string) => format(parseISO(iso), 'HH:mm')
  const parseDate = (iso: string) => format(parseISO(iso), 'yyyy-MM-dd')

  const [tab,        setTab]        = useState<'details' | 'schedule'>('details')
  const [title,      setTitle]      = useState(ev?.title ?? '')
  const [calId,      setCalId]      = useState(ev?.calendar_id ?? '')
  // A preselected range (dragging on the grid) prefills the times.
  const initialHasTime = !!initialDate && (initialDate.getHours() !== 0 || initialDate.getMinutes() !== 0 || !!initialEnd)
  const [date,       setDate]       = useState(ev ? parseDate(ev.starts_at) : format(initialDate ?? new Date(), 'yyyy-MM-dd'))
  const [endDate,    setEndDate]    = useState(ev ? parseDate(ev.ends_at) : format(initialEnd ?? initialDate ?? new Date(), 'yyyy-MM-dd'))
  const [startTime,  setStartTime]  = useState(ev ? parseTime(ev.starts_at) : initialHasTime ? format(initialDate!, 'HH:mm') : '09:00')
  const [endTime,    setEndTime]    = useState(ev ? parseTime(ev.ends_at)
    : initialEnd ? format(initialEnd, 'HH:mm')
    : initialHasTime ? format(new Date(initialDate!.getTime() + 3600_000), 'HH:mm')
    : '10:00')
  const [allDay,     setAllDay]     = useState(ev?.all_day ?? false)
  const [location,   setLocation]   = useState(ev?.location ?? '')
  const [addingMeeting, setAddingMeeting] = useState(false)
  const [desc,       setDesc]       = useState(ev?.description ?? '')
  const meetingProvider = getMeetingProvider()
  const hasMeeting = MEETING_LINK_RE.test(location)
  const [reminders,  setReminders]  = useState<EventReminder[]>(ev?.reminders ?? [])
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
        const ed = endDate || (endTime < startTime ? format(addDays(new Date(`${date}T00:00:00`), 1), 'yyyy-MM-dd') : date)
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
  const tzName   = calendars.find(c => c.id === calId)?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone

  const row = (icon: React.ReactNode, children: React.ReactNode) => (
    <div className="flex items-start gap-4">
      <div className="w-5 shrink-0 text-text-tertiary mt-2 flex justify-center">{icon}</div>
      <div className="flex-1 min-w-0">{children}</div>
    </div>
  )

  return (
    <div className="fixed inset-0 z-[80] bg-black/30 flex items-start justify-center overflow-y-auto p-4"
      onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="bg-surface-0 rounded-2xl shadow-2xl w-full max-w-5xl my-4"
        style={{ transform: `translate(${winOffset.x}px, ${winOffset.y}px)` }}>
        {/* Top bar — acts as the window drag handle */}
        <div className="flex items-center gap-3 px-5 py-3 cursor-move select-none"
          onMouseDown={onWindowDragStart}>
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
          <div className={`${PX} py-6 flex ${isMobile ? 'flex-col gap-6' : 'flex-row gap-12'} max-h-[55vh] overflow-y-auto`}>
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
                <p className="text-sm text-text-tertiary">{t('guests_after_create', { defaultValue: "Enregistrez l'événement pour ajouter des invités." })}</p>
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
              setDate(format(s, 'yyyy-MM-dd'))
              setEndDate(format(e, 'yyyy-MM-dd'))
              setStartTime(format(s, 'HH:mm'))
              setEndTime(format(e, 'HH:mm'))
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

function CreateEventModal({ initialDate, initialEnd, calendars, onClose }: CreateModalProps) {
  return <EventEditor mode="create" initialDate={initialDate} initialEnd={initialEnd} calendars={calendars} onClose={onClose} />
}

function EditEventModal({ event, calendars, onClose }: EditModalProps) {
  return <EventEditor mode="edit" event={event} calendars={calendars} onClose={onClose} />
}

// ── Event detail ──────────────────────────────────────────────────────────────

// Small icon button for the header action bar.
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

function EventDetail({
  event, calendars, onClose, onDelete, onEdit,
}: {
  event: EventInstance; calendars: Calendar[]
  onClose: () => void; onDelete: () => void; onEdit: () => void
}) {
  const { t, i18n } = useTranslation('calendar')
  const qc   = useQueryClient()
  const navigate = useNavigate()
  const user = useAuthStore(s => s.user)
  const meetingLink = event.location ? event.location.match(MEETING_LINK_RE)?.[0] ?? null : null
  const cal  = calendars.find(c => c.id === event.calendar_id)
  const color = event.color ?? cal?.color ?? '#4D38DB'
  const loc   = getDateLocale(i18n.language)
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

  const start = parseISO(event.starts_at)
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
  const dateText = cap(event.all_day
    ? format(start, 'EEEE d MMMM yyyy', { locale: loc })
    : `${format(start, 'EEEE d MMMM', { locale: loc })} · ${t('detail_from_to', {
        from: format(start, 'HH:mm'),
        to:   format(parseISO(event.ends_at), 'HH:mm'),
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
    const mins = Math.max(0, Math.round((parseISO(event.ends_at).getTime() - start.getTime()) / 60000))
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
            className="mt-4 inline-flex items-center gap-2 px-4 py-2 rounded-full bg-primary text-white text-sm font-medium hover:bg-primary-hover transition-colors"
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

interface CtxMenuState {
  x: number
  y: number
  event: EventInstance
}

// "Live" current time: re-renders periodically so the "now" line and the
// past/upcoming dimming evolve in real time without reloading the page.
function useNowTick(intervalMs = 30_000): Date {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
  return now
}


// Width (px) reserved on the left of a day column for appointment-schedule
// availability strips, so real events are nudged right and never cover them.
const APPT_GUTTER = 18

// Availability blocks (appointment schedules) render as a thin colored strip
// pinned to the left of the day — a floating icon + label sits at the top,
// overflowing to the right. Read-only: a click opens the schedule editor.
function AvailabilityStrip({ ev, top, height, sMin, onClick }: {
  ev: EventInstance; top: number; height: number; sMin: number; onClick: () => void
}) {
  const color = ev.color ?? '#4D38DB'
  const hm = `${String(Math.floor(sMin / 60)).padStart(2, '0')}:${String(sMin % 60).padStart(2, '0')}`
  return (
    <div onClick={onClick} title={`${ev.title} · ${hm}`}
      className="absolute z-[6] cursor-pointer" style={{ top, height, left: 2, width: 13 }}>
      <div className="absolute inset-0 rounded-md" style={{ background: color + '26', border: `1px solid ${color}59` }} />
      <div className="absolute top-1 left-0 flex items-center gap-1.5 whitespace-nowrap pointer-events-none">
        <span className="shrink-0 grid place-items-center w-5 h-5 rounded-full ring-2 ring-surface-0 shadow-sm"
          style={{ background: color, color: '#fff' }}>
          <LayoutGrid size={11} />
        </span>
        <span className="text-[11px] font-medium leading-none" style={{ color }}>{ev.title}, <MonoText>{hm}</MonoText></span>
      </div>
    </div>
  )
}

// ── Day view ──────────────────────────────────────────────────────────────────

function DayView({ date, events, calendars, onEventClick, onEventContextMenu, onEventDrop, onEventResize, onRangeCreate, weatherByDate }: {
  date: Date; events: EventInstance[]; calendars: Calendar[]
  onEventClick: (ev: EventInstance) => void
  onEventContextMenu: (e: React.MouseEvent, ev: EventInstance) => void
  onEventDrop: (ev: EventInstance, newStart: Date) => void
  onEventResize: (ev: EventInstance, newStart: Date, newEnd: Date) => void
  onRangeCreate: (start: Date, end: Date) => void
  weatherByDate: Map<string, DailyWeather>
}) {
  const { t, i18n } = useTranslation('calendar')
  const hours    = Array.from({ length: 24 }, (_, i) => i)
  const calMap   = useMemo(() => new Map(calendars.map(c => [c.id, c])), [calendars])
  const weekend  = isWeekend(date)
  const dayEvs0  = events.filter(ev => !ev.all_day && isSameDay(parseISO(ev.starts_at), date))
  const apptEvs  = dayEvs0.filter(ev => ev.event_id.startsWith(APPT_PREFIX))
  const dayEvs   = dayEvs0.filter(ev => !ev.event_id.startsWith(APPT_PREFIX))
  const apptPad  = apptEvs.length ? APPT_GUTTER : 0
  const allDayEvs = events.filter(ev => ev.all_day && isSameDay(parseISO(ev.starts_at), date))
  const dateKey  = format(date, 'yyyy-MM-dd')
  const wx       = weatherByDate.get(dateKey) ?? null
  const [dragging, setDragging] = useState<EventInstance | null>(null)
  const [ghostMin, setGhostMin] = useState<number | null>(null)
  // Synchronous ref: onDragOver/onDrop don't depend on `dragging` re-render timing
  // (otherwise the first dragovers see null, skip preventDefault, and the drop never lands).
  const draggingRef = useRef<EventInstance | null>(null)
  const ghostHeight = dragging ? Math.max(((parseISO(dragging.ends_at).getTime() - parseISO(dragging.starts_at).getTime()) / 3600000) * 40, 20) : 0

  // Vertical resize of an event (top/bottom handles → start/end).
  const PX_PER_HOUR = 40
  const [resize, setResize] = useState<{ id: string; startMin: number; endMin: number } | null>(null)
  const resizingRef = useRef(false)   // bloque le drag HTML5 pendant un resize
  const minOf = (iso: string) => { const d = parseISO(iso); return d.getHours() * 60 + d.getMinutes() }
  const startResize = (ev: EventInstance, edge: 'top' | 'bottom') => (e: React.PointerEvent) => {
    e.stopPropagation(); e.preventDefault()
    resizingRef.current = true
    const s0 = minOf(ev.starts_at), e0 = minOf(ev.ends_at)
    let cur = { startMin: s0, endMin: e0 }
    setResize({ id: ev.id, ...cur })
    const move = (me: PointerEvent) => {
      const deltaMin = Math.round(((me.clientY - e.clientY) / PX_PER_HOUR * 60) / 15) * 15
      if (edge === 'top') cur = { startMin: Math.max(0, Math.min(e0 - 15, s0 + deltaMin)), endMin: e0 }
      else                cur = { startMin: s0, endMin: Math.min(24 * 60, Math.max(s0 + 15, e0 + deltaMin)) }
      setResize({ id: ev.id, ...cur })
    }
    const up = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up)
      resizingRef.current = false
      setResize(null)
      if (cur.startMin !== s0 || cur.endMin !== e0) {
        const ns = new Date(date); ns.setHours(Math.floor(cur.startMin / 60), cur.startMin % 60, 0, 0)
        const ne = new Date(date); ne.setHours(Math.floor(cur.endMin / 60), cur.endMin % 60, 0, 0)
        onEventResize(ev, ns, ne)
      }
    }
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up)
  }
  const fmtMin = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`

  // Creation by dragging on an empty grid area (single click = 1 h).
  const [creating, setCreating] = useState<{ startMin: number; endMin: number } | null>(null)
  const startCreate = (e: React.PointerEvent) => {
    if (e.button !== 0 || resizingRef.current) return
    if ((e.target as Element).closest('[data-event]')) return   // click on an event
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const m0 = Math.max(0, Math.min(24 * 60 - 15, Math.round(((e.clientY - rect.top) / PX_PER_HOUR * 60) / 15) * 15))
    let cur = { startMin: m0, endMin: m0 + 15 }
    let moved = false
    setCreating(cur)
    const move = (me: PointerEvent) => {
      const m = Math.max(0, Math.min(24 * 60, Math.round(((me.clientY - rect.top) / PX_PER_HOUR * 60) / 15) * 15))
      moved = true
      cur = m >= m0 + 15 ? { startMin: m0, endMin: m } : { startMin: Math.min(m, m0), endMin: m0 + 15 }
      setCreating(cur)
    }
    const up = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up)
      setCreating(null)
      const endMin = moved ? cur.endMin : Math.min(24 * 60, m0 + 60)
      const s = new Date(date); s.setHours(0, cur.startMin, 0, 0)
      const en = new Date(date); en.setHours(0, endMin, 0, 0)
      onRangeCreate(s, en)
    }
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up)
  }

  // Side-by-side layout of the overlaps.
  const layout = useMemo(() => layoutDayEvents(dayEvs), [dayEvs])

  // Secondary timezone (personal preference) + local timezone for the dual hour column.
  const secondaryTimezone = useCalendarStore(s => s.secondaryTimezone)
  const localTz = useMemo(() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone } catch { return 'UTC' } }, [])
  const tzOffsetLabel = (tz: string) => {
    try {
      const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' }).formatToParts(date)
      return parts.find(p => p.type === 'timeZoneName')?.value ?? ''
    } catch { return '' }
  }
  const tzHourLabel = (tz: string, h: number) => {
    const inst = new Date(date); inst.setHours(h, 0, 0, 0)
    try { return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(inst) }
    catch { return '' }
  }

  // "Now" line (today only) — evolves in real time via the tick.
  const now     = useNowTick()
  const showNow = isToday(date)
  const nowTop  = (now.getHours() + now.getMinutes() / 60 + now.getSeconds() / 3600) * 40

  // Times (gutters + events) in DM Sans, digits aligned via `tabular-nums`.
  const MONO = "'DM Sans', ui-sans-serif, system-ui, sans-serif"

  // On mount / day change: snap the scroll to the current hour (today) or to
  // the early morning — instead of opening on midnight.
  const scrollRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const sc = scrollRef.current
    if (!sc) return
    const target = showNow ? Math.max(0, nowTop - sc.clientHeight / 2.5) : 7.5 * PX_PER_HOUR
    sc.scrollTop = target
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date.getTime()])

  // Render one hour-gutter column (hours of a given timezone). `withNow` adds
  // the red dot of the current time (local gutter only).
  const gutter = (labelFor: (h: number) => string, withNow = false) => (
    <div className="border-r border-border relative">
      {hours.map(h => (
        <div key={h} className="h-10 flex items-start justify-end pr-2 -mt-px pt-0.5">
          {h > 0 && <span className="text-[11px] text-text-tertiary -translate-y-1/2" style={{ fontFamily: MONO }}><MonoText>{labelFor(h)}</MonoText></span>}
        </div>
      ))}
      {withNow && showNow && (
        <div className="absolute right-1 z-30 -translate-y-1/2 px-1 py-px rounded bg-danger text-white text-[10px] font-semibold pointer-events-none"
          style={{ top: nowTop, fontFamily: MONO }}>
          <MonoText>{format(now, 'HH:mm')}</MonoText>
        </div>
      )}
    </div>
  )

  // Moon: preference + stable reference date (local noon of the displayed day).
  const moonOn = useCalendarStore(s => s.moonEnabled)
  const moonRefDate = useMemo(() => { const d = new Date(date); d.setHours(12, 0, 0, 0); return d }, [date])

  return (
    <div className="flex-1 overflow-hidden flex flex-col">
      {/* Header */}
      <div className={`border-b border-border shrink-0 py-3 text-center ${weekend ? 'bg-surface-1' : ''}`}>
        <div className={`text-sm font-medium capitalize ${isToday(date) ? 'text-primary' : weekend ? 'text-text-tertiary' : 'text-text-primary'}`}>
          {format(date, 'EEEE d MMMM yyyy', { locale: getDateLocale(i18n.language) })}
        </div>
        {/* Today's weather + moon */}
        {(wx || moonOn) && (
          <div className="flex items-center justify-center gap-2 mt-1 text-sm text-text-secondary">
            {wx && (<>
              <img src={weatherIconUrl(wx.weather_code, true)} alt="" width={24} height={24} style={{ width: 24, height: 24 }} draggable={false} />
              <span>{wmoInfo(wx.weather_code).label}</span>
              <span className="text-text-primary font-medium">{Math.round(wx.temp_max)}°</span>
              <span className="text-text-tertiary">/ {Math.round(wx.temp_min)}°</span>
              {wx.precip_prob_max > 10 && (
                <span className="text-blue-500 text-xs inline-flex items-center gap-0.5">
                  <img src="/weather-icons/drop.svg" alt="" width={15} height={15} style={{ width: 15, height: 15 }} draggable={false} />
                  {wx.precip_prob_max}%
                </span>
              )}
            </>)}
            {/* Today's moon phase (local computation, at noon for stability) */}
            {moonOn && (<>
              {wx && <span className="text-text-tertiary/50">·</span>}
              <MoonIcon phase={moonPhase(moonRefDate)} size={17} />
              <span className="text-xs">{moonPhaseName(moonRefDate, t)}</span>
              <span className="text-text-tertiary text-xs tabular-nums">{Math.round(moonIllumination(moonRefDate) * 100)} %</span>
            </>)}
          </div>
        )}
        {allDayEvs.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-2 px-4 justify-center">
            {allDayEvs.map(ev => {
              const cal   = calMap.get(ev.calendar_id)
              const color = ev.color ?? cal?.color ?? '#4D38DB'
              return (
                <div key={ev.id}
                  onClick={() => onEventClick(ev)}
                  onContextMenu={e => onEventContextMenu(e, ev)}
                  style={{ backgroundColor: color + '20' }}
                  className="text-xs px-2 py-0.5 rounded cursor-pointer hover:opacity-80">
                  {ev.title}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Grille horaire */}
      <div ref={scrollRef} className={`flex-1 overflow-y-auto ${weekend ? 'bg-surface-1/30' : ''}`}>
        {/* Timezone-label strip (only when a secondary timezone is set) */}
        {secondaryTimezone && (
          <div className="grid sticky top-0 z-30 bg-surface-0 border-b border-border"
            style={{ gridTemplateColumns: '52px 52px 1fr' }}>
            <div className="text-[10px] text-text-tertiary text-center py-1 truncate" title={secondaryTimezone}>{tzOffsetLabel(secondaryTimezone)}</div>
            <div className="text-[10px] text-text-tertiary text-center py-1 truncate" title={localTz}>{tzOffsetLabel(localTz)}</div>
            <div />
          </div>
        )}
        <div className="grid" style={{ minHeight: '960px', gridTemplateColumns: secondaryTimezone ? '52px 52px 1fr' : '60px 1fr' }}>
          {/* Secondary-timezone column (left) */}
          {secondaryTimezone && gutter(h => tzHourLabel(secondaryTimezone, h))}
          {/* Local-timezone column (adjacent to the grid) */}
          {gutter(h => `${String(h).padStart(2, '0')}:00`, true)}
          <div className="relative"
            onPointerDown={startCreate}
            onDragOver={e => { if (!draggingRef.current) return; e.preventDefault(); const rect = e.currentTarget.getBoundingClientRect(); const y = e.clientY - rect.top; let m = Math.round((y / 40 * 60) / 15) * 15; m = Math.max(0, Math.min(24 * 60 - 15, m)); setGhostMin(m) }}
            onDrop={e => { const drag = draggingRef.current; if (drag && ghostMin !== null) { e.preventDefault(); const ns = new Date(date); ns.setHours(Math.floor(ghostMin / 60), ghostMin % 60, 0, 0); onEventDrop(drag, ns) } draggingRef.current = null; setDragging(null); setGhostMin(null) }}>
            {/* Hour lines + half-hour dotted line */}
            {hours.map(h => (
              <div key={h} className="h-10 border-b border-border/60 relative">
                <div className="absolute left-0 right-0 top-1/2 border-b border-dashed border-border/40" />
              </div>
            ))}
            {dragging && ghostMin !== null && (
              <div className="absolute left-1 right-1 rounded bg-primary/20 border border-dashed border-primary pointer-events-none z-20"
                style={{ top: ghostMin * 40 / 60, height: ghostHeight }}>
                <div className="text-xs font-medium text-primary px-2" style={{ fontFamily: MONO }}><MonoText>{`${String(Math.floor(ghostMin / 60)).padStart(2, '0')}:${String(ghostMin % 60).padStart(2, '0')}`}</MonoText></div>
              </div>
            )}
            {/* Range being created (dragging on an empty area) */}
            {creating && (
              <div className="absolute left-1 right-1 rounded bg-primary/15 border border-primary pointer-events-none z-20"
                style={{ top: creating.startMin * PX_PER_HOUR / 60, height: Math.max((creating.endMin - creating.startMin) / 60 * PX_PER_HOUR, 10) }}>
                <div className="text-xs font-medium text-primary px-2" style={{ fontFamily: MONO }}>
                  <MonoText>{fmtMin(creating.startMin)}</MonoText> – <MonoText>{fmtMin(creating.endMin)}</MonoText>
                </div>
              </div>
            )}
            {dayEvs.map(ev => {
              const start  = parseISO(ev.starts_at)
              const end    = parseISO(ev.ends_at)
              const cal    = calMap.get(ev.calendar_id)
              const color  = ev.color ?? cal?.color ?? '#4D38DB'
              const past   = end < now
              // During a resize, preview with the minutes being edited.
              const isResizing = resize?.id === ev.id
              const sMin   = isResizing ? resize!.startMin : start.getHours() * 60 + start.getMinutes()
              const eMin   = isResizing ? resize!.endMin   : end.getHours()   * 60 + end.getMinutes()
              const top    = sMin / 60 * PX_PER_HOUR
              const height = Math.max((eMin - sMin) / 60 * PX_PER_HOUR, 20)
              // Overlaps: each event takes its own column within the cluster.
              const pos     = layout.get(ev.id) ?? { leftPct: 0, widthPct: 100 }
              const compact = height < 38   // short block → single line "Title · 09:00"
              const locked  = isCalendarLocked(cal)   // lecture seule / abonnement
              return (
                <div key={ev.id}
                  data-event
                  draggable={!locked}
                  onDragStart={e => { if (locked || resizingRef.current) { e.preventDefault(); return } draggingRef.current = ev; setDragging(ev) }}
                  onDragEnd={() => { draggingRef.current = null; setDragging(null); setGhostMin(null) }}
                  onClick={() => { if (!isResizing) onEventClick(ev) }}
                  onContextMenu={e => onEventContextMenu(e, ev)}
                  title={`${ev.title} · ${fmtMin(sMin)} – ${fmtMin(eMin)}`}
                  style={{
                    top, height,
                    // Past: light tint + colored text (instead of the solid block).
                    backgroundColor: past ? color + '2b' : color,
                    color: past ? color : '#ffffff',
                    opacity: dragging?.id === ev.id ? 0.4 : 1,
                    left: `calc(${pos.leftPct}% + ${4 + apptPad}px)`, width: `calc(${pos.widthPct}% - ${8 + apptPad}px)`,
                  }}
                  className="absolute rounded-md px-2 py-0.5 cursor-pointer overflow-hidden group
                             shadow-sm ring-1 ring-surface-0/60 transition-[box-shadow,filter] duration-100
                             hover:shadow-md hover:brightness-[1.04] hover:z-10 active:cursor-grabbing">
                  {/* Resize handle — top (start time) */}
                  {!locked && <div onPointerDown={startResize(ev, 'top')} onClick={e => e.stopPropagation()} draggable={false}
                    className="absolute top-0 left-0 right-0 h-2 cursor-ns-resize z-10" />}
                  <div className="text-[13px] font-semibold truncate leading-snug">
                    {ev.title}
                    {compact && <span className="font-normal opacity-85 text-xs" style={{ fontFamily: MONO }}> · <MonoText>{fmtMin(sMin)}</MonoText></span>}
                  </div>
                  {!compact && (
                    <div className="text-xs truncate opacity-85" style={{ fontFamily: MONO }}>
                      <MonoText>{fmtMin(sMin)}</MonoText> – <MonoText>{fmtMin(eMin)}</MonoText>
                    </div>
                  )}
                  {!compact && ev.location && <div className="text-xs truncate opacity-80">{ev.location}</div>}
                  {/* Resize handle — bottom (end time) */}
                  {!locked && <div onPointerDown={startResize(ev, 'bottom')} onClick={e => e.stopPropagation()} draggable={false}
                    className="absolute bottom-0 left-0 right-0 h-2 cursor-ns-resize z-10" />}
                </div>
              )
            })}
            {/* Availability bands (appointment schedules) — read-only */}
            {apptEvs.map(ev => {
              const start = parseISO(ev.starts_at), end = parseISO(ev.ends_at)
              const sMin = start.getHours() * 60 + start.getMinutes()
              const eMin = end.getHours() * 60 + end.getMinutes()
              return <AvailabilityStrip key={ev.id} ev={ev} sMin={sMin}
                top={sMin / 60 * PX_PER_HOUR} height={Math.max((eMin - sMin) / 60 * PX_PER_HOUR, 20)}
                onClick={() => onEventClick(ev)} />
            })}
            {/* "Now" line — dot and line vertically centered on the current time */}
            {showNow && (
              <div className="absolute left-0 right-0 z-20 pointer-events-none flex items-center"
                style={{ top: nowTop, transform: 'translateY(-50%)' }}>
                <div className="w-2.5 h-2.5 rounded-full bg-danger -ml-1.5 shrink-0" />
                <div className="flex-1 h-0.5 bg-danger" />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Week view ─────────────────────────────────────────────────────────────────

function WeekView({ date, events, calendars, onEventClick, onEventContextMenu, onEventDrop, onEventResize, onRangeCreate, weatherByDate }: {
  date: Date; events: EventInstance[]; calendars: Calendar[]
  onEventClick: (ev: EventInstance) => void
  onEventContextMenu: (e: React.MouseEvent, ev: EventInstance) => void
  onEventDrop: (ev: EventInstance, newStart: Date) => void
  onEventResize: (ev: EventInstance, newStart: Date, newEnd: Date) => void
  onRangeCreate: (start: Date, end: Date) => void
  weatherByDate: Map<string, DailyWeather>
}) {
  const { t, i18n } = useTranslation('calendar')
  const weekStart = startOfWeek(date, { weekStartsOn: 1 })
  const days      = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i))
  const hours     = Array.from({ length: 24 }, (_, i) => i)
  const calMap    = useMemo(() => new Map(calendars.map(c => [c.id, c])), [calendars])

  const eventsForDay = (day: Date) =>
    events.filter(ev => !ev.all_day && isSameDay(parseISO(ev.starts_at), day))

  const [dragging, setDragging] = useState<EventInstance | null>(null)
  const [ghost, setGhost] = useState<{ dayKey: string; min: number } | null>(null)
  const draggingRef = useRef<EventInstance | null>(null)   // ref synchrone (cf. DayView)
  const ghostHeight = dragging ? Math.max(((parseISO(dragging.ends_at).getTime() - parseISO(dragging.starts_at).getTime()) / 3600000) * 40, 20) : 0

  // Helpers shared with the Day view: timezones, font (DM Sans), real-time current time.
  const PX_PER_HOUR = 40
  const MONO = "'DM Sans', ui-sans-serif, system-ui, sans-serif"
  const now = useNowTick()
  const secondaryTimezone = useCalendarStore(s => s.secondaryTimezone)
  const localTz = useMemo(() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone } catch { return 'UTC' } }, [])
  const tzOffsetLabel = (tz: string) => { try { return new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' }).formatToParts(date).find(p => p.type === 'timeZoneName')?.value ?? '' } catch { return '' } }
  const tzHourLabel = (tz: string, h: number) => { const inst = new Date(date); inst.setHours(h, 0, 0, 0); try { return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(inst) } catch { return '' } }
  const fmtMin = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
  const minOf = (iso: string) => { const d = parseISO(iso); return d.getHours() * 60 + d.getMinutes() }
  const nowTop = (now.getHours() + now.getMinutes() / 60 + now.getSeconds() / 3600) * PX_PER_HOUR

  // Vertical resize (top/bottom handles → start/end) — per day.
  const [resize, setResize] = useState<{ id: string; startMin: number; endMin: number } | null>(null)
  const resizingRef = useRef(false)
  const startResize = (ev: EventInstance, day: Date, edge: 'top' | 'bottom') => (e: React.PointerEvent) => {
    e.stopPropagation(); e.preventDefault(); resizingRef.current = true
    const s0 = minOf(ev.starts_at), e0 = minOf(ev.ends_at)
    let cur = { startMin: s0, endMin: e0 }
    setResize({ id: ev.id, ...cur })
    const move = (me: PointerEvent) => {
      const d = Math.round(((me.clientY - e.clientY) / PX_PER_HOUR * 60) / 15) * 15
      if (edge === 'top') cur = { startMin: Math.max(0, Math.min(e0 - 15, s0 + d)), endMin: e0 }
      else                cur = { startMin: s0, endMin: Math.min(24 * 60, Math.max(s0 + 15, e0 + d)) }
      setResize({ id: ev.id, ...cur })
    }
    const up = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up)
      resizingRef.current = false; setResize(null)
      if (cur.startMin !== s0 || cur.endMin !== e0) {
        const ns = new Date(day); ns.setHours(Math.floor(cur.startMin / 60), cur.startMin % 60, 0, 0)
        const ne = new Date(day); ne.setHours(Math.floor(cur.endMin / 60), cur.endMin % 60, 0, 0)
        onEventResize(ev, ns, ne)
      }
    }
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up)
  }

  // Creation by dragging on an empty column area (single click = 1 h).
  const [creating, setCreating] = useState<{ dayKey: string; startMin: number; endMin: number } | null>(null)
  const startCreate = (day: Date) => (e: React.PointerEvent) => {
    if (e.button !== 0 || resizingRef.current) return
    if ((e.target as Element).closest('[data-event]')) return
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const dayKey = day.toISOString()
    const m0 = Math.max(0, Math.min(24 * 60 - 15, Math.round(((e.clientY - rect.top) / PX_PER_HOUR * 60) / 15) * 15))
    let cur = { startMin: m0, endMin: m0 + 15 }
    let moved = false
    setCreating({ dayKey, ...cur })
    const move = (me: PointerEvent) => {
      const m = Math.max(0, Math.min(24 * 60, Math.round(((me.clientY - rect.top) / PX_PER_HOUR * 60) / 15) * 15))
      moved = true
      cur = m >= m0 + 15 ? { startMin: m0, endMin: m } : { startMin: Math.min(m, m0), endMin: m0 + 15 }
      setCreating({ dayKey, ...cur })
    }
    const up = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up)
      setCreating(null)
      const endMin = moved ? cur.endMin : Math.min(24 * 60, m0 + 60)
      const s = new Date(day); s.setHours(0, cur.startMin, 0, 0)
      const en = new Date(day); en.setHours(0, endMin, 0, 0)
      onRangeCreate(s, en)
    }
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up)
  }

  const gutterCols = secondaryTimezone ? '52px 52px' : '60px'
  const gridCols = `${gutterCols} repeat(7, minmax(0, 1fr))`
  const showNowWeek = days.some(d => isToday(d))
  // Moon: principal-phase marker on the header of the day concerned.
  const moonOn = useCalendarStore(s => s.moonEnabled)
  const moonDay = (d: Date) => (moonOn ? principalPhaseOfDay(d) : null)
  const gutter = (labelFor: (h: number) => string, withNow = false) => (
    <div className="border-r border-border relative">
      {hours.map(h => (
        <div key={h} className="h-10 flex items-start justify-end pr-2 -mt-px pt-0.5">
          {h > 0 && <span className="text-[11px] text-text-tertiary -translate-y-1/2" style={{ fontFamily: MONO }}><MonoText>{labelFor(h)}</MonoText></span>}
        </div>
      ))}
      {withNow && showNowWeek && (
        <div className="absolute right-1 z-30 -translate-y-1/2 px-1 py-px rounded bg-danger text-white text-[10px] font-semibold pointer-events-none"
          style={{ top: nowTop, fontFamily: MONO }}>
          <MonoText>{format(now, 'HH:mm')}</MonoText>
        </div>
      )}
    </div>
  )

  // Initial scroll: current time (when the week contains today), otherwise
  // early morning.
  const scrollRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const sc = scrollRef.current
    if (!sc) return
    sc.scrollTop = showNowWeek ? Math.max(0, nowTop - sc.clientHeight / 2.5) : 7.5 * PX_PER_HOUR
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weekStart.getTime()])

  return (
    <div className="flex-1 overflow-hidden flex flex-col">
      {/* Day headers (+ timezone labels in the gutter(s)) */}
      <div className="grid border-b border-border shrink-0" style={{ gridTemplateColumns: gridCols }}>
        {secondaryTimezone && (
          <div className="text-[10px] text-text-tertiary text-center self-end pb-2 truncate" title={secondaryTimezone}>{tzOffsetLabel(secondaryTimezone)}</div>
        )}
        <div className="text-[10px] text-text-tertiary text-center self-end pb-2 truncate" title={localTz}>{tzOffsetLabel(localTz)}</div>
        {days.map(day => {
          const weekend = isWeekend(day)
          const wx      = weatherByDate.get(format(day, 'yyyy-MM-dd')) ?? null
          return (
            <div key={day.toISOString()}
              className={`py-2 text-center ${weekend ? 'bg-surface-1' : ''}`}>
              <div className={`text-xs uppercase ${weekend ? 'text-text-tertiary' : 'text-text-secondary'}`}>
                {format(day, 'EEE', { locale: getDateLocale(i18n.language) })}
              </div>
              <div className={`w-8 h-8 mx-auto flex items-center justify-center rounded-full text-sm font-medium
                               ${isToday(day) ? 'bg-primary text-white' : weekend ? 'text-text-tertiary' : 'text-text-primary'}`}>
                {format(day, 'd')}
              </div>
              {/* Compact weather + moon-phase marker (principal-phase days) */}
              {(wx || moonDay(day)) && (
                <div className="flex items-center justify-center gap-1 mt-0.5">
                  {wx && (<>
                    <img src={weatherIconUrl(wx.weather_code, true)} alt="" width={20} height={20} style={{ width: 20, height: 20 }} draggable={false} />
                    <span className="text-[10px] text-text-secondary">{Math.round(wx.temp_max)}°/{Math.round(wx.temp_min)}°</span>
                  </>)}
                  {(() => { const ph = moonDay(day); return ph
                    ? <PrincipalMoonIcon phase={ph} size={14} title={principalPhaseName(ph, t)} className="shrink-0" />
                    : null })()}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* Grille horaire */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        <div className="grid" style={{ minHeight: '960px', gridTemplateColumns: gridCols }}>
          {secondaryTimezone && gutter(h => tzHourLabel(secondaryTimezone, h))}
          {gutter(h => `${String(h).padStart(2, '0')}:00`, true)}
          {days.map(day => {
            const weekend  = isWeekend(day)
            const dayEvs0  = eventsForDay(day)
            const apptEvs  = dayEvs0.filter(ev => ev.event_id.startsWith(APPT_PREFIX))
            const dayEvs   = dayEvs0.filter(ev => !ev.event_id.startsWith(APPT_PREFIX))
            const apptPad  = apptEvs.length ? APPT_GUTTER : 0
            const layout   = layoutDayEvents(dayEvs)
            return (
              <div key={day.toISOString()}
                onPointerDown={startCreate(day)}
                onDragOver={e => { if (!draggingRef.current) return; e.preventDefault(); const rect = e.currentTarget.getBoundingClientRect(); const y = e.clientY - rect.top; let m = Math.round((y / 40 * 60) / 15) * 15; m = Math.max(0, Math.min(24 * 60 - 15, m)); setGhost({ dayKey: day.toISOString(), min: m }) }}
                onDrop={e => { const drag = draggingRef.current; if (drag && ghost) { e.preventDefault(); const ns = new Date(day); ns.setHours(Math.floor(ghost.min / 60), ghost.min % 60, 0, 0); onEventDrop(drag, ns) } draggingRef.current = null; setDragging(null); setGhost(null) }}
                className={`border-r border-border relative ${weekend ? 'bg-surface-1/40' : ''}`}>
                {/* Hour lines + half-hour dotted line */}
                {hours.map(h => (
                  <div key={h} className="h-10 border-b border-border/60 relative">
                    <div className="absolute left-0 right-0 top-1/2 border-b border-dashed border-border/40" />
                  </div>
                ))}
                {dragging && ghost?.dayKey === day.toISOString() && (
                  <div className="absolute left-0.5 right-0.5 rounded bg-primary/20 border border-dashed border-primary pointer-events-none z-20"
                    style={{ top: ghost.min * 40 / 60, height: ghostHeight }}>
                    <div className="text-[10px] font-medium text-primary px-1" style={{ fontFamily: MONO }}><MonoText>{`${String(Math.floor(ghost.min / 60)).padStart(2, '0')}:${String(ghost.min % 60).padStart(2, '0')}`}</MonoText></div>
                  </div>
                )}
                {/* Range being created (dragging on an empty area) */}
                {creating?.dayKey === day.toISOString() && (
                  <div className="absolute left-0.5 right-0.5 rounded bg-primary/15 border border-primary pointer-events-none z-20"
                    style={{ top: creating.startMin * PX_PER_HOUR / 60, height: Math.max((creating.endMin - creating.startMin) / 60 * PX_PER_HOUR, 10) }}>
                    <div className="text-[10px] font-medium text-primary px-1" style={{ fontFamily: MONO }}>
                      <MonoText>{fmtMin(creating.startMin)}</MonoText> – <MonoText>{fmtMin(creating.endMin)}</MonoText>
                    </div>
                  </div>
                )}
                {dayEvs.map(ev => {
                  const start  = parseISO(ev.starts_at)
                  const end    = parseISO(ev.ends_at)
                  const cal    = calMap.get(ev.calendar_id)
                  const color  = ev.color ?? cal?.color ?? '#4D38DB'
                  const past   = end < now
                  const isResizing = resize?.id === ev.id
                  const sMin   = isResizing ? resize!.startMin : start.getHours() * 60 + start.getMinutes()
                  const eMin   = isResizing ? resize!.endMin   : end.getHours()   * 60 + end.getMinutes()
                  const top    = sMin / 60 * PX_PER_HOUR
                  const height = Math.max((eMin - sMin) / 60 * PX_PER_HOUR, 20)
                  const pos     = layout.get(ev.id) ?? { leftPct: 0, widthPct: 100 }
                  const compact = height < 34   // bloc court → une seule ligne
                  const locked  = isCalendarLocked(cal)   // lecture seule / abonnement
                  return (
                    <div key={ev.id}
                      data-event
                      draggable={!locked}
                      onDragStart={e => { if (locked || resizingRef.current) { e.preventDefault(); return } draggingRef.current = ev; setDragging(ev) }}
                      onDragEnd={() => { draggingRef.current = null; setDragging(null); setGhost(null) }}
                      onClick={() => { if (!isResizing) onEventClick(ev) }}
                      onContextMenu={e => onEventContextMenu(e, ev)}
                      title={`${ev.title} · ${fmtMin(sMin)} – ${fmtMin(eMin)}`}
                      style={{
                        top, height,
                        backgroundColor: past ? color + '2b' : color,
                        color: past ? color : '#ffffff',
                        opacity: dragging?.id === ev.id ? 0.4 : 1,
                        left: `calc(${pos.leftPct}% + ${2 + apptPad}px)`, width: `calc(${pos.widthPct}% - ${4 + apptPad}px)`,
                      }}
                      className="absolute rounded-md px-1.5 py-0.5 cursor-pointer overflow-hidden
                                 shadow-sm ring-1 ring-surface-0/60 transition-[box-shadow,filter] duration-100
                                 hover:shadow-md hover:brightness-[1.04] hover:z-10 active:cursor-grabbing">
                      {!locked && <div onPointerDown={startResize(ev, day, 'top')} onClick={e => e.stopPropagation()} draggable={false}
                        className="absolute top-0 left-0 right-0 h-1.5 cursor-ns-resize z-10" />}
                      <div className="text-xs font-semibold truncate leading-snug">
                        {ev.title}
                        {compact && <span className="font-normal opacity-85 text-[10px]" style={{ fontFamily: MONO }}> · <MonoText>{fmtMin(sMin)}</MonoText></span>}
                      </div>
                      {!compact && (
                        <div className="text-[10px] truncate opacity-85" style={{ fontFamily: MONO }}><MonoText>{fmtMin(sMin)}</MonoText> – <MonoText>{fmtMin(eMin)}</MonoText></div>
                      )}
                      {!locked && <div onPointerDown={startResize(ev, day, 'bottom')} onClick={e => e.stopPropagation()} draggable={false}
                        className="absolute bottom-0 left-0 right-0 h-1.5 cursor-ns-resize z-10" />}
                    </div>
                  )
                })}
                {/* Availability bands (appointment schedules) — read-only */}
                {apptEvs.map(ev => {
                  const start = parseISO(ev.starts_at), end = parseISO(ev.ends_at)
                  const sMin = start.getHours() * 60 + start.getMinutes()
                  const eMin = end.getHours() * 60 + end.getMinutes()
                  return <AvailabilityStrip key={ev.id} ev={ev} sMin={sMin}
                    top={sMin / 60 * PX_PER_HOUR} height={Math.max((eMin - sMin) / 60 * PX_PER_HOUR, 20)}
                    onClick={() => onEventClick(ev)} />
                })}
                {/* "Now" line in the current day's column */}
                {isToday(day) && (
                  <div className="absolute left-0 right-0 z-20 pointer-events-none flex items-center"
                    style={{ top: nowTop, transform: 'translateY(-50%)' }}>
                    <div className="w-2 h-2 rounded-full bg-danger -ml-1 shrink-0" />
                    <div className="flex-1 h-0.5 bg-danger" />
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

// ── Month view ────────────────────────────────────────────────────────────────

function MonthView({ month, events, calendars, onDayClick, onEventClick, onEventContextMenu, onEventDrop, weatherByDate, overlayByDate }: {
  month: Date; events: EventInstance[]; calendars: Calendar[]
  onDayClick: (day: Date) => void
  onEventClick: (ev: EventInstance) => void
  onEventContextMenu: (e: React.MouseEvent, ev: EventInstance) => void
  onEventDrop: (ev: EventInstance, newStart: Date) => void
  weatherByDate: Map<string, DailyWeather>
  overlayByDate: Map<string, CalendarOverlayItem[]>
}) {
  const { t, i18n } = useTranslation('calendar')
  const days   = useMemo(() => calendarGrid(month), [month])
  const weeks  = Math.max(1, Math.ceil(days.length / 7))
  const calMap = useMemo(() => new Map(calendars.map(c => [c.id, c])), [calendars])
  const weekdaysShort = useMemo(() => {
    const loc = getDateLocale(i18n.language)
    const base = startOfWeek(new Date(), { weekStartsOn: 1 })
    return Array.from({ length: 7 }, (_, i) => format(addDays(base, i), 'EEE', { locale: loc }))
  }, [i18n.language])

  const eventsForDay = (day: Date) =>
    events.filter(ev => isSameDay(parseISO(ev.starts_at), day))

  // "Now" reference (real time) to dim events already past.
  const now = useNowTick(60_000)

  // Moon: principal-phase marker on the day concerned (paper-calendar style).
  const moonOn = useCalendarStore(s => s.moonEnabled)
  const moonDay = (d: Date) => (moonOn ? principalPhaseOfDay(d) : null)

  return (
    <div className="flex-1 overflow-hidden flex flex-col">
      {/* Month title — visible ONLY in print (the toolbar, which carries the
          title on screen, is hidden when printing). */}
      <div className="print-only mb-2 text-center text-xl font-bold text-black">
        {format(month, 'MMMM yyyy', { locale: getDateLocale(i18n.language) })}
      </div>
      {/* Weekday headers */}
      <div className="grid grid-cols-7 border-b border-border">
        {weekdaysShort.map((d, i) => (
          <div key={i}
            className={`py-2 text-center text-xs font-medium uppercase
                        ${i >= 5 ? 'text-text-tertiary' : 'text-text-tertiary'}`}>
            {d}
          </div>
        ))}
      </div>

      {/* Day grid — dynamic row count (4, 5 or 6 weeks) to fill the whole height */}
      <div className="flex-1 grid grid-cols-7 overflow-hidden"
        style={{ gridTemplateRows: `repeat(${weeks}, minmax(0, 1fr))` }}>
        {days.map(day => {
          const dayEvs  = eventsForDay(day)
          const inMonth = isSameMonth(day, month)
          const today   = isToday(day)
          const weekend = isWeekend(day)
          const wx      = inMonth ? (weatherByDate.get(format(day, 'yyyy-MM-dd')) ?? null) : null

          return (
            <div key={day.toISOString()} onClick={() => onDayClick(day)}
              onDragOver={e => e.preventDefault()}
              onDrop={e => { const id = e.dataTransfer.getData('text/plain'); const found = events.find(x => x.id === id); if (found) { const os = parseISO(found.starts_at); const ns = new Date(day); ns.setHours(os.getHours(), os.getMinutes(), 0, 0); onEventDrop(found, ns) } }}
              className={`border-r border-b border-border p-1 cursor-pointer min-h-0 overflow-hidden
                          transition-colors hover:bg-primary/5 print:min-h-[96px] print:break-inside-avoid
                          ${!inMonth ? 'bg-surface-2' : weekend ? 'bg-surface-1/60' : ''}`}>
              <div className="flex items-center justify-between mb-0.5">
                <span className={`w-7 h-7 flex items-center justify-center text-sm rounded-full font-medium
                                  ${today
                                    ? 'bg-primary text-white'
                                    : !inMonth
                                    ? 'text-text-tertiary/40'
                                    : weekend
                                    ? 'text-text-tertiary'
                                    : 'text-text-primary'}`}>
                  {format(day, 'd')}
                </span>
                {/* Moon-phase marker + compact weather in the cell */}
                {(wx || (inMonth && moonDay(day))) && (
                  <span className="flex items-center gap-1 text-[10px] text-text-tertiary leading-none pr-0.5">
                    {inMonth && (() => { const ph = moonDay(day); return ph
                      ? <PrincipalMoonIcon phase={ph} size={13} title={principalPhaseName(ph, t)} className="shrink-0" />
                      : null })()}
                    {wx && (<>
                      <img src={weatherIconUrl(wx.weather_code, true)} alt="" width={16} height={16} style={{ width: 16, height: 16 }} draggable={false} />
                      <span>{Math.round(wx.temp_max)}°</span>
                    </>)}
                  </span>
                )}
              </div>
              <div className="space-y-0.5 overflow-hidden">
                {dayEvs.slice(0, 4).map(ev => {
                  const cal    = calMap.get(ev.calendar_id)
                  const color  = ev.color ?? cal?.color ?? '#4D38DB'
                  const past   = parseISO(ev.ends_at) < now
                  const locked = isCalendarLocked(cal)
                  // Same block style as the day/week views: solid (white text)
                  // for upcoming, tinted (colored text) for past.
                  return (
                    <div key={ev.id}
                      draggable={!locked}
                      onDragStart={e => { if (locked) { e.preventDefault(); return } e.stopPropagation(); e.dataTransfer.setData('text/plain', ev.id); e.dataTransfer.effectAllowed = 'move' }}
                      onClick={e => { e.stopPropagation(); onEventClick(ev) }}
                      onContextMenu={e => { e.stopPropagation(); onEventContextMenu(e, ev) }}
                      title={ev.title}
                      style={{ backgroundColor: past ? color + '2b' : color, color: past ? color : '#fff' }}
                      className="flex items-center gap-1 text-xs px-1.5 py-0.5 rounded-md cursor-pointer truncate
                                 shadow-sm hover:brightness-[1.05] hover:shadow transition-[filter,box-shadow]">
                      {!ev.all_day && (
                        <span className="shrink-0 opacity-85 text-[11px]">
                          <MonoText>{format(parseISO(ev.starts_at), 'HH:mm')}</MonoText>
                        </span>
                      )}
                      <span className="truncate min-w-0 font-medium">{ev.title}</span>
                    </div>
                  )
                })}
                {dayEvs.length > 4 && (
                  <div className="text-xs text-text-tertiary px-1">{t('more_events', { count: dayEvs.length - 4 })}</div>
                )}
                {/* Items overlaid by other modules (generic extension point) —
                    same block style as events: solid (to do) or tinted +
                    colored text (done). */}
                {(overlayByDate.get(format(day, 'yyyy-MM-dd')) ?? []).slice(0, 2).map(it => {
                  const tcolor = it.color ?? '#80868b'
                  const chip = (
                    <div
                      style={{ backgroundColor: it.done ? tcolor + '2b' : tcolor, color: it.done ? tcolor : '#fff' }}
                      className="flex items-center gap-1 text-xs px-1.5 py-0.5 rounded-md truncate font-medium
                                 shadow-sm hover:brightness-[1.05] hover:shadow transition-[filter,box-shadow]"
                      title={it.title}>
                      <Check size={11} className={`shrink-0 ${it.done ? '' : 'opacity-70'}`} strokeWidth={3} />
                      <span className={`truncate min-w-0 ${it.done ? 'line-through' : ''}`}>{it.title}</span>
                    </div>
                  )
                  return it.link
                    ? <Link key={it.id} to={it.link} onClick={(e) => e.stopPropagation()} className="block">{chip}</Link>
                    : <div key={it.id}>{chip}</div>
                })}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Year view — mini-calendrier mensuel ───────────────────────────────────────

function MiniMonth({ month, events, overlayByDate, onMonthClick, selectedDay, onSelectDay }: {
  month: Date; events: EventInstance[]; overlayByDate: Map<string, CalendarOverlayItem[]>
  onMonthClick: (m: Date) => void
  selectedDay: Date | null
  onSelectDay: (d: Date, rect: DOMRect) => void
}) {
  const { t, i18n } = useTranslation('calendar')
  const days = calendarGrid(month)
  // Day letters (localized) — enough at the scale of a year card.
  const weekdayLetters = useMemo(() => {
    const lc = getDateLocale(i18n.language)
    const base = startOfWeek(new Date(), { weekStartsOn: 1 })
    return Array.from({ length: 7 }, (_, i) => format(addDays(base, i), 'EEEEE', { locale: lc }))
  }, [i18n.language])
  // Indicator colors (events + tasks) per day, deduplicated: one dot per
  // CALENDAR/source, not per event.
  const colorsByDay = useMemo(() => {
    const m = new Map<string, string[]>()
    const add = (k: string, c: string) => {
      const a = m.get(k)
      if (!a) m.set(k, [c])
      else if (!a.includes(c)) a.push(c)
    }
    events.forEach(ev => { if (isSameMonth(parseISO(ev.starts_at), month)) add(format(parseISO(ev.starts_at), 'yyyy-MM-dd'), ev.color ?? '#4D38DB') })
    overlayByDate.forEach((items, k) => { if (k.startsWith(format(month, 'yyyy-MM'))) items.forEach(it => add(k, it.color ?? '#80868b')) })
    return m
  }, [events, overlayByDate, month])

  const monthEventCount = useMemo(
    () => events.filter(ev => isSameMonth(parseISO(ev.starts_at), month)).length,
    [events, month])
  const isCurrentMonth = isSameMonth(new Date(), month)

  return (
    <div className="px-2.5 pt-2.5 pb-1.5 flex flex-col h-full min-h-0">
      {/* Header: month (→ month view) + month workload */}
      <button onClick={() => onMonthClick(month)}
        title={t('year_open_month', { defaultValue: 'Ouvrir la vue mensuelle' })}
        className="group/mm flex items-baseline justify-between gap-2 mb-1 px-1 w-full text-left shrink-0">
        <span className={`text-[15px] font-semibold capitalize transition-colors
          ${isCurrentMonth ? 'text-primary' : 'text-text-primary group-hover/mm:text-primary'}`}>
          {format(month, 'MMMM', { locale: getDateLocale(i18n.language) })}
        </span>
        {monthEventCount > 0 && (
          <span className="text-[10px] tabular-nums px-1.5 py-px rounded-full bg-surface-2 text-text-secondary
                           group-hover/mm:bg-primary/10 group-hover/mm:text-primary transition-colors">
            {monthEventCount}
          </span>
        )}
      </button>
      <div className="grid grid-cols-7 mb-0.5 shrink-0">
        {weekdayLetters.map((d, i) => (
          <div key={i} className={`text-center text-[10px] font-medium uppercase ${i >= 5 ? 'text-text-tertiary/50' : 'text-text-tertiary'}`}>
            {d}
          </div>
        ))}
      </div>
      {/* Days: out-of-month days hidden (airy grid, classic year-view style);
          number + color dots (one per calendar/source). The detail opens in a
          FLOATING box (see YearView), so the grid fills the card. */}
      <div className="grid grid-cols-7 flex-1 auto-rows-fr min-h-0">
        {days.map(day => {
          const inMonth = isSameMonth(day, month)
          if (!inMonth) return <span key={day.toISOString()} aria-hidden />
          const today   = isToday(day)
          const weekend = isWeekend(day)
          const isSel   = selectedDay != null && isSameDay(day, selectedDay)
          const dots    = colorsByDay.get(format(day, 'yyyy-MM-dd')) ?? []
          return (
            <button key={day.toISOString()} type="button"
              onClick={e => onSelectDay(day, e.currentTarget.getBoundingClientRect())}
              className="flex flex-col items-center justify-center min-h-0 outline-none group/day">
              <span className={`text-xs w-6 h-6 flex items-center justify-center rounded-full transition-colors
                ${today   ? 'bg-primary text-white font-bold shadow-sm'
                  : isSel   ? 'ring-2 ring-primary text-primary font-semibold'
                  : weekend ? 'text-text-tertiary group-hover/day:bg-surface-2'
                  : 'text-text-primary group-hover/day:bg-surface-2'}`}>
                {format(day, 'd')}
              </span>
              <span className="flex items-center justify-center gap-[3px] h-1">
                {dots.slice(0, 3).map((c, i) => (
                  <span key={i} className="w-1 h-1 rounded-full" style={{ backgroundColor: c }} />
                ))}
                {dots.length > 3 && <span className="text-[8px] leading-none text-text-tertiary">+</span>}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

// FLOATING box (portal) listing the events and tasks of a day selected in the Year view.
function DayPopover({ day, rect, events, overlayByDate, onClose, onEventClick, onCreate }: {
  day: Date; rect: DOMRect
  events: EventInstance[]
  overlayByDate: Map<string, CalendarOverlayItem[]>
  onClose: () => void
  onEventClick: (ev: EventInstance) => void
  onCreate?: (day: Date) => void
}) {
  const { t, i18n } = useTranslation('calendar')
  const loc = getDateLocale(i18n.language)
  const dayEvents = events.filter(ev => isSameDay(parseISO(ev.starts_at), day))
    .sort((a, b) => a.starts_at.localeCompare(b.starts_at))
  const tasks = overlayByDate.get(format(day, 'yyyy-MM-dd')) ?? []

  const W = 264
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1280
  const vh = typeof window !== 'undefined' ? window.innerHeight : 800
  const placeAbove = rect.bottom + 240 > vh
  const left = Math.max(8, Math.min(rect.left + rect.width / 2 - W / 2, vw - W - 8))
  const arrowLeft = Math.max(12, Math.min(rect.left + rect.width / 2 - left, W - 12))
  const pos: React.CSSProperties = placeAbove
    ? { bottom: vh - rect.top + 8, left, width: W }
    : { top: rect.bottom + 8, left, width: W }

  return createPortal(
    <>
      <div className="fixed inset-0 z-[55]" onClick={onClose} />
      <div className="cal-details fixed z-[56] bg-surface-0 rounded-xl shadow-xl border border-border p-3"
        style={pos} onClick={e => e.stopPropagation()}>
        <span className={`cal-arrow absolute w-2.5 h-2.5 rotate-45 bg-surface-0 ${placeAbove ? '-bottom-1.5 border-r border-b' : '-top-1.5 border-l border-t'} border-border`}
          style={{ left: arrowLeft - 5 }} />
        {/* Header: big number + day, and quick creation on the right */}
        <div className="flex items-center gap-2 mb-2">
          <span className={`w-9 h-9 shrink-0 flex items-center justify-center rounded-full text-base font-bold
            ${isToday(day) ? 'bg-primary text-white' : 'bg-surface-1 text-text-primary'}`}>
            {format(day, 'd')}
          </span>
          <div className="flex-1 min-w-0 leading-tight">
            <div className="text-xs font-semibold text-text-primary capitalize truncate">
              {format(day, 'EEEE', { locale: loc })}
            </div>
            <div className="text-[11px] text-text-tertiary capitalize truncate">
              {format(day, 'MMMM yyyy', { locale: loc })}
            </div>
          </div>
          {onCreate && (
            <button
              onClick={() => { onCreate(day); onClose() }}
              title={t('year_create_here', { defaultValue: 'Créer un événement ce jour' })}
              className="w-7 h-7 shrink-0 flex items-center justify-center rounded-full text-text-tertiary
                         hover:bg-primary/10 hover:text-primary transition-colors">
              <Plus size={15} />
            </button>
          )}
        </div>
        <div className="space-y-1 max-h-56 overflow-y-auto">
          {dayEvents.length === 0 && tasks.length === 0 && (
            <div className="text-xs text-text-tertiary italic">{t('year_no_events', { defaultValue: 'Aucun événement' })}</div>
          )}
          {dayEvents.map((ev, i) => (
            <button key={ev.id} onClick={() => { onEventClick(ev); onClose() }}
              className="cal-event w-full flex items-center gap-1.5 text-xs text-left rounded px-1 py-0.5 hover:bg-surface-1"
              style={{ ['--i' as string]: i } as React.CSSProperties}>
              <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: ev.color ?? '#4D38DB' }} />
              {!ev.all_day && <span className="text-text-tertiary shrink-0"><MonoText>{format(parseISO(ev.starts_at), 'HH:mm')}</MonoText></span>}
              <span className="truncate text-text-primary">{ev.title}</span>
            </button>
          ))}
          {tasks.map((it, i) => {
            const row = (
              <div className="cal-event flex items-center gap-1.5 text-xs rounded px-1 py-0.5 hover:bg-surface-1"
                style={{ ['--i' as string]: (dayEvents.length + i) } as React.CSSProperties}>
                <span className="w-1.5 h-1.5 rounded-[2px] shrink-0" style={{ backgroundColor: it.color ?? '#80868b' }} />
                <span className={`truncate ${it.done ? 'line-through text-text-tertiary' : 'text-text-primary'}`}>{it.title}</span>
              </div>
            )
            return it.link
              ? <Link key={it.id} to={it.link} onClick={onClose} className="block">{row}</Link>
              : <div key={it.id}>{row}</div>
          })}
        </div>
      </div>
    </>,
    document.body,
  )
}

function YearView({ year, events, overlayByDate, onMonthClick, onEventClick, onDayCreate }: {
  year: Date; events: EventInstance[]
  overlayByDate: Map<string, CalendarOverlayItem[]>
  onMonthClick: (month: Date) => void
  onEventClick: (ev: EventInstance) => void
  onDayCreate?: (day: Date) => void
}) {
  const months = useMemo(
    () => Array.from({ length: 12 }, (_, i) => new Date(year.getFullYear(), i, 1)),
    [year],
  )
  // Selected day + anchor (button rect) to position the floating box.
  const [sel, setSel] = useState<{ day: Date; rect: DOMRect } | null>(null)
  const selectDay = (day: Date, rect: DOMRect) =>
    setSel(prev => (prev && isSameDay(prev.day, day) ? null : { day, rect }))
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') setSel(null) }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [])
  return (
    <div className="flex-1 overflow-y-auto p-4 md:p-6 bg-surface-1/40">
      {/* h-full + auto-rows-fr: the months fill the height (the detail box
          floats above through a portal, so it doesn't disturb this grid). */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4 h-full auto-rows-fr min-h-[560px]">
        {months.map(m => {
          const current = isSameMonth(new Date(), m)
          return (
            <div key={m.toISOString()}
              className={`rounded-2xl bg-surface-0 flex flex-col min-h-0 overflow-hidden transition-shadow hover:shadow-md
                ${current ? 'border border-primary/40 ring-1 ring-primary/20 shadow-sm' : 'border border-border'}`}>
              <MiniMonth month={m} events={events} overlayByDate={overlayByDate} onMonthClick={onMonthClick}
                selectedDay={sel?.day ?? null} onSelectDay={selectDay} />
            </div>
          )
        })}
      </div>
      {sel && (
        <DayPopover day={sel.day} rect={sel.rect} events={events} overlayByDate={overlayByDate}
          onClose={() => setSel(null)} onEventClick={onEventClick} onCreate={onDayCreate} />
      )}
    </div>
  )
}

// ── Search results view ───────────────────────────────────────────────────────

function SearchResultsView({
  calendars,
  onEventClick,
}: {
  calendars: Calendar[]
  onEventClick: (ev: EventInstance) => void
}) {
  const { t, i18n } = useTranslation('calendar')
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
                      : <>{format(start, 'd MMM, ', { locale: getDateLocale(i18n.language) })}<MonoText>{format(start, 'HH:mm')}</MonoText> – <MonoText>{format(end, 'HH:mm')}</MonoText></>}
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

// ── Main ─────────────────────────────────────────────────────────────────────

export default function CalendarApp() {
  const { t } = useTranslation('calendar')
  const {
    viewMode, setViewMode,
    currentDate, setCurrentDate,
    hiddenCalendarIds,
    pendingCreateDate, setPendingCreate,
    searchQuery, searchApplied,
    weatherEnabled, weatherLocationId,
  } = useCalendarStore()

  const qc = useQueryClient()

  // ── Synchro vue ↔ URL (/calendar/day, /calendar/week, /calendar/month, /calendar/year) ──
  const { view }   = useParams()
  const navigate   = useNavigate()
  const location   = useLocation()
  const VIEW_PATHS: ViewMode[] = ['day', 'week', 'month', 'year']

  // URL → store : applique la vue de l'URL ; redirige /calendar (ou vue inconnue) vers la vue courante.
  useEffect(() => {
    if (view) {
      if ((VIEW_PATHS as string[]).includes(view)) {
        if (view !== viewMode) setViewMode(view as ViewMode)
      } else {
        navigate(`/calendar/${viewMode}`, { replace: true })   // vue inconnue → corrige l'URL
      }
    } else if (location.pathname.replace(/\/+$/, '') === '/calendar') {
      navigate(`/calendar/${viewMode}`, { replace: true })     // bare /calendar → reflect the view
    }
  }, [view, location.pathname]) // eslint-disable-line react-hooks/exhaustive-deps

  // store → URL: a view change (toolbar, year→month drill-down…) updates the URL.
  // The 1st render is ignored so a deep URL (e.g. direct access to /calendar/day)
  // is not clobbered before the URL→store effect has synced the store.
  const viewSyncMounted = useRef(false)
  useEffect(() => {
    if (!viewSyncMounted.current) { viewSyncMounted.current = true; return }
    if (view && (VIEW_PATHS as string[]).includes(view) && view !== viewMode) {
      navigate(`/calendar/${viewMode}`)
    }
  }, [viewMode]) // eslint-disable-line react-hooks/exhaustive-deps

  // Deep link `?date=YYYY-MM-DD` (used by the `calendar.event` data card and the
  // `openDate` service): position the view on that day, then drop the param so a
  // later navigation inside the module isn't stuck on it.
  useEffect(() => {
    const dateStr = new URLSearchParams(location.search).get('date')
    if (!dateStr) return
    const d = new Date(`${dateStr}T00:00:00`)
    if (!Number.isNaN(d.getTime())) setCurrentDate(d)
    navigate(location.pathname, { replace: true })
  }, [location.search]) // eslint-disable-line react-hooks/exhaustive-deps

  const [createDay,     setCreateDay]     = useState<Date | null>(null)
  // Preselected range end (creation by dragging on the grid).
  const [createEnd,     setCreateEnd]     = useState<Date | null>(null)
  const [selectedEvent, setSelectedEvent] = useState<EventInstance | null>(null)
  const [editingEvent,  setEditingEvent]  = useState<EventInstance | null>(null)
  const [ctxMenu,       setCtxMenu]       = useState<CtxMenuState | null>(null)

  // Creation by dragging on the day/week views: opens the prefilled editor.
  const handleRangeCreate = useCallback((start: Date, end: Date) => {
    setCreateEnd(end)
    setCreateDay(start)
  }, [])

  // ── Keyboard shortcuts ───────────────────────────────────────────────────────
  // T = today · ←/→ = previous/next period · 1-4 = views · C = create.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return
      const el = document.activeElement as HTMLElement | null
      const tag = (el?.tagName || '').toLowerCase()
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || el?.isContentEditable) return
      // An open editor already captures the keyboard (autofocused title field);
      // as a safety net, also ignore while the create/edit modal is mounted.
      if (createDay !== null || editingEvent) return
      const k = e.key.toLowerCase()
      const step = (dir: 1 | -1) => {
        const d = viewMode === 'day' ? addDays(currentDate, dir)
          : viewMode === 'week' ? addDays(currentDate, 7 * dir)
          : viewMode === 'month' ? addDays(startOfMonth(currentDate), dir * 32)
          : addYears(currentDate, dir)
        setCurrentDate(viewMode === 'month' ? startOfMonth(d) : d)
      }
      if (k === 't') { e.preventDefault(); setCurrentDate(new Date()) }
      else if (e.key === 'ArrowLeft')  { e.preventDefault(); step(-1) }
      else if (e.key === 'ArrowRight') { e.preventDefault(); step(1) }
      else if (k === 'c') { e.preventDefault(); setCreateDay(currentDate) }
      else if (['1', '2', '3', '4'].includes(k)) {
        e.preventDefault()
        setViewMode((['day', 'week', 'month', 'year'] as ViewMode[])[+k - 1])
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [viewMode, currentDate, setCurrentDate, setViewMode, createDay, editingEvent])

  // Open the creation modal when an external trigger (e.g. sidebar) requests it
  useEffect(() => {
    if (pendingCreateDate) {
      setCreateDay(pendingCreateDate)
      setPendingCreate(null)
    }
  }, [pendingCreateDate, setPendingCreate])

  const handleEventContextMenu = useCallback((e: React.MouseEvent, ev: EventInstance) => {
    e.preventDefault()
    if (ev.event_id.startsWith(APPT_PREFIX)) return   // availability blocks aren't editable events
    setCtxMenu({ x: e.clientX, y: e.clientY, event: ev })
  }, [])

  const handleCtxEdit = useCallback(() => {
    if (!ctxMenu) return
    setSelectedEvent(null)
    setEditingEvent(ctxMenu.event)
  }, [ctxMenu])

  const handleCtxDuplicate = useCallback(() => {
    if (!ctxMenu) return
    const ev = ctxMenu.event
    calendarApi.createEvent({
      calendar_id: ev.calendar_id,
      title:       t('copy_suffix', { title: ev.title }),
      description: ev.description ?? undefined,
      location:    ev.location    ?? undefined,
      starts_at:   ev.starts_at,
      ends_at:     ev.ends_at,
      all_day:     ev.all_day,
      reminders:   ev.reminders?.length ? ev.reminders : undefined,
    }).then(() => {
      qc.invalidateQueries({ queryKey: ['calendar-events'] })
    })
  }, [ctxMenu, qc, t])

  // Deleting a series from the context menu: ask for the scope.
  const [pendingDelete, setPendingDelete] = useState<EventInstance | null>(null)

  const doDelete = useCallback((ev: EventInstance, scope: 'this' | 'following' | 'all') => {
    calendarApi.deleteEvent(ev.event_id, scope, scope !== 'all' ? ev.starts_at : undefined).then(() => {
      qc.invalidateQueries({ queryKey: ['calendar-events'] })
      if (selectedEvent?.event_id === ev.event_id) setSelectedEvent(null)
    })
  }, [qc, selectedEvent])

  const handleCtxDelete = useCallback(() => {
    if (!ctxMenu) return
    if (ctxMenu.event.is_recurring) setPendingDelete(ctxMenu.event)
    else doDelete(ctxMenu.event, 'all')
  }, [ctxMenu, doDelete])

  // ── Event drag-and-drop / resize (time changes) ──────────────────────────────
  // Explicit newStart + newEnd: covers moving (duration preserved) AND resizing
  // (start and/or end changed independently).
  const [pendingMove, setPendingMove] = useState<{ ev: EventInstance; newStart: Date; newEnd: Date } | null>(null)

  const applyMove = useCallback((ev: EventInstance, newStart: Date, newEnd: Date, scope: 'this' | 'following') => {
    calendarApi.updateEvent(ev.event_id, {
      starts_at: newStart.toISOString(),
      ends_at:   newEnd.toISOString(),
      // On a series, `occurrence` is the moved occurrence: this = detach it,
      // following = truncate the series starting at it.
      ...(ev.is_recurring ? { scope, occurrence: ev.starts_at } : {}),
    }).then(() => qc.invalidateQueries({ queryKey: ['calendar-events'] }))
  }, [qc])

  const handleEventDrop = useCallback((ev: EventInstance, newStart: Date) => {
    if (ev.event_id.startsWith(APPT_PREFIX)) return  // availability blocks are read-only
    if (Math.abs(newStart.getTime() - parseISO(ev.starts_at).getTime()) < 60000) return  // pas de changement
    const durationMs = parseISO(ev.ends_at).getTime() - parseISO(ev.starts_at).getTime()
    const newEnd = new Date(newStart.getTime() + durationMs)
    if (ev.is_recurring) setPendingMove({ ev, newStart, newEnd })   // ask for the scope
    else                 applyMove(ev, newStart, newEnd, 'this')
  }, [applyMove])

  const handleEventResize = useCallback((ev: EventInstance, newStart: Date, newEnd: Date) => {
    if (ev.event_id.startsWith(APPT_PREFIX)) return  // availability blocks are read-only
    const sameStart = Math.abs(newStart.getTime() - parseISO(ev.starts_at).getTime()) < 60000
    const sameEnd   = Math.abs(newEnd.getTime()   - parseISO(ev.ends_at).getTime())   < 60000
    if (sameStart && sameEnd) return  // pas de changement
    if (ev.is_recurring) setPendingMove({ ev, newStart, newEnd })
    else                 applyMove(ev, newStart, newEnd, 'this')
  }, [applyMove])

  const { data: calData, isLoading: loadingCals } = useQuery({
    queryKey: ['calendar-calendars'],
    queryFn:  calendarApi.listCalendars,
  })
  const calendars = calData?.calendars ?? []

  const rangeStart = useMemo(() => {
    if (viewMode === 'day')   return startOfDay(currentDate)
    if (viewMode === 'week')  return startOfWeek(currentDate, { weekStartsOn: 1 })
    if (viewMode === 'year')  return startOfYear(currentDate)
    return startOfWeek(startOfMonth(currentDate), { weekStartsOn: 1 })
  }, [viewMode, currentDate])

  const rangeEnd = useMemo(() => {
    if (viewMode === 'day')   return endOfDay(currentDate)
    if (viewMode === 'week')  return endOfWeek(currentDate, { weekStartsOn: 1 })
    if (viewMode === 'year')  return endOfYear(currentDate)
    return endOfWeek(endOfMonth(currentDate), { weekStartsOn: 1 })
  }, [viewMode, currentDate])

  const { data: evData } = useQuery({
    queryKey: ['calendar-events', rangeStart.toISOString(), rangeEnd.toISOString()],
    queryFn:  () => calendarApi.listEvents(rangeStart.toISOString(), rangeEnd.toISOString()),
    enabled:  !loadingCals,
  })
  // Hide events of the calendars unchecked in the sidebar
  const events = (evData?.events ?? []).filter(
    (ev) => !hiddenCalendarIds.includes(ev.calendar_id),
  )

  // ── Appointment schedules → overlaid availability blocks ──
  const { data: apptData } = useQuery({
    queryKey: ['appointment-schedules'],
    queryFn:  appointmentApi.list,
    enabled:  !loadingCals,
  })
  const scheduleList = apptData?.schedules ?? []
  // Full detail (with availability rules) per schedule — the list omits rules.
  const scheduleDetails = useQueries({
    queries: scheduleList.map(s => ({
      queryKey: ['appointment-schedule', s.id],
      queryFn:  () => appointmentApi.get(s.id),
    })),
  })
  const scheduleSig = scheduleDetails.map(q => `${q.data?.schedule.id ?? ''}:${q.data?.schedule.updated_at ?? ''}`).join('|')
  const availabilityEvents = useMemo(() => {
    const full = scheduleDetails.map(q => q.data?.schedule).filter(Boolean) as AppointmentSchedule[]
    return buildAvailabilityEvents(full, rangeStart, rangeEnd)
      .filter(ev => !hiddenCalendarIds.includes(ev.calendar_id))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scheduleSig, rangeStart.getTime(), rangeEnd.getTime(), hiddenCalendarIds])
  const events2 = useMemo(() => [...events, ...availabilityEvents], [events, availabilityEvents])

  // Clicking an availability block opens its schedule editor rather than the
  // event detail popover (synthetic events have no backing event).
  const handleEventClick = (ev: EventInstance) => {
    if (ev.event_id.startsWith(APPT_PREFIX)) {
      const id = ev.event_id.slice(APPT_PREFIX.length)
      navigate(`/calendar/booking/${id}`)   // edit the schedule on its dedicated page
      return
    }
    setSelectedEvent(ev)
  }

  // ── Overlays provided by other modules (generic extension point) ──
  // Calendar knows no module in particular: it aggregates the registered
  // providers (e.g. tasks overlays its due dates). See core/registry/calendarOverlay.
  const overlayProviders = ExtensionRegistry.getAll<CalendarOverlayProvider>(CALENDAR_OVERLAY)
  const { data: overlayItems = [] } = useQuery({
    queryKey: ['calendar-overlay', rangeStart.toISOString(), rangeEnd.toISOString(), overlayProviders.length],
    queryFn:  async () => {
      const lists = await Promise.all(
        overlayProviders.map(p => p.fetch(rangeStart.toISOString(), rangeEnd.toISOString()).catch(() => [])),
      )
      return lists.flat()
    },
    enabled:  !loadingCals && overlayProviders.length > 0,
  })
  const overlayByDate = useMemo(() => {
    const map = new Map<string, CalendarOverlayItem[]>()
    for (const it of overlayItems) {
      const arr = map.get(it.date) ?? []
      arr.push(it)
      map.set(it.date, arr)
    }
    return map
  }, [overlayItems])

  // ── Weather ──
  const { data: locData } = useQuery({
    queryKey: ['weather-locations'],
    queryFn:  weatherApi.listLocations,
    enabled:  weatherEnabled,
  })
  const activeLoc = useMemo(() => {
    const locs = locData?.locations ?? []
    return locs.find(l => l.id === weatherLocationId)
        ?? locs.find(l => l.is_default)
        ?? locs[0]
        ?? null
  }, [locData, weatherLocationId])

  const { data: forecastData } = useQuery({
    queryKey:  ['weather-forecast', activeLoc?.id, rangeStart.toISOString().slice(0, 10)],
    queryFn:   () => weatherApi.getForecast(activeLoc!.latitude, activeLoc!.longitude, activeLoc!.timezone),
    enabled:   weatherEnabled && !!activeLoc,
    staleTime: 3_600_000,
  })

  const weatherByDate = useMemo<Map<string, DailyWeather>>(() => {
    const map = new Map<string, DailyWeather>()
    forecastData?.forecast.days.forEach(d => map.set(d.date, d))
    return map
  }, [forecastData])

  const handleMonthClick = (month: Date) => {
    setCurrentDate(month)
    setViewMode('month')
  }

  const isSearchMode = searchApplied || searchQuery.trim().length > 0

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Search results or calendar views */}
      {isSearchMode ? (
        <SearchResultsView calendars={calendars} onEventClick={setSelectedEvent} />
      ) : (
        <>
          {viewMode === 'day' && (
            <DayView date={currentDate} events={events2} calendars={calendars}
              onEventClick={handleEventClick}
              onEventContextMenu={handleEventContextMenu}
              onEventDrop={handleEventDrop}
              onEventResize={handleEventResize}
              onRangeCreate={handleRangeCreate}
              weatherByDate={weatherByDate} />
          )}
          {viewMode === 'week' && (
            <WeekView date={currentDate} events={events2} calendars={calendars}
              onEventClick={handleEventClick}
              onEventContextMenu={handleEventContextMenu}
              onEventDrop={handleEventDrop}
              onEventResize={handleEventResize}
              onRangeCreate={handleRangeCreate}
              weatherByDate={weatherByDate} />
          )}
          {viewMode === 'month' && (
            <MonthView month={currentDate} events={events2} calendars={calendars}
              onDayClick={setCreateDay}
              onEventClick={handleEventClick}
              onEventContextMenu={handleEventContextMenu}
              onEventDrop={handleEventDrop}
              weatherByDate={weatherByDate}
              overlayByDate={overlayByDate} />
          )}
          {viewMode === 'year' && (
            <YearView year={currentDate} events={events2} overlayByDate={overlayByDate}
              onMonthClick={handleMonthClick} onEventClick={handleEventClick}
              onDayCreate={setCreateDay} />
          )}
        </>
      )}

      {/* Context menu (right click on an event) */}
      {ctxMenu && (
        <MenuDropdown
          pos={{ top: ctxMenu.y, left: ctxMenu.x }}
          onClose={() => setCtxMenu(null)}
          items={[
            { type: 'action', label: t('edit'),      icon: <Edit2 size={14} />, onClick: handleCtxEdit },
            { type: 'action', label: t('duplicate'), icon: <Copy size={14} />,  onClick: handleCtxDuplicate },
            { type: 'separator' },
            { type: 'action', label: t('delete'),    icon: <Trash2 size={14} />, onClick: handleCtxDelete },
          ]}
        />
      )}

      {/* Scope choice when moving a recurring event */}
      {pendingMove && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center" onClick={() => setPendingMove(null)}>
          <div className="absolute inset-0 bg-black/30" />
          <div className="relative bg-surface-0 rounded-2xl shadow-xl w-full max-w-sm p-5" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-sm font-semibold text-text-primary mb-1">{t('move_recurring_title')}</h3>
            <p className="text-xs text-text-secondary mb-4">{t('move_recurring_desc')}</p>
            <div className="flex flex-col gap-2">
              <button onClick={() => { applyMove(pendingMove.ev, pendingMove.newStart, pendingMove.newEnd, 'this'); setPendingMove(null) }}
                className="w-full text-sm px-3 py-2 rounded-lg border border-border hover:bg-surface-1 text-left">
                {t('move_this_only')}
              </button>
              <button onClick={() => { applyMove(pendingMove.ev, pendingMove.newStart, pendingMove.newEnd, 'following'); setPendingMove(null) }}
                className="w-full text-sm px-3 py-2 rounded-lg bg-primary text-white hover:bg-primary-hover text-left">
                {t('move_this_following')}
              </button>
              <button onClick={() => setPendingMove(null)} className="w-full text-sm px-3 py-1.5 text-text-secondary">
                {t('cancel')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Scope choice when deleting a recurring event (context menu) */}
      {pendingDelete && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center" onClick={() => setPendingDelete(null)}>
          <div className="absolute inset-0 bg-black/30" />
          <div className="relative bg-surface-0 rounded-2xl shadow-xl w-full max-w-sm p-5" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-sm font-semibold text-text-primary mb-1">
              {t('delete_recurring_title', { defaultValue: 'Supprimer l’événement récurrent' })}
            </h3>
            <p className="text-xs text-text-secondary mb-4">
              {t('delete_recurring_desc', { defaultValue: 'Quels événements de la série supprimer ?' })}
            </p>
            <div className="flex flex-col gap-2">
              <button onClick={() => { doDelete(pendingDelete, 'this'); setPendingDelete(null) }}
                className="w-full text-sm px-3 py-2 rounded-lg border border-border hover:bg-surface-1 text-left">
                {t('move_this_only', { defaultValue: 'Cet événement seulement' })}
              </button>
              <button onClick={() => { doDelete(pendingDelete, 'following'); setPendingDelete(null) }}
                className="w-full text-sm px-3 py-2 rounded-lg border border-border hover:bg-surface-1 text-left">
                {t('move_this_following', { defaultValue: 'Celui-ci et les suivants' })}
              </button>
              <button onClick={() => { doDelete(pendingDelete, 'all'); setPendingDelete(null) }}
                className="w-full text-sm px-3 py-2 rounded-lg bg-danger text-white hover:opacity-90 text-left">
                {t('delete_all_events', { defaultValue: 'Tous les événements' })}
              </button>
              <button onClick={() => setPendingDelete(null)} className="w-full text-sm px-3 py-1.5 text-text-secondary">
                {t('cancel')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modals */}
      {createDay !== null && (
        <CreateEventModal initialDate={createDay} initialEnd={createEnd} calendars={calendars}
          onClose={() => { setCreateDay(null); setCreateEnd(null) }} />
      )}
      {selectedEvent && !editingEvent && (
        <EventDetail event={selectedEvent} calendars={calendars}
          onClose={() => setSelectedEvent(null)}
          onDelete={() => setSelectedEvent(null)}
          onEdit={() => { setEditingEvent(selectedEvent); setSelectedEvent(null) }}
        />
      )}
      {editingEvent && (
        <EditEventModal event={editingEvent} calendars={calendars}
          onClose={() => setEditingEvent(null)} />
      )}
    </div>
  )
}
