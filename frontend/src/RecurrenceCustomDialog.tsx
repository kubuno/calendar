import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { format, getDate, getDay } from 'date-fns'
import { Repeat } from 'lucide-react'
import { FloatingWindow, Button, Dropdown, Radio, NumberInput } from '@ui'
import { getDateLocale } from '@kubuno/sdk'
import {
  WEEKDAY_BY, WEEKDAYS_ORDERED, buildCustomRrule, parseCustomRecurrence,
  describeRrule, type CustomRecurrence,
} from './rrule'

const DAY_LABELS: Record<string, string> = {
  MO: 'L', TU: 'M', WE: 'M', TH: 'J', FR: 'V', SA: 'S', SU: 'D',
}

/**
 * Full custom-recurrence editor: every N day/week/month/year,
 * weekday multi-select, monthly by date or by nth weekday, and an end
 * condition (never / after N occurrences / on a date). Produces an RRULE.
 */
export default function RecurrenceCustomDialog({ initialRrule, start, onSave, onClose }: {
  initialRrule: string | null
  /** Event start — used as the reference (weekday, day of month…). */
  start: Date
  onSave: (rrule: string) => void
  onClose: () => void
}) {
  const { t, i18n } = useTranslation('calendar')
  const loc = getDateLocale(i18n.language)
  const [c, setC] = useState<CustomRecurrence>(() => parseCustomRecurrence(initialRrule, start))
  const patch = (p: Partial<CustomRecurrence>) => setC(prev => ({ ...prev, ...p }))

  const rrule = buildCustomRrule(c, start)
  const summary = describeRrule(rrule, i18n.language, start)

  const freqOptions = [
    { value: 'DAILY',   label: t('rec_unit_day',   { defaultValue: 'jour',    count: c.interval }) },
    { value: 'WEEKLY',  label: t('rec_unit_week',  { defaultValue: 'semaine', count: c.interval }) },
    { value: 'MONTHLY', label: t('rec_unit_month', { defaultValue: 'mois',    count: c.interval }) },
    { value: 'YEARLY',  label: t('rec_unit_year',  { defaultValue: 'an',      count: c.interval }) },
  ]

  const nth = Math.ceil(getDate(start) / 7)
  const nthLabel = nth >= 5
    ? t('rec_last', { defaultValue: 'dernier' })
    : nth === 1 ? '1ᵉʳ' : `${nth}ᵉ`
  const dayName = format(start, 'EEEE', { locale: loc })

  const toggleDay = (d: string) => {
    setC(prev => {
      const has = prev.byday.includes(d)
      // Always keep at least one weekday checked.
      if (has && prev.byday.length === 1) return prev
      return { ...prev, byday: has ? prev.byday.filter(x => x !== d) : [...prev.byday, d] }
    })
  }

  return (
    <FloatingWindow
      title={t('recur_custom', { defaultValue: 'Récurrence personnalisée' })}
      icon={<Repeat size={15} className="text-primary" />}
      onClose={onClose}
      defaultWidth={400}
      backdrop
    >
      <div className="flex flex-col p-5 gap-4">
        {/* Frequency: "Repeat every N <unit>" */}
        <div className="flex items-center gap-2">
          <span className="text-sm text-text-secondary shrink-0">
            {t('rec_every', { defaultValue: 'Répéter tous les' })}
          </span>
          <NumberInput
            value={c.interval}
            onChange={(v: number) => patch({ interval: Math.max(1, Math.min(99, Math.round(v || 1))) })}
            min={1} max={99}
            className="w-16"
          />
          <Dropdown
            value={c.freq}
            onChange={(v: string) => patch({ freq: v as CustomRecurrence['freq'] })}
            options={freqOptions}
            className="flex-1"
          />
        </div>

        {/* Hebdomadaire : jours de la semaine */}
        {c.freq === 'WEEKLY' && (
          <div>
            <p className="text-xs font-semibold text-text-secondary mb-1.5">
              {t('rec_repeat_on', { defaultValue: 'Répéter le' })}
            </p>
            <div className="flex items-center gap-1">
              {WEEKDAYS_ORDERED.map(d => {
                const active = c.byday.includes(d)
                return (
                  <button
                    key={d}
                    onClick={() => toggleDay(d)}
                    className={`w-8 h-8 rounded-full text-xs font-semibold transition-colors ${
                      active
                        ? 'bg-primary text-white'
                        : 'bg-surface-2 text-text-secondary hover:bg-surface-3'}`}
                  >
                    {DAY_LABELS[d]}
                  </button>
                )
              })}
            </div>
          </div>
        )}

        {/* Monthly: by day of month or by nth weekday */}
        {c.freq === 'MONTHLY' && (
          <div className="space-y-1.5">
            <Radio
              checked={c.monthlyMode === 'bymonthday'}
              onChange={() => patch({ monthlyMode: 'bymonthday' })}
              label={t('rec_monthly_bymonthday', { defaultValue: 'Le {{day}} du mois', day: getDate(start) })}
            />
            <Radio
              checked={c.monthlyMode === 'byday'}
              onChange={() => patch({ monthlyMode: 'byday' })}
              label={t('rec_monthly_byday', { defaultValue: 'Le {{nth}} {{day}} du mois', nth: nthLabel, day: dayName })}
            />
          </div>
        )}

        {/* Fin */}
        <div>
          <p className="text-xs font-semibold text-text-secondary mb-1.5">
            {t('rec_ends', { defaultValue: 'Se termine' })}
          </p>
          <div className="space-y-2">
            <Radio
              checked={c.end === 'never'}
              onChange={() => patch({ end: 'never' })}
              label={t('rec_ends_never', { defaultValue: 'Jamais' })}
            />
            <div className="flex items-center gap-2">
              <Radio
                checked={c.end === 'until'}
                onChange={() => patch({ end: 'until' })}
                label={t('rec_ends_until', { defaultValue: 'Le' })}
              />
              <input
                type="date"
                value={c.until}
                onChange={e => patch({ end: 'until', until: e.target.value })}
                className="px-2 py-1 text-sm rounded-lg border border-border bg-surface-0
                           text-text-primary outline-none focus:border-primary transition-colors"
              />
            </div>
            <div className="flex items-center gap-2">
              <Radio
                checked={c.end === 'count'}
                onChange={() => patch({ end: 'count' })}
                label={t('rec_ends_after', { defaultValue: 'Après' })}
              />
              <NumberInput
                value={c.count}
                onChange={(v: number) => patch({ end: 'count', count: Math.max(1, Math.min(999, Math.round(v || 1))) })}
                min={1} max={999}
                className="w-16"
              />
              <span className="text-sm text-text-secondary">
                {t('rec_occurrences', { defaultValue: 'occurrence(s)' })}
              </span>
            </div>
          </div>
        </div>

        {/* Humanized summary */}
        {summary && (
          <p className="text-xs text-text-tertiary bg-surface-1 border border-border rounded-lg px-3 py-2">
            {summary}
          </p>
        )}

        <div className="flex items-center justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose}>{t('common_cancel', { defaultValue: 'Annuler' })}</Button>
          <Button onClick={() => { onSave(rrule); onClose() }}>
            {t('rec_apply', { defaultValue: 'Terminé' })}
          </Button>
        </div>
      </div>
    </FloatingWindow>
  )
}
