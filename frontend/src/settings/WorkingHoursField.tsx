// "Heures et lieu de travail" — the per-day working schedule, laid out like
// Google Calendar: a row of weekday pills to pick working days, then, for each
// working day, its time range(s) and a work location.
//
// The schedule is per-day (ranges + location), which the scalar-only settings
// manifest cannot express, so it is stored in the module's preference bag
// (`core.users.preferences.calendar.work_schedule`) via `useModulePrefs`.
//
// Every control has a real effect: the ranges shade the off-hours of each day in
// the Day/Week views, and the location shows in those views' day headers.
import { useMemo, useRef, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { formatDate, addDays, startOfWeek } from '@kubuno/sdk'
import {
  Building2, Building, Home, Ban, MapPin, Plus, X, Copy, HelpCircle,
} from 'lucide-react'
import { Checkbox, Dropdown, Tooltip, useIsMobile } from '@ui'
import { useModulePrefs } from '../userPrefs'
import {
  useCalendarSettings, defaultWorkSchedule, workDayFor,
  type WorkSchedule, type WorkDay, type WorkLocation, type WorkRange,
} from '../calendarSettings'

const DEFAULT_RANGE: WorkRange = { start: 540, end: 1020 }   // 09:00–17:00

const LOCATION_ICON: Record<WorkLocation, React.ReactNode> = {
  office:       <Building2 size={14} />,
  home:         <Home size={14} />,
  unspecified:  <Ban size={14} />,
  other_office: <Building size={14} />,
  elsewhere:    <MapPin size={14} />,
}

// ── minutes ↔ "HH:mm" (the value shape of <input type="time">) ──────────────────
const pad = (n: number) => String(n).padStart(2, '0')
const minToStr = (m: number) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`
const strToMin = (s: string) => {
  const [h, m] = s.split(':').map(Number)
  return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : 0
}

export default function WorkingHoursField() {
  const { t, i18n } = useTranslation('calendar')
  // Responsive is driven in JS: a module's `sm:`/`lg:` variants land in the
  // kubuno-module cascade layer and lose to the host's utilities, so they never
  // paint. See the module responsive-layer gotcha.
  const isMobile = useIsMobile()
  const { workingHoursEnabled, workSchedule, weekStartsOn, workingLocationAllowed } = useCalendarSettings()
  // Minimal defaults: they only fill missing keys — the current bag always wins,
  // so no existing preference is clobbered.
  const { update } = useModulePrefs<{ work_enabled: boolean; work_schedule: WorkSchedule }>(
    'calendar', { work_enabled: false, work_schedule: {} },
  )

  // Every mutation below is a read-modify-write of the whole schedule. Reading it
  // from the render closure is stale between two rapid clicks (no re-render fires
  // in between), so consecutive edits would each rebuild from the SAME base and
  // the last full-replacement would clobber the others. A synchronous ref, kept in
  // sync with the store, lets each edit build on the previous one immediately.
  const schedRef = useRef<WorkSchedule>(workSchedule)
  useEffect(() => { schedRef.current = workSchedule }, [workSchedule])

  const save = (next: WorkSchedule) => { schedRef.current = next; update({ work_schedule: next }) }

  const locationOptions = useMemo(() => ([
    { value: 'office',       label: t('work_loc_office',       { defaultValue: 'Bureau' }),        icon: LOCATION_ICON.office },
    { value: 'home',         label: t('work_loc_home',         { defaultValue: 'Domicile' }),      icon: LOCATION_ICON.home },
    { value: 'unspecified',  label: t('work_loc_unspecified',  { defaultValue: 'Non spécifié' }),  icon: LOCATION_ICON.unspecified },
    { value: 'other_office', label: t('work_loc_other_office', { defaultValue: 'Autre bureau' }),  icon: LOCATION_ICON.other_office },
    { value: 'elsewhere',    label: t('work_loc_elsewhere',    { defaultValue: 'Ailleurs' }),      icon: LOCATION_ICON.elsewhere },
  ]), [t])

  // Weekday cells for the pill row, and the ordered list of active work days,
  // both starting on the user's first day of week.
  const week = useMemo(() => {
    const base = startOfWeek(new Date(), weekStartsOn)
    return Array.from({ length: 7 }, (_, i) => {
      const dt = addDays(base, i)
      return {
        weekday: dt.getDay(),
        initial: formatDate(dt, 'weekdayNarrow').toUpperCase(),
        full:    formatDate(dt, 'weekday'),
      }
    })
  }, [weekStartsOn, i18n.language])

  const activeDays = week.filter(c => workDayFor(workSchedule, c.weekday))

  // ── Mutations ──────────────────────────────────────────────────────────────
  const toggleDay = (weekday: number) => {
    const cur = schedRef.current
    const next = { ...cur }
    if (workDayFor(cur, weekday)) delete next[weekday]
    else next[weekday] = { ranges: [{ ...DEFAULT_RANGE }], location: 'office' }
    save(next)
  }

  const patchDay = (weekday: number, patch: Partial<WorkDay>) =>
    save({ ...schedRef.current, [weekday]: { ...schedRef.current[weekday], ...patch } })

  const setRange = (weekday: number, idx: number, part: Partial<WorkRange>) => {
    const day = schedRef.current[weekday]
    const ranges = day.ranges.map((r, i) => (i === idx ? { ...r, ...part } : r))
    patchDay(weekday, { ranges })
  }

  const addRange = (weekday: number) => {
    const day  = schedRef.current[weekday]
    const last = day.ranges[day.ranges.length - 1]
    const start = Math.min(last.end, 22 * 60)
    patchDay(weekday, { ranges: [...day.ranges, { start, end: Math.min(start + 60, 24 * 60) }] })
  }

  const removeRange = (weekday: number, idx: number) => {
    const day = schedRef.current[weekday]
    if (day.ranges.length <= 1) { toggleDay(weekday); return }  // last range → day off
    patchDay(weekday, { ranges: day.ranges.filter((_, i) => i !== idx) })
  }

  // Copy the first active day's hours + location onto every other active day.
  const copyToAllDays = () => {
    const cur = schedRef.current
    const source = activeDays[0] && cur[activeDays[0].weekday]
    if (!source) return
    const next = { ...cur }
    for (const c of activeDays) {
      next[c.weekday] = { ranges: source.ranges.map(r => ({ ...r })), location: source.location, custom: source.custom }
    }
    save(next)
  }

  return (
    <div>
      <Checkbox
        checked={workingHoursEnabled}
        onChange={(v) => update({ work_enabled: v })}
        label={t('setting_working_hours_enabled', { defaultValue: 'Activer les heures de travail' })}
        description={t('work_hours_enable_help', {
          defaultValue: 'Ce paramètre informe vos contacts s’ils essaient de vous inviter à une réunion en dehors de vos heures de travail.',
        })}
      />

      {/* Weekday pills — pick which days are working days. */}
      <div className="flex items-center gap-2 mt-4">
        {week.map(c => {
          const on = !!workDayFor(workSchedule, c.weekday)
          return (
            <Tooltip key={c.weekday} label={c.full}>
              <button onClick={() => toggleDay(c.weekday)} aria-pressed={on} aria-label={c.full}
                className={`w-8 h-8 rounded-full transition-colors
                            ${on ? 'bg-primary text-white hover:bg-primary-hover'
                                 : 'bg-surface-2 text-text-secondary hover:bg-surface-3'}`}>
                {c.initial}
              </button>
            </Tooltip>
          )
        })}
      </div>

      {/* The days grid appears when there are working days AND there is something
          to configure: the hours (behind the toggle) and/or the location (an
          instance-wide admin permission, like Google Workspace). */}
      {activeDays.length > 0 && (workingHoursEnabled || workingLocationAllowed) && (
        <div className="mt-5">
          {/* Column headers + copy action (desktop layout only) */}
          {!isMobile && (
            <div className="flex items-center gap-3 pl-[92px] pb-2 text-xs text-text-tertiary uppercase tracking-wider">
              {workingHoursEnabled && (
                <span className="w-[210px]">{t('work_col_hours', { defaultValue: 'Heures de travail' })}</span>
              )}
              {workingLocationAllowed && (
                <span className="inline-flex items-center gap-1">
                  {t('work_col_location', { defaultValue: 'Lieu de travail' })}
                  <span title={t('work_location_help', { defaultValue: 'Indique votre lieu de travail aux utilisateurs qui vous invitent à un événement.' })}
                    className="text-text-tertiary cursor-help">
                    <HelpCircle size={12} />
                  </span>
                </span>
              )}
              {activeDays.length > 1 && (
                <button onClick={copyToAllDays}
                  className="ml-auto inline-flex items-center gap-1.5 text-primary hover:underline normal-case tracking-normal">
                  <Copy size={13} />{t('work_copy_all', { defaultValue: 'Copier pour tous les jours' })}
                </button>
              )}
            </div>
          )}
          {/* On mobile the copy action needs its own line (no header row). */}
          {isMobile && activeDays.length > 1 && (
            <button onClick={copyToAllDays}
              className="mb-3 inline-flex items-center gap-1.5 text-primary hover:underline">
              <Copy size={13} />{t('work_copy_all', { defaultValue: 'Copier pour tous les jours' })}
            </button>
          )}

          {/* One row per active day */}
          <div className="space-y-2">
            {activeDays.map(c => {
              const day = workSchedule[c.weekday]
              return (
                <div key={c.weekday} className="flex flex-wrap items-start gap-3">
                  <span className="w-20 shrink-0 pt-2 text-text-primary capitalize">{c.full}</span>

                  {/* Time ranges — only when the hours toggle is on. */}
                  {workingHoursEnabled && (
                    <div className="flex flex-col gap-2">
                      {day.ranges.map((r, idx) => (
                        <div key={idx} className="flex items-center gap-2">
                          <input type="time" value={minToStr(r.start)}
                            onChange={e => setRange(c.weekday, idx, { start: strToMin(e.target.value) })}
                            className="rounded-lg border border-border bg-surface-0 px-2 py-1.5 text-text-primary
                                       outline-none focus:border-primary transition-colors" />
                          <span className="text-text-tertiary">–</span>
                          <input type="time" value={minToStr(r.end)}
                            onChange={e => setRange(c.weekday, idx, { end: strToMin(e.target.value) })}
                            className="rounded-lg border border-border bg-surface-0 px-2 py-1.5 text-text-primary
                                       outline-none focus:border-primary transition-colors" />
                          <button onClick={() => addRange(c.weekday)}
                            title={t('work_add_range', { defaultValue: 'Ajouter une plage' })}
                            className="p-1 rounded-full text-text-tertiary hover:text-primary hover:bg-primary/10 transition-colors">
                            <Plus size={15} />
                          </button>
                          {day.ranges.length > 1 && (
                            <button onClick={() => removeRange(c.weekday, idx)}
                              title={t('work_remove_range', { defaultValue: 'Retirer la plage' })}
                              className="p-1 rounded-full text-text-tertiary hover:text-danger hover:bg-danger/10 transition-colors">
                              <X size={15} />
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Work location — only when the admin allows it. Choosing
                      "Other office" / "Elsewhere" reveals a free-text field. */}
                  {workingLocationAllowed && (
                    <div className="flex flex-col gap-2">
                      <Dropdown
                        value={day.location}
                        onChange={(v) => patchDay(c.weekday, { location: v as WorkLocation })}
                        options={locationOptions}
                        width={188}
                        height={38}
                      />
                      {(day.location === 'other_office' || day.location === 'elsewhere') && (
                        <input
                          type="text"
                          value={day.custom ?? ''}
                          onChange={e => patchDay(c.weekday, { custom: e.target.value })}
                          placeholder={t('work_custom_placeholder', { defaultValue: 'Préciser le lieu…' })}
                          className="rounded-lg border border-border bg-surface-0 px-2.5 py-1.5 text-text-primary
                                     outline-none focus:border-primary transition-colors"
                          style={{ width: 188 }}
                        />
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>

          <p className="mt-4 text-xs text-text-tertiary leading-relaxed max-w-xl">
            {t('work_visibility_note', {
              defaultValue: 'Vos heures et lieu de travail ne sont visibles que par les utilisateurs qui peuvent voir votre disponibilité.',
            })}
          </p>
        </div>
      )}
    </div>
  )
}

// The factory schedule is exported for callers that seed a fresh account.
export { defaultWorkSchedule }
