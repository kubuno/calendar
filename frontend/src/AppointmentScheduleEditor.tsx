import { useEffect, useMemo, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Button, Input, Dropdown, NumberInput, Textarea, Checkbox, Radio, DatePicker, useIsMobile } from '@ui'
import { useAuthStore } from '@kubuno/sdk'
import {
  Clock, Plus, Trash2, Ban, Copy, MapPin, AlignLeft, ListChecks, Mail,
  CalendarDays, UserCircle2, ChevronRight, X,
} from 'lucide-react'
import { calendarApi, appointmentApi, type AppointmentSchedule, type AvailabilityRule, type BookingFormField, type SaveScheduleDto } from './api'
import { useUserTimezone } from './timezones'
import { MonoText } from './MonoText'

// ── Time helpers (minutes from midnight ⇄ "HH:MM") ──────────────────────────
const toTime = (min: number) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`
const toMin  = (t: string) => { const [h, m] = t.split(':').map(Number); return (h || 0) * 60 + (m || 0) }

interface Range { start: number; end: number }
type Weekly = Record<number, Range[]>          // weekday 0=Mon … 6=Sun → ranges
interface DateOverride { date: string; ranges: Range[] }

const DURATIONS = [15, 20, 30, 45, 60, 90, 120]

// Full IANA timezone list when the engine exposes it (all modern browsers do),
// with a curated fallback so the dropdown always covers the common cases.
const TIMEZONES: string[] = (() => {
  try {
    const vals = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone')
    if (vals && vals.length) return vals
  } catch { /* older engine */ }
  return [
    'UTC', 'Europe/Paris', 'Europe/London', 'Europe/Berlin', 'Europe/Madrid', 'Europe/Rome',
    'Europe/Brussels', 'Europe/Lisbon', 'Europe/Zurich', 'Europe/Moscow', 'Africa/Casablanca',
    'Africa/Douala', 'Africa/Abidjan', 'Africa/Dakar', 'America/New_York', 'America/Chicago',
    'America/Denver', 'America/Los_Angeles', 'America/Sao_Paulo', 'Asia/Dubai', 'Asia/Kolkata',
    'Asia/Shanghai', 'Asia/Tokyo', 'Australia/Sydney',
  ]
})()

const DEFAULT_WEEKLY: Weekly = {
  0: [{ start: 540, end: 1020 }], 1: [{ start: 540, end: 1020 }], 2: [{ start: 540, end: 1020 }],
  3: [{ start: 540, end: 1020 }], 4: [{ start: 540, end: 1020 }], 5: [], 6: [],
}

function rulesToWeekly(rules: AvailabilityRule[]): { weekly: Weekly; overrides: DateOverride[] } {
  const weekly: Weekly = { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] }
  const ovMap = new Map<string, Range[]>()
  for (const r of rules) {
    if (r.weekday != null) weekly[r.weekday].push({ start: r.start_minute, end: r.end_minute })
    else if (r.specific_date) {
      const arr = ovMap.get(r.specific_date) ?? []
      arr.push({ start: r.start_minute, end: r.end_minute })
      ovMap.set(r.specific_date, arr)
    }
  }
  const overrides = [...ovMap.entries()].map(([date, ranges]) => ({ date, ranges })).sort((a, b) => a.date.localeCompare(b.date))
  return { weekly, overrides }
}

function weeklyToRules(weekly: Weekly, overrides: DateOverride[]): AvailabilityRule[] {
  const out: AvailabilityRule[] = []
  for (let d = 0; d <= 6; d++)
    for (const r of weekly[d]) out.push({ weekday: d, specific_date: null, start_minute: r.start, end_minute: r.end })
  for (const o of overrides)
    for (const r of o.ranges) out.push({ weekday: null, specific_date: o.date, start_minute: r.start, end_minute: r.end })
  return out
}

// ── Draft shape ─────────────────────────────────────────────────────────────
interface Draft {
  title: string; duration: number; timezone: string
  weekly: Weekly; overrides: DateOverride[]
  windowType: 'rolling' | 'fixed'; maxDays: number | null; minHours: number | null
  startDate: string | null; endDate: string | null
  buffer: number | null; maxPerDay: number | null; guests: boolean
  calendarId: string
  locationType: 'none' | 'in_person' | 'phone' | 'video'; locationDetails: string
  description: string; formFields: BookingFormField[]; reminders: number[]
}

// ── Section shell ───────────────────────────────────────────────────────────
function Section({ icon, title, subtitle, children }: { icon: React.ReactNode; title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3 py-4 border-b border-border last:border-0">
      <div className="shrink-0 pt-0.5 text-text-tertiary">{icon}</div>
      <div className="flex-1 min-w-0">
        <h3 className="text-[15px] font-medium text-text-primary">{title}</h3>
        {subtitle && <p className="text-xs text-text-secondary mt-0.5">{subtitle}</p>}
        <div className="mt-3">{children}</div>
      </div>
    </div>
  )
}

// ── Full page (two panes: settings | week preview) ──────────────────────────
export default function AppointmentSchedulePage() {
  const { t } = useTranslation('calendar')
  const { id } = useParams()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const me = useAuthStore(s => s.user)
  const editingId = id && id !== 'new' ? id : null
  const close = () => navigate('/calendar')

  const [step, setStep] = useState<1 | 2>(1)
  // The zone a new schedule defaults to: the host's own, not the machine's.
  const hostTz = useUserTimezone()

  // Two-pane layout is driven in JS (`useIsMobile` from @ui): module responsive
  // utilities (`lg:w-[600px]`) are overridden by the host's base utilities
  // (utilities layer > kubuno-module), so a plain `lg:` variant can't shrink
  // the `w-full` pane. See responsive-layer gotcha.
  const isMobile = useIsMobile()

  const { data: loaded, isLoading } = useQuery({
    queryKey: ['appointment-schedule', editingId],
    queryFn:  () => appointmentApi.get(editingId!),
    enabled:  !!editingId,
  })
  const { data: calData } = useQuery({ queryKey: ['calendar-calendars'], queryFn: calendarApi.listCalendars })
  // Bookings create events on this calendar → only owned calendars are eligible.
  const calendars = (calData?.calendars ?? []).filter(c => c.my_permission === 'owner')

  const [draft, setDraft] = useState<Draft | null>(null)
  const seedReady = !!calData && (!editingId || !!loaded)
  if (draft === null && seedReady) {
    const sched = loaded?.schedule as AppointmentSchedule | undefined
    const { weekly, overrides } = sched?.availability ? rulesToWeekly(sched.availability) : { weekly: structuredClone(DEFAULT_WEEKLY), overrides: [] }
    const defCal = calendars.find(c => c.is_default) ?? calendars[0]
    setDraft({
      title: sched?.title ?? '', duration: sched?.duration_minutes ?? 60, timezone: sched?.timezone ?? hostTz,
      weekly, overrides,
      windowType: sched?.window_type ?? 'rolling', maxDays: sched?.window_max_days ?? 60, minHours: sched?.window_min_hours ?? 4,
      startDate: sched?.window_start_date ?? null, endDate: sched?.window_end_date ?? null,
      buffer: sched?.buffer_minutes ?? null, maxPerDay: sched?.max_per_day ?? null, guests: sched?.guests_can_invite ?? true,
      calendarId: sched?.calendar_id ?? defCal?.id ?? '',
      locationType: sched?.location_type ?? 'none', locationDetails: sched?.location_details ?? '',
      description: sched?.description ?? '', formFields: sched?.form_fields ?? [], reminders: sched?.email_reminders ?? [1440],
    })
  }

  const save = useMutation({
    mutationFn: async () => {
      if (!draft) return
      const dto: SaveScheduleDto = {
        calendar_id: draft.calendarId, title: draft.title, description: draft.description || null,
        duration_minutes: draft.duration, buffer_minutes: draft.buffer, max_per_day: draft.maxPerDay, timezone: draft.timezone,
        window_type: draft.windowType,
        window_max_days: draft.windowType === 'rolling' ? draft.maxDays : null,
        window_min_hours: draft.minHours,
        window_start_date: draft.windowType === 'fixed' ? draft.startDate : null,
        window_end_date: draft.windowType === 'fixed' ? draft.endDate : null,
        location_type: draft.locationType, location_details: draft.locationDetails || null,
        guests_can_invite: draft.guests,
        host_name: me?.display_name || me?.username || null, host_avatar_url: me?.avatar_url || null,
        form_fields: draft.formFields, email_reminders: draft.reminders,
        availability: weeklyToRules(draft.weekly, draft.overrides),
      }
      return editingId ? appointmentApi.update(editingId, dto) : appointmentApi.create(dto)
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['appointment-schedules'] })
      if (editingId) qc.invalidateQueries({ queryKey: ['appointment-schedule', editingId] })
      close()
    },
  })

  return (
    <div className="flex flex-1 min-h-0 bg-surface-1 rounded-xl overflow-hidden">
      {/* ── Settings pane ── */}
      <div className={`${isMobile ? 'w-full' : 'w-[600px] shrink-0 border-r'} flex flex-col bg-white border-border min-h-0`}>
        <header className="flex items-center gap-3 px-5 h-14 border-b border-border shrink-0">
          <Clock size={18} className="text-primary" />
          <h1 className="flex-1 text-[15px] font-medium text-text-primary">
            {editingId ? t('appt_edit_title', { defaultValue: 'Modifier le planning' }) : t('appt_new_title', { defaultValue: 'Planning de rendez-vous réservables' })}
          </h1>
          <button onClick={close} className="p-2 -mr-2 rounded-full hover:bg-surface-2 text-text-secondary" aria-label={t('common_close', { defaultValue: 'Fermer' })}><X size={18} /></button>
        </header>

        {!draft || isLoading ? (
          <div className="p-10 text-center text-sm text-text-secondary">{t('common_loading', { defaultValue: 'Chargement…' })}</div>
        ) : (
          <>
            <div className="flex-1 overflow-y-auto px-5 min-h-0">
              <input
                autoFocus value={draft.title}
                onChange={e => setDraft({ ...draft, title: e.target.value })}
                placeholder={t('appt_add_title', { defaultValue: 'Ajouter un titre' })}
                className="w-full text-2xl font-light text-text-primary bg-transparent border-b-2 border-border focus:border-primary outline-none py-3 my-2"
              />
              {step === 1
                ? <StepOne draft={draft} setDraft={setDraft} calendars={calendars} t={t} />
                : <StepTwo draft={draft} setDraft={setDraft} me={me} t={t} />}
            </div>
            <div className="flex items-center justify-between gap-2 px-5 py-3 border-t border-border shrink-0">
              {step === 2
                ? <Button variant="secondary" onClick={() => setStep(1)}>{t('appt_back', { defaultValue: 'Retour' })}</Button>
                : <Button variant="ghost" onClick={close}>{t('common_cancel', { defaultValue: 'Annuler' })}</Button>}
              {step === 1
                ? <Button onClick={() => setStep(2)} disabled={!draft.calendarId}>{t('appt_next', { defaultValue: 'Suivant' })}</Button>
                : <Button onClick={() => save.mutate()} loading={save.isPending}>{t('appt_save', { defaultValue: 'Enregistrer' })}</Button>}
            </div>
          </>
        )}
      </div>

      {/* ── Week availability preview ── */}
      {!isMobile && (
        <div className="flex flex-1 min-w-0 bg-white ml-1 rounded-xl overflow-hidden">
          {draft && <AvailabilityPreview weekly={draft.weekly} color={'#1a73e8'} t={t} />}
        </div>
      )}
    </div>
  )
}

// ── Week preview: a live 7-day grid of the weekly availability ───────────────
function AvailabilityPreview({ weekly, color, t }: { weekly: Weekly; color: string; t: (k: string, o?: Record<string, unknown>) => string }) {
  const WD = [
    t('wd_mon', { defaultValue: 'Lun.' }), t('wd_tue', { defaultValue: 'Mar.' }), t('wd_wed', { defaultValue: 'Mer.' }),
    t('wd_thu', { defaultValue: 'Jeu.' }), t('wd_fri', { defaultValue: 'Ven.' }), t('wd_sat', { defaultValue: 'Sam.' }), t('wd_sun', { defaultValue: 'Dim.' }),
  ]
  const START_H = 7, END_H = 20
  const hours = Array.from({ length: END_H - START_H + 1 }, (_, i) => START_H + i)
  const pxPerMin = 0.9
  const top = (min: number) => (min - START_H * 60) * pxPerMin
  const height = (a: number, b: number) => (b - a) * pxPerMin

  // Monday of the current week, for realistic date labels.
  const monday = useMemo(() => {
    const d = new Date(); const day = (d.getDay() + 6) % 7
    d.setDate(d.getDate() - day); d.setHours(0, 0, 0, 0); return d
  }, [])

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Header lives INSIDE the scroll container (sticky) so it shares the body's
          content width — both minus the scrollbar — keeping columns aligned. */}
      <div className="flex-1 overflow-y-auto">
        {/* Day headers */}
        <div className="grid sticky top-0 z-10 bg-white border-b border-border" style={{ gridTemplateColumns: '48px repeat(7,1fr)' }}>
          <div />
          {WD.map((label, d) => {
            const date = new Date(monday); date.setDate(monday.getDate() + d)
            return (
              <div key={d} className="text-center py-2 border-l border-border">
                <div className="text-[11px] uppercase tracking-wide text-text-tertiary">{label}</div>
                <div className="text-sm text-text-secondary">{date.getDate()}</div>
              </div>
            )
          })}
        </div>
        {/* Grid */}
        <div className="grid relative" style={{ gridTemplateColumns: '48px repeat(7,1fr)', height: (END_H - START_H + 1) * 60 * pxPerMin }}>
          {/* Hour gutter */}
          <div className="relative">
            {hours.map(h => (
              <div key={h} className="absolute right-1 -translate-y-1/2 text-[11px] text-text-tertiary" style={{ top: top(h * 60) }}>
                <MonoText>{`${String(h).padStart(2, '0')}:00`}</MonoText>
              </div>
            ))}
          </div>
          {/* Day columns */}
          {[0, 1, 2, 3, 4, 5, 6].map(d => (
            <div key={d} className="relative border-l border-border">
              {hours.map(h => <div key={h} className="absolute left-0 right-0 border-t border-border/60" style={{ top: top(h * 60) }} />)}
              {(weekly[d] ?? []).map((r, i) => (
                <div key={i} className="absolute left-1 right-1 rounded-md border text-[11px] px-1.5 py-1 overflow-hidden"
                  style={{ top: top(r.start), height: Math.max(16, height(r.start, r.end)), background: `${color}1f`, borderColor: `${color}66`, color }}>
                  <MonoText>{toTime(r.start)}</MonoText> – <MonoText>{toTime(r.end)}</MonoText>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ── Step 1 ───────────────────────────────────────────────────────────────────
function StepOne({ draft, setDraft, calendars, t }: any) {
  const WEEKDAYS = [
    t('wd_mon', { defaultValue: 'Lun.' }), t('wd_tue', { defaultValue: 'Mar.' }), t('wd_wed', { defaultValue: 'Mer.' }),
    t('wd_thu', { defaultValue: 'Jeu.' }), t('wd_fri', { defaultValue: 'Ven.' }), t('wd_sat', { defaultValue: 'Sam.' }), t('wd_sun', { defaultValue: 'Dim.' }),
  ]
  const setDay = (d: number, ranges: Range[]) => setDraft({ ...draft, weekly: { ...draft.weekly, [d]: ranges } })

  return (
    <>
      <Section icon={<Clock size={20} />} title={t('appt_duration', { defaultValue: 'Durée des rendez-vous' })}
        subtitle={t('appt_duration_sub', { defaultValue: 'Combien de temps chaque rendez-vous doit-il durer ?' })}>
        <Dropdown height={36} fontSize={14} value={String(draft.duration)}
          onChange={v => setDraft({ ...draft, duration: Number(v) })}
          options={DURATIONS.map(d => ({ value: String(d), label: d < 60 ? `${d} min` : d === 60 ? '1 heure' : `${d / 60} heures` }))} />
      </Section>

      <Section icon={<CalendarDays size={20} />} title={t('appt_availability', { defaultValue: 'Disponibilités habituelles' })}
        subtitle={t('appt_availability_sub', { defaultValue: 'Définissez vos disponibilités habituelles pour les rendez-vous.' })}>
        <div className="flex flex-col gap-2">
          {WEEKDAYS.map((label: string, d: number) => {
            const ranges: Range[] = draft.weekly[d]
            return (
              <div key={d} className="flex items-start gap-2">
                <span className="w-10 shrink-0 text-sm text-text-secondary pt-2">{label}</span>
                <div className="flex-1 flex flex-col gap-1.5">
                  {ranges.length === 0 && <span className="text-sm text-text-tertiary pt-2">{t('appt_unavailable', { defaultValue: 'Indisponible' })}</span>}
                  {ranges.map((r, i) => (
                    <div key={i} className="flex items-center gap-1.5">
                      <DatePicker mode="time" size="sm" minuteStep={15} value={toTime(r.start)}
                        onChange={v => v && setDay(d, ranges.map((x, j) => j === i ? { ...x, start: toMin(v) } : x))} />
                      <span className="text-text-tertiary">–</span>
                      <DatePicker mode="time" size="sm" minuteStep={15} value={toTime(r.end)}
                        onChange={v => v && setDay(d, ranges.map((x, j) => j === i ? { ...x, end: toMin(v) } : x))} />
                      <button title={t('appt_remove', { defaultValue: 'Retirer' })} className="p-1.5 rounded-full hover:bg-surface-2 text-text-tertiary"
                        onClick={() => setDay(d, ranges.filter((_, j) => j !== i))}><Ban size={15} /></button>
                    </div>
                  ))}
                </div>
                <div className="flex items-center gap-0.5 pt-1">
                  <button title={t('appt_add_slot', { defaultValue: 'Ajouter' })} className="p-1.5 rounded-full hover:bg-surface-2 text-text-secondary"
                    onClick={() => setDay(d, [...ranges, ranges.length ? { ...ranges[ranges.length - 1] } : { start: 540, end: 1020 }])}><Plus size={16} /></button>
                  <button title={t('appt_copy', { defaultValue: 'Copier sur les autres jours' })} className="p-1.5 rounded-full hover:bg-surface-2 text-text-secondary"
                    onClick={() => { const copy: Weekly = { ...draft.weekly }; for (let k = 0; k <= 4; k++) copy[k] = ranges.map(x => ({ ...x })); setDraft({ ...draft, weekly: copy }) }}><Copy size={15} /></button>
                </div>
              </div>
            )
          })}
        </div>
        <div className="mt-3">
          <label className="text-xs text-text-secondary">{t('appt_timezone', { defaultValue: 'Fuseau horaire' })}</label>
          <Dropdown className="mt-1" width="100%" height={36} fontSize={14} dropdownMinWidth={260}
            value={draft.timezone} onChange={v => setDraft({ ...draft, timezone: v })}
            options={TIMEZONES.map(z => ({ value: z, label: z.replace(/_/g, ' ') }))} />
        </div>
      </Section>

      <Section icon={<ChevronRight size={20} />} title={t('appt_window', { defaultValue: 'Période de planification' })}
        subtitle={t('appt_window_sub', { defaultValue: 'Limiter la période pendant laquelle les rendez-vous peuvent être réservés' })}>
        <div className="flex flex-col gap-2 text-sm">
          <Radio checked={draft.windowType === 'rolling'} onChange={() => setDraft({ ...draft, windowType: 'rolling' })}
            label={t('appt_window_rolling', { defaultValue: 'Disponible maintenant' })} />
          <Radio checked={draft.windowType === 'fixed'} onChange={() => setDraft({ ...draft, windowType: 'fixed' })}
            label={t('appt_window_fixed', { defaultValue: 'Dates de début et de fin' })} />
          {draft.windowType === 'fixed' && (
            <div className="pl-6">
              <DatePicker mode="daterange" size="sm" clearable
                startValue={draft.startDate} endValue={draft.endDate}
                onRangeChange={(s, e) => setDraft({ ...draft, startDate: s, endDate: e })} />
            </div>
          )}
          <div className="flex items-center gap-2 mt-1">
            <Checkbox checked={draft.maxDays != null} onChange={c => setDraft({ ...draft, maxDays: c ? 60 : null })}
              label={t('appt_max_days', { defaultValue: 'Réservable jusqu’à' })} />
            <NumberInput className="w-20" min={1} disabled={draft.maxDays == null} value={draft.maxDays ?? 60}
              onChange={n => setDraft({ ...draft, maxDays: n })} />
            <span className="text-text-secondary">{t('appt_days', { defaultValue: 'jours à l’avance' })}</span>
          </div>
          <div className="flex items-center gap-2">
            <Checkbox checked={draft.minHours != null} onChange={c => setDraft({ ...draft, minHours: c ? 4 : null })}
              label={t('appt_min_hours', { defaultValue: 'Préavis minimum de' })} />
            <NumberInput className="w-20" min={0} disabled={draft.minHours == null} value={draft.minHours ?? 4}
              onChange={n => setDraft({ ...draft, minHours: n })} />
            <span className="text-text-secondary">{t('appt_hours', { defaultValue: 'heures' })}</span>
          </div>
        </div>
      </Section>

      <Section icon={<ListChecks size={20} />} title={t('appt_booked_settings', { defaultValue: 'Paramètres des rendez-vous réservés' })}>
        <div className="flex flex-col gap-2 text-sm">
          <div className="flex items-center gap-2">
            <Checkbox checked={draft.buffer != null} onChange={c => setDraft({ ...draft, buffer: c ? 15 : null })}
              label={t('appt_buffer', { defaultValue: 'Marge entre les rendez-vous' })} />
            <NumberInput className="w-20" min={0} disabled={draft.buffer == null} value={draft.buffer ?? 15}
              onChange={n => setDraft({ ...draft, buffer: n })} />
            <span className="text-text-secondary">min</span>
          </div>
          <div className="flex items-center gap-2">
            <Checkbox checked={draft.maxPerDay != null} onChange={c => setDraft({ ...draft, maxPerDay: c ? 4 : null })}
              label={t('appt_max_per_day', { defaultValue: 'Maximum de réservations par jour' })} />
            <NumberInput className="w-20" min={1} disabled={draft.maxPerDay == null} value={draft.maxPerDay ?? 4}
              onChange={n => setDraft({ ...draft, maxPerDay: n })} />
          </div>
          <Checkbox checked={draft.guests} onChange={c => setDraft({ ...draft, guests: c })}
            label={t('appt_guests', { defaultValue: 'Les invités peuvent inviter d’autres personnes' })} />
        </div>
      </Section>

      <Section icon={<CalendarDays size={20} />} title={t('appt_calendar', { defaultValue: 'Agenda' })}
        subtitle={t('appt_calendar_sub', { defaultValue: 'Où les rendez-vous réservés apparaîtront' })}>
        <Dropdown width="100%" height={36} fontSize={14} value={draft.calendarId}
          onChange={v => setDraft({ ...draft, calendarId: v })}
          options={calendars.map((c: any) => ({ value: c.id, label: c.name }))} />
      </Section>
    </>
  )
}

// ── Step 2 ───────────────────────────────────────────────────────────────────
function StepTwo({ draft, setDraft, me, t }: any) {
  const REMINDER_OPTS = [
    { v: 60, label: t('appt_rem_1h', { defaultValue: '1 heure avant' }) },
    { v: 1440, label: t('appt_rem_1d', { defaultValue: '1 jour avant' }) },
    { v: 2880, label: t('appt_rem_2d', { defaultValue: '2 jours avant' }) },
  ]
  const addField = () => setDraft({ ...draft, formFields: [...draft.formFields, { id: `f${Date.now()}`, label: '', type: 'text', required: false }] })

  return (
    <>
      <Section icon={<UserCircle2 size={20} />} title={t('appt_identity', { defaultValue: 'Photo et nom sur la page de réservation' })}>
        <div className="flex items-center gap-3">
          {me?.avatar_url
            ? <img src={me.avatar_url} alt="" className="w-9 h-9 rounded-full object-cover" />
            : <div className="w-9 h-9 rounded-full bg-primary/15 text-primary flex items-center justify-center text-sm font-medium">{(me?.display_name || me?.username || '?')[0]?.toUpperCase()}</div>}
          <span className="text-sm text-text-primary">{me?.display_name || me?.username}</span>
        </div>
      </Section>

      <Section icon={<MapPin size={20} />} title={t('appt_location', { defaultValue: 'Lieu et conférence' })}
        subtitle={t('appt_location_sub', { defaultValue: 'Où et comment se déroule le rendez-vous ?' })}>
        <Dropdown width="100%" height={36} fontSize={14} value={draft.locationType}
          onChange={v => setDraft({ ...draft, locationType: v })}
          options={[
            { value: 'none',      label: t('appt_loc_none', { defaultValue: 'Aucun / Je l’indiquerai plus tard' }) },
            { value: 'video',     label: t('appt_loc_video', { defaultValue: 'Visioconférence (lien)' }) },
            { value: 'in_person', label: t('appt_loc_inperson', { defaultValue: 'Réunion en présentiel' }) },
            { value: 'phone',     label: t('appt_loc_phone', { defaultValue: 'Appel téléphonique' }) },
          ]} />
        {draft.locationType !== 'none' && (
          <Input className="mt-2" value={draft.locationDetails}
            onChange={(e: any) => setDraft({ ...draft, locationDetails: e.target.value })}
            placeholder={draft.locationType === 'video' ? t('appt_loc_video_ph', { defaultValue: 'Lien de visioconférence' })
              : draft.locationType === 'in_person' ? t('appt_loc_addr_ph', { defaultValue: 'Adresse' })
              : t('appt_loc_phone_ph', { defaultValue: 'Numéro de téléphone' })} />
        )}
      </Section>

      <Section icon={<AlignLeft size={20} />} title={t('appt_description', { defaultValue: 'Description' })}
        subtitle={t('appt_description_sub', { defaultValue: 'Apparaît sur la page de réservation et dans les e-mails.' })}>
        <Textarea className="h-24 resize-y" value={draft.description}
          onChange={e => setDraft({ ...draft, description: e.target.value })}
          placeholder={t('appt_add_description', { defaultValue: 'Ajouter une description' })} />
      </Section>

      <Section icon={<ListChecks size={20} />} title={t('appt_form', { defaultValue: 'Formulaire de réservation' })}
        subtitle={t('appt_form_sub', { defaultValue: 'Champs demandés lors de la réservation' })}>
        <div className="flex flex-wrap gap-2 mb-2">
          {[t('appt_first_name', { defaultValue: 'Prénom' }), t('appt_last_name', { defaultValue: 'Nom' }), t('appt_email', { defaultValue: 'Adresse e-mail' })].map(l => (
            <span key={l} className="px-3 py-1.5 rounded-lg border border-border bg-surface-1 text-sm text-text-secondary">{l}*</span>
          ))}
        </div>
        {draft.formFields.map((f: BookingFormField, i: number) => (
          <div key={f.id} className="flex items-center gap-2 mb-1.5">
            <Input value={f.label} placeholder={t('appt_field_label', { defaultValue: 'Libellé du champ' })}
              onChange={(e: any) => setDraft({ ...draft, formFields: draft.formFields.map((x: BookingFormField, j: number) => j === i ? { ...x, label: e.target.value } : x) })} />
            <Checkbox checked={f.required} className="shrink-0" labelClassName="whitespace-nowrap"
              onChange={c => setDraft({ ...draft, formFields: draft.formFields.map((x: BookingFormField, j: number) => j === i ? { ...x, required: c } : x) })}
              label={t('appt_required', { defaultValue: 'Obligatoire' })} />
            <button className="p-1.5 rounded-full hover:bg-surface-2 text-text-tertiary" onClick={() => setDraft({ ...draft, formFields: draft.formFields.filter((_: any, j: number) => j !== i) })}><Trash2 size={15} /></button>
          </div>
        ))}
        <button className="mt-1 flex items-center gap-1.5 text-sm text-primary font-medium" onClick={addField}><Plus size={15} /> {t('appt_add_field', { defaultValue: 'Ajouter un élément' })}</button>
      </Section>

      <Section icon={<Mail size={20} />} title={t('appt_confirmations', { defaultValue: 'Confirmations et rappels des réservations' })}>
        <Checkbox checked disabled onChange={() => {}} className="mb-2"
          label={t('appt_calendar_invite', { defaultValue: 'Invitation Agenda' })} />
        {draft.reminders.map((r: number, i: number) => (
          <div key={i} className="flex items-center gap-2 mb-1.5">
            <Checkbox checked onChange={() => {}} />
            <Dropdown height={36} fontSize={14} value={String(r)}
              onChange={v => setDraft({ ...draft, reminders: draft.reminders.map((x: number, j: number) => j === i ? Number(v) : x) })}
              options={REMINDER_OPTS.map(o => ({ value: String(o.v), label: o.label }))} />
            <button className="p-1.5 rounded-full hover:bg-surface-2 text-text-tertiary" onClick={() => setDraft({ ...draft, reminders: draft.reminders.filter((_: any, j: number) => j !== i) })}><X size={15} /></button>
          </div>
        ))}
        <button className="mt-1 flex items-center gap-1.5 text-sm text-primary font-medium" onClick={() => setDraft({ ...draft, reminders: [...draft.reminders, 1440] })}><Plus size={15} /> {t('appt_add_reminder', { defaultValue: 'Ajouter un rappel' })}</button>
      </Section>
    </>
  )
}
