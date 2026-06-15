import { useState, useMemo, useEffect, useCallback, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useCalendarStore, type ViewMode } from './store'
import {
  X, Calendar as CalendarIcon,
  Clock, MapPin, Search, Plus, Edit2, Copy, Trash2, Bell,
  Mail, Share2, AlignLeft, Check, User as UserIcon,
  MoreVertical, Printer, Link2, Lock, Globe,
  Repeat, Users, Briefcase, ChevronDown, Pipette,
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
  calendarApi, weatherApi, wmoInfo, weatherIconUrl,
  type Calendar, type EventInstance, type DailyWeather,
  type EventReminder,
} from './api'
import { ExtensionRegistry } from '@kubuno/sdk'
import { CALENDAR_OVERLAY, type CalendarOverlayItem, type CalendarOverlayProvider } from '@kubuno/sdk'
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

// Humanise une RRULE iCalendar en texte lisible (FR). Couvre les cas usuels
// (FREQ + INTERVAL + BYDAY + COUNT/UNTIL). Retourne null si non interprétable.
function describeRrule(rrule: string | null, lang: string, start: Date): string | null {
  if (!rrule) return null
  const parts = Object.fromEntries(
    rrule.replace(/^RRULE:/i, '').split(';').map(kv => {
      const [k, v] = kv.split('=')
      return [k.toUpperCase(), (v ?? '').toUpperCase()]
    })
  ) as Record<string, string>
  const freq = parts.FREQ
  if (!freq) return null
  const interval = Math.max(1, parseInt(parts.INTERVAL ?? '1', 10) || 1)
  const loc = getDateLocale(lang)

  const DAY_NAMES: Record<string, string> = {
    MO: 'lundi', TU: 'mardi', WE: 'mercredi', TH: 'jeudi', FR: 'vendredi', SA: 'samedi', SU: 'dimanche',
  }
  const byday = (parts.BYDAY ?? '').split(',').map(d => d.replace(/^[+-]?\d+/, '')).filter(Boolean)
  const dayList = byday.map(d => DAY_NAMES[d]).filter(Boolean)
  const joinDays = (ds: string[]) =>
    ds.length <= 1 ? (ds[0] ?? '') : `${ds.slice(0, -1).join(', ')} et ${ds[ds.length - 1]}`

  let base: string
  switch (freq) {
    case 'DAILY':
      base = interval === 1 ? 'Tous les jours' : `Tous les ${interval} jours`
      break
    case 'WEEKLY': {
      const days = dayList.length ? joinDays(dayList) : format(start, 'EEEE', { locale: loc })
      base = interval === 1 ? `Toutes les semaines le ${days}` : `Toutes les ${interval} semaines le ${days}`
      break
    }
    case 'MONTHLY':
      base = interval === 1 ? 'Tous les mois' : `Tous les ${interval} mois`
      break
    case 'YEARLY':
      base = interval === 1 ? 'Tous les ans' : `Tous les ${interval} ans`
      break
    default:
      return null
  }

  if (parts.COUNT) base += `, ${parts.COUNT} fois`
  else if (parts.UNTIL) {
    const m = parts.UNTIL.match(/^(\d{4})(\d{2})(\d{2})/)
    if (m) base += `, jusqu'au ${format(new Date(+m[1], +m[2] - 1, +m[3]), 'd MMMM yyyy', { locale: loc })}`
  }
  return base
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

// ── Récurrence (rrule) ────────────────────────────────────────────────────────
const WEEKDAY_BY = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']
function buildRrule(preset: string, start: Date): string | null {
  switch (preset) {
    case 'daily':   return 'FREQ=DAILY'
    case 'weekly':  return `FREQ=WEEKLY;BYDAY=${WEEKDAY_BY[getDay(start)]}`
    case 'weekday': return 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR'
    case 'monthly': return 'FREQ=MONTHLY'
    case 'yearly':  return 'FREQ=YEARLY'
    default:        return null
  }
}
function presetFromRrule(rrule: string | null | undefined): string {
  if (!rrule) return 'none'
  const u = rrule.toUpperCase()
  if (u.includes('FREQ=DAILY')) return 'daily'
  if (u.includes('BYDAY=MO,TU,WE,TH,FR')) return 'weekday'
  if (u.includes('FREQ=WEEKLY')) return 'weekly'
  if (u.includes('FREQ=MONTHLY')) return 'monthly'
  if (u.includes('FREQ=YEARLY')) return 'yearly'
  return 'custom'
}

function RecurrenceField({ preset, onChange, start }: { preset: string; onChange: (p: string) => void; start: Date }) {
  const { t, i18n } = useTranslation('calendar')
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
  return (
    <div className="flex items-center gap-3">
      <Repeat size={18} className="shrink-0 text-text-tertiary" />
      <Dropdown
        className="flex-1"
        value={isCustom ? 'custom' : preset}
        onChange={onChange}
        options={isCustom ? [{ value: 'custom', label: t('recur_custom', { defaultValue: 'Récurrence personnalisée' }) }, ...opts] : opts}
      />
    </div>
  )
}

// ── Event creation modal ──────────────────────────────────────────────────────

interface CreateModalProps {
  initialDate: Date | null
  calendars: Calendar[]
  onClose: () => void
}

interface EditModalProps {
  event: EventInstance
  calendars: Calendar[]
  onClose: () => void
}

// ── Menu « Autres actions » de l'éditeur ──────────────────────────────────────
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

// ── Sélecteur de couleur compact ──────────────────────────────────────────────
// Couleurs « Personnalisé » ajoutées par l'utilisateur — persistées localement et
// PARTAGÉES avec le reste de l'app (même clé que le ColorSwatchPicker de @ui, donc
// les couleurs créées dans Documents réapparaissent ici, et inversement).
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
  const [customOpen, setCustomOpen] = useState(false)   // écran ColorPicker complet
  const [draft, setDraft] = useState(color ?? calColor) // couleur en cours d'édition (pas encore appliquée)
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
    try { const r = await new ED().open(); addCustom(r.sRGBHex); setColor(r.sRGBHex); close() } catch { /* annulé */ }
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
            // ColorPicker complet : centré en `fixed` pour ne JAMAIS déborder du
            // dialogue/viewport (sinon le pied Ajouter/Annuler sort de l'écran).
            // Pas de `t` : le picker utilise ses libellés intégrés (clés `layer_*`
            // absentes du namespace calendar) ; on traduit seulement Ajouter/Annuler.
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
              {/* Pastille « couleur de l'agenda » (défaut) */}
              {swatch(calColor, () => { setColor(calColor); close() }, 'cal', cur === calColor)}
              {EVENT_SWATCHES.filter(c => c.toLowerCase() !== calColor.toLowerCase()).map(c =>
                swatch(c, () => { setColor(c); close() }, c, color === c))}
              {/* Couleurs personnalisées sauvegardées (sans doublon avec la palette ci-dessus) */}
              {custom.filter(c => {
                const lc = c.toLowerCase()
                return lc !== calColor.toLowerCase() && !EVENT_SWATCHES.some(s => s.toLowerCase() === lc)
              }).map(c => swatch(c, () => { setColor(c); close() }, 'cust-' + c, color === c))}
              {/* + : ouvre le ColorPicker complet (comme dans Documents) */}
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

// ── Panneau invités (édition) ─────────────────────────────────────────────────
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
          {attendees.map(a => (
            <div key={a.id} className="flex items-center gap-2 text-sm">
              <span className="w-7 h-7 rounded-full bg-surface-2 flex items-center justify-center text-xs shrink-0">
                {(a.display_name || a.email)[0]?.toUpperCase()}
              </span>
              <span className="flex-1 truncate">
                {a.display_name || a.email}
                {a.is_organizer && <span className="text-text-tertiary text-xs ml-1">· {t('organizer', { defaultValue: 'organisateur' })}</span>}
              </span>
              {!a.is_organizer && (
                <button type="button" onClick={() => remove.mutate(a.id)} className="p-1 text-text-tertiary hover:text-danger" aria-label={t('delete')}>
                  <X size={14} />
                </button>
              )}
            </div>
          ))}
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

// ── Onglet « Rechercher un horaire » ──────────────────────────────────────────
function ScheduleTab({ eventId }: { eventId?: string }) {
  const { t } = useTranslation('calendar')
  const { data } = useQuery({
    queryKey: ['event-attendees', eventId],
    queryFn:  () => calendarApi.listAttendees(eventId!).then(r => r.attendees),
    enabled:  !!eventId,
  })
  const attendees = data ?? []
  return (
    <div className="px-16 py-10 max-h-[55vh] overflow-y-auto">
      {attendees.length === 0 ? (
        <div className="text-center text-text-tertiary py-10">
          <Users size={28} className="mx-auto mb-3 opacity-40" />
          <p className="text-sm">{t('schedule_empty', { defaultValue: "Ajoutez des invités pour comparer les disponibilités et trouver un créneau commun." })}</p>
        </div>
      ) : (
        <div>
          <p className="text-sm text-text-secondary mb-4">{t('schedule_intro', { defaultValue: 'Disponibilités des participants :' })}</p>
          <div className="space-y-2">
            {attendees.map(a => (
              <div key={a.id} className="flex items-center gap-3 text-sm">
                <span className="w-7 h-7 rounded-full bg-surface-2 flex items-center justify-center text-xs shrink-0">
                  {(a.display_name || a.email)[0]?.toUpperCase()}
                </span>
                <span className="flex-1 truncate">{a.display_name || a.email}</span>
                <span className="text-xs text-text-tertiary">{a.status === 'accepted' ? t('rsvp_yes', { defaultValue: 'A accepté' }) : t('rsvp_pending', { defaultValue: 'En attente' })}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Éditeur d'événement (création + édition) façon Google Agenda ──────────────
function EventEditor({ mode, event, initialDate, calendars, onClose }: {
  mode: 'create' | 'edit'; event?: EventInstance; initialDate?: Date | null; calendars: Calendar[]; onClose: () => void
}) {
  const { t } = useTranslation('calendar')
  const qc = useQueryClient()
  const ev = event

  // Fenêtre d'édition déplaçable : la barre supérieure sert de poignée. On ignore
  // les clics sur les éléments interactifs (champ titre, boutons, menus) pour ne pas
  // gêner l'édition. L'offset translate la carte depuis sa position centrée initiale.
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
  const [date,       setDate]       = useState(ev ? parseDate(ev.starts_at) : format(initialDate ?? new Date(), 'yyyy-MM-dd'))
  const [endDate,    setEndDate]    = useState(ev ? parseDate(ev.ends_at) : format(initialDate ?? new Date(), 'yyyy-MM-dd'))
  const [startTime,  setStartTime]  = useState(ev ? parseTime(ev.starts_at) : '09:00')
  const [endTime,    setEndTime]    = useState(ev ? parseTime(ev.ends_at) : '10:00')
  const [allDay,     setAllDay]     = useState(ev?.all_day ?? false)
  const [location,   setLocation]   = useState(ev?.location ?? '')
  const [desc,       setDesc]       = useState(ev?.description ?? '')
  const [reminders,  setReminders]  = useState<EventReminder[]>(ev?.reminders ?? [])
  const [color,      setColor]      = useState<string | null>(ev?.color ?? null)
  const [recur,      setRecur]      = useState(mode === 'edit' ? presetFromRrule(ev?.rrule) : 'none')
  const [busy,       setBusy]       = useState(ev?.busy ?? true)
  const [visibility, setVisibility] = useState(ev?.visibility || 'default')

  useEffect(() => {
    if (!calId && calendars.length > 0) setCalId((calendars.find(c => c.is_default) ?? calendars[0]).id)
  }, [calendars, calId])

  const { mutate, isPending, error } = useMutation<unknown, Error>({
    mutationFn: () => {
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
      const base = {
        calendar_id: calId, title: title.trim(),
        description: desc.trim() || undefined, location: location.trim() || undefined,
        starts_at: startsAt, ends_at: endsAt, all_day: allDay,
        reminders: reminders.length ? reminders : undefined,
        busy, visibility, timezone: tz,
      }
      if (mode === 'create') {
        return calendarApi.createEvent({ ...base,
          rrule: buildRrule(recur, start) ?? undefined,
          ...(color && color !== calColor ? { color } : {}),
        })
      }
      return calendarApi.updateEvent(ev!.event_id, { ...base,
        ...(['daily', 'weekly', 'weekday', 'monthly', 'yearly'].includes(recur) ? { rrule: buildRrule(recur, start) ?? undefined } : {}),
        ...(color && color !== calColor ? { color } : { clear_color: true }),
      })
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['calendar-events'] }); onClose() },
  })

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
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-5xl my-4"
        style={{ transform: `translate(${winOffset.x}px, ${winOffset.y}px)` }}>
        {/* Barre supérieure — sert de poignée de déplacement de la fenêtre */}
        <div className="flex items-center gap-3 px-5 py-3 cursor-move select-none"
          onMouseDown={onWindowDragStart}>
          <button type="button" onClick={onClose} className="p-1.5 rounded-full hover:bg-surface-2 text-text-secondary" aria-label={t('cancel')}><X size={20} /></button>
          <input autoFocus value={title} onChange={e => setTitle(e.target.value)} placeholder={t('event_title')} maxLength={500}
            className="flex-1 text-xl text-text-primary placeholder:text-text-tertiary border-b border-transparent focus:border-primary outline-none py-1 bg-transparent min-w-0" />
          <Button onClick={() => canSave && mutate()} disabled={!canSave} loading={isPending}>{t('save', { defaultValue: 'Enregistrer' })}</Button>
          {mode === 'edit' && ev && <EditEventActionsMenu event={ev} calendars={calendars} onClose={onClose} />}
        </div>

        {/* Date / heure / fuseau */}
        <div className="px-16 pb-1 flex flex-wrap items-center gap-2">
          <div className="w-40"><DatePicker mode="date" value={date} onChange={v => setDate(v ?? '')} /></div>
          {!allDay && <>
            <DatePicker mode="time" value={startTime} onChange={v => setStartTime(v ?? '')} />
            <span className="text-text-tertiary">–</span>
            <DatePicker mode="time" value={endTime} onChange={v => setEndTime(v ?? '')} />
          </>}
          <div className="w-40"><DatePicker mode="date" value={endDate} onChange={v => setEndDate(v ?? '')} /></div>
          <span className="text-text-tertiary text-xs ml-1">{tzName}</span>
        </div>
        <div className="px-16 pb-3 flex items-center gap-4">
          <Checkbox label={t('all_day')} checked={allDay} onChange={setAllDay} />
          <div className="w-72"><RecurrenceField preset={recur} onChange={setRecur} start={new Date(`${date}T${allDay ? '00:00' : startTime}:00`)} /></div>
        </div>

        {/* Onglets */}
        <div className="px-16 border-b border-border flex gap-6">
          <TabButton active={tab === 'details'} onClick={() => setTab('details')}>{t('tab_details', { defaultValue: "Détails de l'événement" })}</TabButton>
          <TabButton active={tab === 'schedule'} onClick={() => setTab('schedule')}>{t('tab_schedule', { defaultValue: 'Rechercher un horaire' })}</TabButton>
        </div>

        {/* Corps */}
        {tab === 'details' ? (
          <div className="px-16 py-6 flex gap-12 max-h-[55vh] overflow-y-auto">
            <div className="space-y-5 min-w-0 flex-1">
              {row(<MapPin size={18} />, <Input placeholder={t('add_location', { defaultValue: 'Ajouter un lieu' })} value={location} onChange={e => setLocation(e.target.value)} className="w-full" />)}
              <RemindersSection reminders={reminders} onChange={setReminders} />
              {row(<CalendarIcon size={18} />, (
                <div className="flex items-center gap-2">
                  <Dropdown className="flex-1" value={calId} onChange={setCalId} options={calendars.map(c => ({ value: c.id, label: c.name }))} />
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
            <div className="w-[320px] shrink-0">
              <h3 className="text-sm font-medium text-text-primary border-b-2 border-primary inline-block pb-2 mb-4">{t('guests', { defaultValue: 'Invités' })}</h3>
              {mode === 'edit' && ev ? (
                <GuestsPanel eventId={ev.event_id} />
              ) : (
                <p className="text-sm text-text-tertiary">{t('guests_after_create', { defaultValue: "Enregistrez l'événement pour ajouter des invités." })}</p>
              )}
            </div>
          </div>
        ) : (
          <ScheduleTab eventId={ev?.event_id} />
        )}

        {(error || calendars.length === 0) && (
          <div className="px-16 pb-4">
            {error && <p className="text-xs text-danger">{error.message}</p>}
            {calendars.length === 0 && <p className="text-xs text-warning">{t('no_calendar_available')}</p>}
          </div>
        )}
      </div>
    </div>
  )
}

function CreateEventModal({ initialDate, calendars, onClose }: CreateModalProps) {
  return <EventEditor mode="create" initialDate={initialDate} calendars={calendars} onClose={onClose} />
}

function EditEventModal({ event, calendars, onClose }: EditModalProps) {
  return <EventEditor mode="edit" event={event} calendars={calendars} onClose={onClose} />
}

// ── Event detail ──────────────────────────────────────────────────────────────

// Petit bouton-icône pour la barre d'actions de l'en-tête (style Google).
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
  const user = useAuthStore(s => s.user)
  const cal  = calendars.find(c => c.id === event.calendar_id)
  const color = event.color ?? cal?.color ?? '#4D38DB'
  const loc   = getDateLocale(i18n.language)
  const [copied, setCopied] = useState(false)
  const [moreMenu, setMoreMenu] = useState<MenuDropdownPos | null>(null)

  const { mutate: del, isPending } = useMutation<unknown, Error>({
    mutationFn: () => calendarApi.deleteEvent(event.event_id, 'this'),
    onSuccess:  () => { qc.invalidateQueries({ queryKey: ['calendar-events'] }); onDelete() },
  })

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

  // Récapitulatif texte de l'événement (pour partage / e-mail).
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

  // Durée lisible (ex. « 1 h », « 30 min », « 1 h 30 »).
  const durationText = (() => {
    if (event.all_day) return t('detail_all_day', { defaultValue: 'Toute la journée' })
    const mins = Math.max(0, Math.round((parseISO(event.ends_at).getTime() - start.getTime()) / 60000))
    const h = Math.floor(mins / 60), m = mins % 60
    return [h ? `${h} h` : '', m ? `${m} min` : ''].filter(Boolean).join(' ') || '0 min'
  })()

  // Visibilité (public/privé) — affichée seulement si non publique pour rester sobre.
  const vis = (event.visibility || '').toLowerCase()
  const isPrivate = vis === 'private' || vis === 'confidential'

  const moreItems: MenuItem[] = [
    { type: 'action', icon: <Copy size={16} />,    label: t('duplicate'),                                          onClick: () => duplicate() },
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
          <HeaderIconBtn title={t('edit')} onClick={onEdit}><Edit2 size={16} /></HeaderIconBtn>
          <HeaderIconBtn title={t('delete')} danger onClick={() => del()}><Trash2 size={16} /></HeaderIconBtn>
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
        {/* Date + durée + récurrence */}
        <div className="flex items-start gap-3">
          <Clock size={18} className="shrink-0 text-text-tertiary mt-0.5" />
          <div className="text-sm text-text-primary leading-snug">
            <div>{dateText} <span className="text-text-tertiary">· {durationText}</span></div>
            {recurrenceText && (
              <div className="text-text-secondary mt-0.5">{recurrenceText}</div>
            )}
          </div>
        </div>

        {/* Inviter avec un lien */}
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

        {/* Lieu */}
        {event.location && (
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

        {/* Visibilité */}
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

        {/* Agenda + propriétaire */}
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

// Heure courante « vivante » : re-rend périodiquement pour faire évoluer en temps réel
// la ligne « maintenant » et le grisage passé/à venir, sans recharger la page.
function useNowTick(intervalMs = 30_000): Date {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
  return now
}

// ── Day view ──────────────────────────────────────────────────────────────────

function DayView({ date, events, calendars, onEventClick, onEventContextMenu, onEventDrop, onEventResize, weatherByDate }: {
  date: Date; events: EventInstance[]; calendars: Calendar[]
  onEventClick: (ev: EventInstance) => void
  onEventContextMenu: (e: React.MouseEvent, ev: EventInstance) => void
  onEventDrop: (ev: EventInstance, newStart: Date) => void
  onEventResize: (ev: EventInstance, newStart: Date, newEnd: Date) => void
  weatherByDate: Map<string, DailyWeather>
}) {
  const { i18n } = useTranslation('calendar')
  const hours    = Array.from({ length: 24 }, (_, i) => i)
  const calMap   = useMemo(() => new Map(calendars.map(c => [c.id, c])), [calendars])
  const weekend  = isWeekend(date)
  const dayEvs   = events.filter(ev => !ev.all_day && isSameDay(parseISO(ev.starts_at), date))
  const allDayEvs = events.filter(ev => ev.all_day && isSameDay(parseISO(ev.starts_at), date))
  const dateKey  = format(date, 'yyyy-MM-dd')
  const wx       = weatherByDate.get(dateKey) ?? null
  const [dragging, setDragging] = useState<EventInstance | null>(null)
  const [ghostMin, setGhostMin] = useState<number | null>(null)
  // Ref synchrone : onDragOver/onDrop ne dépendent pas du timing de re-render de `dragging`
  // (sinon les premiers dragover voient null, ne preventDefault pas, et le drop n'arrive jamais).
  const draggingRef = useRef<EventInstance | null>(null)
  const ghostHeight = dragging ? Math.max(((parseISO(dragging.ends_at).getTime() - parseISO(dragging.starts_at).getTime()) / 3600000) * 40, 20) : 0

  // Redimensionnement vertical d'un événement (poignées haut/bas → début/fin).
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

  // Fuseau secondaire (préférence perso) + fuseau local pour la double colonne d'heures.
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

  // Ligne « maintenant » (aujourd'hui uniquement) — évolue en temps réel via le tick.
  const now     = useNowTick()
  const showNow = isToday(date)
  const nowTop  = (now.getHours() + now.getMinutes() / 60 + now.getSeconds() / 3600) * 40

  // Police monospace JetBrains Mono pour tous les horaires (gouttières + événements).
  const MONO = "'JetBrains Mono', ui-monospace, monospace"

  // Rendu d'une colonne de gouttière horaire (heures d'un fuseau).
  const gutter = (labelFor: (h: number) => string) => (
    <div className="border-r border-border">
      {hours.map(h => (
        <div key={h} className="h-10 flex items-start justify-end pr-2 pt-0.5">
          {h > 0 && <span className="text-xs text-text-tertiary tabular-nums" style={{ fontFamily: MONO }}>{labelFor(h)}</span>}
        </div>
      ))}
    </div>
  )

  return (
    <div className="flex-1 overflow-hidden flex flex-col">
      {/* En-tête */}
      <div className={`border-b border-border shrink-0 py-3 text-center ${weekend ? 'bg-surface-1' : ''}`}>
        <div className={`text-sm font-medium capitalize ${isToday(date) ? 'text-primary' : weekend ? 'text-text-tertiary' : 'text-text-primary'}`}>
          {format(date, 'EEEE d MMMM yyyy', { locale: getDateLocale(i18n.language) })}
        </div>
        {/* Météo du jour */}
        {wx && (
          <div className="flex items-center justify-center gap-2 mt-1 text-sm text-text-secondary">
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
                  style={{ backgroundColor: color + '20', borderLeft: `3px solid ${color}` }}
                  className="text-xs px-2 py-0.5 rounded cursor-pointer hover:opacity-80">
                  {ev.title}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Grille horaire */}
      <div className={`flex-1 overflow-y-auto ${weekend ? 'bg-surface-1/30' : ''}`}>
        {/* Bandeau libellés de fuseaux (seulement si un fuseau secondaire est défini) */}
        {secondaryTimezone && (
          <div className="grid sticky top-0 z-30 bg-white border-b border-border"
            style={{ gridTemplateColumns: '52px 52px 1fr' }}>
            <div className="text-[10px] text-text-tertiary text-center py-1 truncate" title={secondaryTimezone}>{tzOffsetLabel(secondaryTimezone)}</div>
            <div className="text-[10px] text-text-tertiary text-center py-1 truncate" title={localTz}>{tzOffsetLabel(localTz)}</div>
            <div />
          </div>
        )}
        <div className="grid" style={{ minHeight: '960px', gridTemplateColumns: secondaryTimezone ? '52px 52px 1fr' : '60px 1fr' }}>
          {/* Colonne fuseau secondaire (à gauche) */}
          {secondaryTimezone && gutter(h => tzHourLabel(secondaryTimezone, h))}
          {/* Colonne fuseau local (adjacente à la grille) */}
          {gutter(h => `${String(h).padStart(2, '0')}:00`)}
          <div className="relative"
            onDragOver={e => { if (!draggingRef.current) return; e.preventDefault(); const rect = e.currentTarget.getBoundingClientRect(); const y = e.clientY - rect.top; let m = Math.round((y / 40 * 60) / 15) * 15; m = Math.max(0, Math.min(24 * 60 - 15, m)); setGhostMin(m) }}
            onDrop={e => { const drag = draggingRef.current; if (drag && ghostMin !== null) { e.preventDefault(); const ns = new Date(date); ns.setHours(Math.floor(ghostMin / 60), ghostMin % 60, 0, 0); onEventDrop(drag, ns) } draggingRef.current = null; setDragging(null); setGhostMin(null) }}>
            {hours.map(h => <div key={h} className="h-10 border-b border-border/50" />)}
            {dragging && ghostMin !== null && (
              <div className="absolute left-1 right-1 rounded bg-primary/20 border border-dashed border-primary pointer-events-none z-20"
                style={{ top: ghostMin * 40 / 60, height: ghostHeight }}>
                <div className="text-xs font-medium text-primary px-2" style={{ fontFamily: MONO }}>{String(Math.floor(ghostMin / 60)).padStart(2, '0')}:{String(ghostMin % 60).padStart(2, '0')}</div>
              </div>
            )}
            {dayEvs.map(ev => {
              const start  = parseISO(ev.starts_at)
              const end    = parseISO(ev.ends_at)
              const cal    = calMap.get(ev.calendar_id)
              const color  = ev.color ?? cal?.color ?? '#4D38DB'
              const past   = end < now
              // Pendant un resize, on prévisualise avec les minutes en cours d'édition.
              const isResizing = resize?.id === ev.id
              const sMin   = isResizing ? resize!.startMin : start.getHours() * 60 + start.getMinutes()
              const eMin   = isResizing ? resize!.endMin   : end.getHours()   * 60 + end.getMinutes()
              const top    = sMin / 60 * PX_PER_HOUR
              const height = Math.max((eMin - sMin) / 60 * PX_PER_HOUR, 20)
              return (
                <div key={ev.id}
                  draggable
                  onDragStart={e => { if (resizingRef.current) { e.preventDefault(); return } draggingRef.current = ev; setDragging(ev) }}
                  onDragEnd={() => { draggingRef.current = null; setDragging(null); setGhostMin(null) }}
                  onClick={() => { if (!isResizing) onEventClick(ev) }}
                  onContextMenu={e => onEventContextMenu(e, ev)}
                  style={{ top, height, backgroundColor: past ? color + '24' : color, opacity: dragging?.id === ev.id ? 0.4 : 1 }}
                  className="absolute left-1 right-1 rounded px-2 py-0.5 cursor-pointer overflow-hidden hover:opacity-90 active:cursor-grabbing group">
                  {/* Poignée de redimensionnement — haut (heure de début) */}
                  <div onPointerDown={startResize(ev, 'top')} onClick={e => e.stopPropagation()} draggable={false}
                    className="absolute top-0 left-0 right-0 h-2 cursor-ns-resize z-10" />
                  <div className={`text-sm font-medium truncate ${past ? 'text-text-tertiary' : 'text-white'}`}>{ev.title}</div>
                  <div className={`text-xs truncate ${past ? 'text-text-tertiary' : 'text-white/90'}`} style={{ fontFamily: MONO }}>
                    {fmtMin(sMin)} – {fmtMin(eMin)}
                  </div>
                  {ev.location && <div className={`text-xs truncate ${past ? 'text-text-tertiary' : 'text-white/90'}`}>{ev.location}</div>}
                  {/* Poignée de redimensionnement — bas (heure de fin) */}
                  <div onPointerDown={startResize(ev, 'bottom')} onClick={e => e.stopPropagation()} draggable={false}
                    className="absolute bottom-0 left-0 right-0 h-2 cursor-ns-resize z-10" />
                </div>
              )
            })}
            {/* Ligne « maintenant » — point et trait centrés verticalement sur l'heure courante */}
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

function WeekView({ date, events, calendars, onEventClick, onEventContextMenu, onEventDrop, onEventResize, weatherByDate }: {
  date: Date; events: EventInstance[]; calendars: Calendar[]
  onEventClick: (ev: EventInstance) => void
  onEventContextMenu: (e: React.MouseEvent, ev: EventInstance) => void
  onEventDrop: (ev: EventInstance, newStart: Date) => void
  onEventResize: (ev: EventInstance, newStart: Date, newEnd: Date) => void
  weatherByDate: Map<string, DailyWeather>
}) {
  const { i18n } = useTranslation('calendar')
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

  // Helpers partagés avec la vue Jour : fuseaux, police mono, heure courante temps réel.
  const PX_PER_HOUR = 40
  const MONO = "'JetBrains Mono', ui-monospace, monospace"
  const now = useNowTick()
  const secondaryTimezone = useCalendarStore(s => s.secondaryTimezone)
  const localTz = useMemo(() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone } catch { return 'UTC' } }, [])
  const tzOffsetLabel = (tz: string) => { try { return new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' }).formatToParts(date).find(p => p.type === 'timeZoneName')?.value ?? '' } catch { return '' } }
  const tzHourLabel = (tz: string, h: number) => { const inst = new Date(date); inst.setHours(h, 0, 0, 0); try { return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(inst) } catch { return '' } }
  const fmtMin = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
  const minOf = (iso: string) => { const d = parseISO(iso); return d.getHours() * 60 + d.getMinutes() }
  const nowTop = (now.getHours() + now.getMinutes() / 60 + now.getSeconds() / 3600) * PX_PER_HOUR

  // Redimensionnement vertical (poignées haut/bas → début/fin) — par jour.
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

  const gutterCols = secondaryTimezone ? '52px 52px' : '60px'
  const gridCols = `${gutterCols} repeat(7, minmax(0, 1fr))`
  const gutter = (labelFor: (h: number) => string) => (
    <div className="border-r border-border">
      {hours.map(h => (
        <div key={h} className="h-10 flex items-start justify-end pr-2 pt-0.5">
          {h > 0 && <span className="text-xs text-text-tertiary tabular-nums" style={{ fontFamily: MONO }}>{labelFor(h)}</span>}
        </div>
      ))}
    </div>
  )

  return (
    <div className="flex-1 overflow-hidden flex flex-col">
      {/* En-têtes jours (+ libellés de fuseaux dans la/les gouttière(s)) */}
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
              {/* Météo compacte */}
              {wx && (
                <div className="flex items-center justify-center gap-0.5 mt-0.5">
                  <img src={weatherIconUrl(wx.weather_code, true)} alt="" width={20} height={20} style={{ width: 20, height: 20 }} draggable={false} />
                  <span className="text-[10px] text-text-secondary">{Math.round(wx.temp_max)}°/{Math.round(wx.temp_min)}°</span>
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* Grille horaire */}
      <div className="flex-1 overflow-y-auto">
        <div className="grid" style={{ minHeight: '960px', gridTemplateColumns: gridCols }}>
          {secondaryTimezone && gutter(h => tzHourLabel(secondaryTimezone, h))}
          {gutter(h => `${String(h).padStart(2, '0')}:00`)}
          {days.map(day => {
            const weekend  = isWeekend(day)
            const dayEvs   = eventsForDay(day)
            return (
              <div key={day.toISOString()}
                onDragOver={e => { if (!draggingRef.current) return; e.preventDefault(); const rect = e.currentTarget.getBoundingClientRect(); const y = e.clientY - rect.top; let m = Math.round((y / 40 * 60) / 15) * 15; m = Math.max(0, Math.min(24 * 60 - 15, m)); setGhost({ dayKey: day.toISOString(), min: m }) }}
                onDrop={e => { const drag = draggingRef.current; if (drag && ghost) { e.preventDefault(); const ns = new Date(day); ns.setHours(Math.floor(ghost.min / 60), ghost.min % 60, 0, 0); onEventDrop(drag, ns) } draggingRef.current = null; setDragging(null); setGhost(null) }}
                className={`border-r border-border relative ${weekend ? 'bg-surface-1/40' : ''}`}>
                {hours.map(h => <div key={h} className="h-10 border-b border-border/50" />)}
                {dragging && ghost?.dayKey === day.toISOString() && (
                  <div className="absolute left-0.5 right-0.5 rounded bg-primary/20 border border-dashed border-primary pointer-events-none z-20"
                    style={{ top: ghost.min * 40 / 60, height: ghostHeight }}>
                    <div className="text-[10px] font-medium text-primary px-1" style={{ fontFamily: MONO }}>{String(Math.floor(ghost.min / 60)).padStart(2, '0')}:{String(ghost.min % 60).padStart(2, '0')}</div>
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
                  return (
                    <div key={ev.id}
                      draggable
                      onDragStart={e => { if (resizingRef.current) { e.preventDefault(); return } draggingRef.current = ev; setDragging(ev) }}
                      onDragEnd={() => { draggingRef.current = null; setDragging(null); setGhost(null) }}
                      onClick={() => { if (!isResizing) onEventClick(ev) }}
                      onContextMenu={e => onEventContextMenu(e, ev)}
                      style={{ top, height, backgroundColor: past ? color + '24' : color, opacity: dragging?.id === ev.id ? 0.4 : 1 }}
                      className="absolute left-0.5 right-0.5 rounded px-1 py-0.5 cursor-pointer overflow-hidden hover:opacity-90 active:cursor-grabbing">
                      <div onPointerDown={startResize(ev, day, 'top')} onClick={e => e.stopPropagation()} draggable={false}
                        className="absolute top-0 left-0 right-0 h-1.5 cursor-ns-resize z-10" />
                      <div className={`text-xs font-medium truncate ${past ? 'text-text-tertiary' : 'text-white'}`}>{ev.title}</div>
                      <div className={`text-[10px] truncate ${past ? 'text-text-tertiary' : 'text-white/90'}`} style={{ fontFamily: MONO }}>{fmtMin(sMin)} – {fmtMin(eMin)}</div>
                      <div onPointerDown={startResize(ev, day, 'bottom')} onClick={e => e.stopPropagation()} draggable={false}
                        className="absolute bottom-0 left-0 right-0 h-1.5 cursor-ns-resize z-10" />
                    </div>
                  )
                })}
                {/* Ligne « maintenant » dans la colonne du jour courant */}
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

  // Référence « maintenant » (temps réel) pour estomper les événements déjà passés.
  const now = useNowTick(60_000)

  return (
    <div className="flex-1 overflow-hidden flex flex-col">
      {/* En-têtes jours de la semaine */}
      <div className="grid grid-cols-7 border-b border-border">
        {weekdaysShort.map((d, i) => (
          <div key={i}
            className={`py-2 text-center text-xs font-medium uppercase
                        ${i >= 5 ? 'text-text-tertiary' : 'text-text-tertiary'}`}>
            {d}
          </div>
        ))}
      </div>

      {/* Grille jours — nombre de rangées dynamique (4, 5 ou 6 semaines) pour remplir toute la hauteur */}
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
                          transition-colors hover:bg-primary/5
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
                {/* Météo compacte dans la cellule */}
                {wx && (
                  <span className="flex items-center gap-0.5 text-[10px] text-text-tertiary leading-none pr-0.5">
                    <img src={weatherIconUrl(wx.weather_code, true)} alt="" width={16} height={16} style={{ width: 16, height: 16 }} draggable={false} />
                    <span>{Math.round(wx.temp_max)}°</span>
                  </span>
                )}
              </div>
              <div className="space-y-0.5 overflow-hidden">
                {dayEvs.slice(0, 4).map(ev => {
                  const cal   = calMap.get(ev.calendar_id)
                  const color = ev.color ?? cal?.color ?? '#4D38DB'
                  const past  = parseISO(ev.ends_at) < now
                  return (
                    <div key={ev.id}
                      draggable
                      onDragStart={e => { e.stopPropagation(); e.dataTransfer.setData('text/plain', ev.id); e.dataTransfer.effectAllowed = 'move' }}
                      onClick={e => { e.stopPropagation(); onEventClick(ev) }}
                      onContextMenu={e => { e.stopPropagation(); onEventContextMenu(e, ev) }}
                      className="flex items-center gap-1.5 text-xs px-1 py-0.5 rounded cursor-pointer hover:bg-surface-2"
                      title={ev.title}>
                      <span className="w-1.5 h-1.5 rounded-full shrink-0"
                        style={{ backgroundColor: color, opacity: past ? 0.35 : 1 }} />
                      {!ev.all_day && (
                        <span className={`shrink-0 tabular-nums ${past ? 'text-text-tertiary' : 'text-text-secondary'}`}>
                          {format(parseISO(ev.starts_at), 'HH:mm')}
                        </span>
                      )}
                      <span className={`truncate min-w-0 ${past ? 'text-text-tertiary' : 'text-text-primary font-medium'}`}>
                        {ev.title}
                      </span>
                    </div>
                  )
                })}
                {dayEvs.length > 4 && (
                  <div className="text-xs text-text-tertiary px-1">{t('more_events', { count: dayEvs.length - 4 })}</div>
                )}
                {/* Items superposés par d'autres modules (point d'extension générique) */}
                {(overlayByDate.get(format(day, 'yyyy-MM-dd')) ?? []).slice(0, 2).map(it => {
                  const chip = (
                    <div
                      style={{ borderLeft: `3px solid ${it.color ?? '#80868b'}` }}
                      className="flex items-center gap-1 text-xs px-1 py-0.5 rounded bg-surface-2 truncate"
                      title={it.title}>
                      <span className={it.done ? 'line-through text-text-tertiary' : ''}>{it.title}</span>
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
  const { i18n } = useTranslation('calendar')
  const days = calendarGrid(month)
  const weekdaysShort = useMemo(() => {
    const lc = getDateLocale(i18n.language)
    const base = startOfWeek(new Date(), { weekStartsOn: 1 })
    return Array.from({ length: 7 }, (_, i) => format(addDays(base, i), 'EEE', { locale: lc }))
  }, [i18n.language])
  // Couleurs des indicateurs (événements + tâches) par jour → carrés colorés sous le jour.
  const colorsByDay = useMemo(() => {
    const m = new Map<string, string[]>()
    const add = (k: string, c: string) => { const a = m.get(k); if (a) a.push(c); else m.set(k, [c]) }
    events.forEach(ev => { if (isSameMonth(parseISO(ev.starts_at), month)) add(format(parseISO(ev.starts_at), 'yyyy-MM-dd'), ev.color ?? '#4D38DB') })
    overlayByDate.forEach((items, k) => { if (k.startsWith(format(month, 'yyyy-MM'))) items.forEach(it => add(k, it.color ?? '#80868b')) })
    return m
  }, [events, overlayByDate, month])

  return (
    <div className="p-3 flex flex-col h-full">
      <button onClick={() => onMonthClick(month)}
        className="text-base font-semibold text-text-primary hover:text-primary mb-2 capitalize block w-full text-center">
        {format(month, 'MMMM', { locale: getDateLocale(i18n.language) })}
      </button>
      <div className="grid grid-cols-7 mb-1">
        {weekdaysShort.map((d, i) => (
          <div key={i} className={`text-center text-[10px] uppercase tracking-wide ${i >= 5 ? 'text-text-tertiary/60' : 'text-text-tertiary'}`}>
            {d}
          </div>
        ))}
      </div>
      {/* Jours : numéro + carrés colorés (événements & tâches). Le détail s'ouvre dans
          une box FLOTTANTE (cf. YearView), donc la grille remplit la hauteur de la carte. */}
      <div className="grid grid-cols-7 flex-1 auto-rows-fr">
        {days.map(day => {
          const inMonth  = isSameMonth(day, month)
          const today    = isToday(day)
          const weekend  = isWeekend(day)
          const isSel    = inMonth && selectedDay != null && isSameDay(day, selectedDay)
          const dots     = inMonth ? (colorsByDay.get(format(day, 'yyyy-MM-dd')) ?? []) : []
          return (
            <button key={day.toISOString()} type="button"
              onClick={e => inMonth && onSelectDay(day, e.currentTarget.getBoundingClientRect())}
              className="flex flex-col items-center justify-start gap-0.5 pt-1 outline-none">
              <span className={`text-sm w-7 h-7 flex items-center justify-center rounded-full transition-colors
                ${today    ? 'bg-primary text-white font-bold'
                  : isSel    ? 'ring-2 ring-primary text-primary font-semibold'
                  : !inMonth ? 'text-text-tertiary/30'
                  : weekend  ? 'text-text-tertiary hover:bg-surface-2'
                  : 'text-text-primary hover:bg-surface-2'}`}>
                {format(day, 'd')}
              </span>
              <span className="flex items-center justify-center gap-0.5 h-2">
                {dots.slice(0, 3).map((c, i) => (
                  <span key={i} className="w-1.5 h-1.5 rounded-[2px]" style={{ backgroundColor: c }} />
                ))}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

// Box FLOTTANTE (portail) listant les événements et tâches d'un jour sélectionné en vue Année.
function DayPopover({ day, rect, events, overlayByDate, onClose, onEventClick }: {
  day: Date; rect: DOMRect
  events: EventInstance[]
  overlayByDate: Map<string, CalendarOverlayItem[]>
  onClose: () => void
  onEventClick: (ev: EventInstance) => void
}) {
  const { t, i18n } = useTranslation('calendar')
  const loc = getDateLocale(i18n.language)
  const dayEvents = events.filter(ev => isSameDay(parseISO(ev.starts_at), day))
    .sort((a, b) => a.starts_at.localeCompare(b.starts_at))
  const tasks = overlayByDate.get(format(day, 'yyyy-MM-dd')) ?? []

  const W = 248
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
      <div className="cal-details fixed z-[56] bg-white rounded-lg shadow-xl border border-border p-3"
        style={pos} onClick={e => e.stopPropagation()}>
        <span className={`cal-arrow absolute w-2.5 h-2.5 rotate-45 bg-white ${placeAbove ? '-bottom-1.5 border-r border-b' : '-top-1.5 border-l border-t'} border-border`}
          style={{ left: arrowLeft - 5 }} />
        <div className="text-xs font-semibold text-text-primary mb-1.5 capitalize">
          {format(day, 'EEEE d MMMM', { locale: loc })}
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
              {!ev.all_day && <span className="text-text-tertiary tabular-nums shrink-0" style={{ fontFamily: "'JetBrains Mono', ui-monospace, monospace" }}>{format(parseISO(ev.starts_at), 'HH:mm')}</span>}
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

function YearView({ year, events, overlayByDate, onMonthClick, onEventClick }: {
  year: Date; events: EventInstance[]
  overlayByDate: Map<string, CalendarOverlayItem[]>
  onMonthClick: (month: Date) => void
  onEventClick: (ev: EventInstance) => void
}) {
  const months = useMemo(
    () => Array.from({ length: 12 }, (_, i) => new Date(year.getFullYear(), i, 1)),
    [year],
  )
  // Jour sélectionné + ancre (rect du bouton) pour positionner la box flottante.
  const [sel, setSel] = useState<{ day: Date; rect: DOMRect } | null>(null)
  const selectDay = (day: Date, rect: DOMRect) =>
    setSel(prev => (prev && isSameDay(prev.day, day) ? null : { day, rect }))
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') setSel(null) }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [])
  return (
    <div className="flex-1 overflow-y-auto p-4 md:p-6">
      {/* h-full + auto-rows-fr : les mois remplissent la hauteur (la box de détail flotte
          au-dessus via un portail, donc elle ne perturbe pas cette grille). */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4 h-full auto-rows-fr">
        {months.map(m => (
          <div key={m.toISOString()}
            className="border border-border rounded-xl bg-white hover:shadow-sm transition-shadow flex flex-col">
            <MiniMonth month={m} events={events} overlayByDate={overlayByDate} onMonthClick={onMonthClick}
              selectedDay={sel?.day ?? null} onSelectDay={selectDay} />
          </div>
        ))}
      </div>
      {sel && (
        <DayPopover day={sel.day} rect={sel.rect} events={events} overlayByDate={overlayByDate}
          onClose={() => setSel(null)} onEventClick={onEventClick} />
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
                      : `${format(start, 'd MMM, HH:mm', { locale: getDateLocale(i18n.language) })} – ${format(end, 'HH:mm')}`}
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
      navigate(`/calendar/${viewMode}`, { replace: true })     // /calendar nu → reflète la vue
    }
  }, [view, location.pathname]) // eslint-disable-line react-hooks/exhaustive-deps

  // store → URL : un changement de vue (toolbar, drill-down année→mois…) met l'URL à jour.
  // On ignore le 1er rendu pour ne pas écraser une URL profonde (ex: accès direct
  // à /calendar/day) avant que l'effet URL→store n'ait synchronisé le store.
  const viewSyncMounted = useRef(false)
  useEffect(() => {
    if (!viewSyncMounted.current) { viewSyncMounted.current = true; return }
    if (view && (VIEW_PATHS as string[]).includes(view) && view !== viewMode) {
      navigate(`/calendar/${viewMode}`)
    }
  }, [viewMode]) // eslint-disable-line react-hooks/exhaustive-deps

  const [createDay,     setCreateDay]     = useState<Date | null>(null)
  const [selectedEvent, setSelectedEvent] = useState<EventInstance | null>(null)
  const [editingEvent,  setEditingEvent]  = useState<EventInstance | null>(null)
  const [ctxMenu,       setCtxMenu]       = useState<CtxMenuState | null>(null)

  // Ouvre la modale de création quand un déclencheur externe (ex: sidebar) la demande
  useEffect(() => {
    if (pendingCreateDate) {
      setCreateDay(pendingCreateDate)
      setPendingCreate(null)
    }
  }, [pendingCreateDate, setPendingCreate])

  const handleEventContextMenu = useCallback((e: React.MouseEvent, ev: EventInstance) => {
    e.preventDefault()
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

  const handleCtxDelete = useCallback(() => {
    if (!ctxMenu) return
    calendarApi.deleteEvent(ctxMenu.event.event_id, 'this').then(() => {
      qc.invalidateQueries({ queryKey: ['calendar-events'] })
      if (selectedEvent?.event_id === ctxMenu.event.event_id) setSelectedEvent(null)
    })
  }, [ctxMenu, qc, selectedEvent])

  // ── Glisser-déposer / redimensionnement d'événements (changement d'horaires) ──
  // newStart + newEnd explicites : couvre le déplacement (durée conservée) ET le
  // redimensionnement (début et/ou fin modifiés indépendamment).
  const [pendingMove, setPendingMove] = useState<{ ev: EventInstance; newStart: Date; newEnd: Date } | null>(null)

  const applyMove = useCallback((ev: EventInstance, newStart: Date, newEnd: Date, scope: 'this' | 'following') => {
    calendarApi.updateEvent(ev.event_id, {
      starts_at: newStart.toISOString(),
      ends_at:   newEnd.toISOString(),
      scope,
    }).then(() => qc.invalidateQueries({ queryKey: ['calendar-events'] }))
  }, [qc])

  const handleEventDrop = useCallback((ev: EventInstance, newStart: Date) => {
    if (Math.abs(newStart.getTime() - parseISO(ev.starts_at).getTime()) < 60000) return  // pas de changement
    const durationMs = parseISO(ev.ends_at).getTime() - parseISO(ev.starts_at).getTime()
    const newEnd = new Date(newStart.getTime() + durationMs)
    if (ev.is_recurring) setPendingMove({ ev, newStart, newEnd })   // demander la portée
    else                 applyMove(ev, newStart, newEnd, 'this')
  }, [applyMove])

  const handleEventResize = useCallback((ev: EventInstance, newStart: Date, newEnd: Date) => {
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
  // Masquer les événements des calendriers décochés dans la sidebar
  const events = (evData?.events ?? []).filter(
    (ev) => !hiddenCalendarIds.includes(ev.calendar_id),
  )

  // ── Overlays fournis par d'autres modules (point d'extension générique) ──
  // Calendar ne connaît aucun module en particulier : il agrège les providers
  // enregistrés (ex: tasks superpose ses échéances). Voir core/registry/calendarOverlay.
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
            <DayView date={currentDate} events={events} calendars={calendars}
              onEventClick={setSelectedEvent}
              onEventContextMenu={handleEventContextMenu}
              onEventDrop={handleEventDrop}
              onEventResize={handleEventResize}
              weatherByDate={weatherByDate} />
          )}
          {viewMode === 'week' && (
            <WeekView date={currentDate} events={events} calendars={calendars}
              onEventClick={setSelectedEvent}
              onEventContextMenu={handleEventContextMenu}
              onEventDrop={handleEventDrop}
              onEventResize={handleEventResize}
              weatherByDate={weatherByDate} />
          )}
          {viewMode === 'month' && (
            <MonthView month={currentDate} events={events} calendars={calendars}
              onDayClick={setCreateDay}
              onEventClick={setSelectedEvent}
              onEventContextMenu={handleEventContextMenu}
              onEventDrop={handleEventDrop}
              weatherByDate={weatherByDate}
              overlayByDate={overlayByDate} />
          )}
          {viewMode === 'year' && (
            <YearView year={currentDate} events={events} overlayByDate={overlayByDate}
              onMonthClick={handleMonthClick} onEventClick={setSelectedEvent} />
          )}
        </>
      )}

      {/* Context menu (clic droit sur un événement) */}
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

      {/* Choix de portée lors du déplacement d'un événement récurrent */}
      {pendingMove && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center" onClick={() => setPendingMove(null)}>
          <div className="absolute inset-0 bg-black/30" />
          <div className="relative bg-white rounded-2xl shadow-xl w-full max-w-sm p-5" onClick={(e) => e.stopPropagation()}>
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

      {/* Modals */}
      {createDay !== null && (
        <CreateEventModal initialDate={createDay} calendars={calendars}
          onClose={() => setCreateDay(null)} />
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
