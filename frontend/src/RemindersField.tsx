/**
 * The reminders of an event — used by both forms that can set them.
 *
 * Extracted so the small card and the full editor cannot drift: a reminder row
 * that looks one way in one of them and another way in the other is exactly the
 * kind of split this module has already paid for once.
 */
import { useTranslation } from 'react-i18next'
import { Plus, X } from 'lucide-react'
import { Dropdown } from '@ui'
import { REMINDER_OPTIONS } from './calendarUtils'
import type { EventReminder } from './api'

export function RemindersSection({
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

  // No icon, no gutter of its own: this section is the CONTENT of a row, and
  // the row is drawn by the shared helper like every other one. Rolling its own
  // put its fields six pixels left of all the others — a line you cannot unsee
  // once it is pointed out.
  return (
    <div className="space-y-2">
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
  )
}
