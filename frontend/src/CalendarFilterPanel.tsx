import { useTranslation } from 'react-i18next'
import { useCalendarStore, type CalendarSearchFilters } from './store'
import { DatePicker, Dropdown, Input } from '@ui'

const SCOPE_OPTIONS = [
  { value: 'active', labelKey: 'filter_scope_active' },
  { value: 'all',    labelKey: 'filter_scope_all' },
] as const

function ScopeDropdown({
  value, onChange,
}: {
  value: CalendarSearchFilters['scope']
  onChange: (v: CalendarSearchFilters['scope']) => void
}) {
  const { t } = useTranslation('calendar')
  return (
    <Dropdown
      value={value}
      onChange={v => onChange(v as CalendarSearchFilters['scope'])}
      options={SCOPE_OPTIONS.map(o => ({ value: o.value, label: t(o.labelKey) }))}
      height={34}
      width={200}
    />
  )
}

const fieldClass = `
  h-auto py-2 bg-surface-2 border-transparent rounded-lg
  focus:bg-surface-3 focus:ring-0 focus:border-transparent transition-colors
`

const rowClass = 'flex items-center gap-6'
const labelClass = 'text-sm text-text-secondary w-32 shrink-0 text-right'

export default function CalendarFilterPanel({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation('calendar')
  const { searchFilters, setSearchFilters, applySearch, clearSearch } = useCalendarStore()

  const handleSearch = () => {
    applySearch()
    onClose()
  }

  const handleReset = () => {
    clearSearch()
    onClose()
  }

  return (
    <div className="py-5 px-6" style={{ minWidth: 560 }}>
      {/* Rechercher dans */}
      <div className={`${rowClass} mb-4`}>
        <span className={labelClass}>{t('filter_search_in')}</span>
        <ScopeDropdown
          value={searchFilters.scope}
          onChange={v => setSearchFilters({ scope: v })}
        />
      </div>

      {/* Objet */}
      <div className={`${rowClass} mb-3`}>
        <label className={labelClass}>{t('filter_subject')}</label>
        <div className="flex-1">
          <Input
            type="text"
            className={fieldClass}
            placeholder={t('filter_subject_ph')}
            value={searchFilters.subject}
            onChange={e => setSearchFilters({ subject: e.target.value })}
          />
        </div>
      </div>

      {/* Participants */}
      <div className={`${rowClass} mb-3`}>
        <label className={labelClass}>{t('filter_participants')}</label>
        <div className="flex-1">
          <Input
            type="text"
            className={fieldClass}
            placeholder={t('filter_participants_ph')}
            value={searchFilters.participants}
            onChange={e => setSearchFilters({ participants: e.target.value })}
          />
        </div>
      </div>

      {/* Lieu */}
      <div className={`${rowClass} mb-3`}>
        <label className={labelClass}>{t('filter_location')}</label>
        <div className="flex-1">
          <Input
            type="text"
            className={fieldClass}
            placeholder={t('filter_location_ph')}
            value={searchFilters.location}
            onChange={e => setSearchFilters({ location: e.target.value })}
          />
        </div>
      </div>

      {/* Ne contient pas */}
      <div className={`${rowClass} mb-3`}>
        <label className={labelClass}>{t('filter_exclude')}</label>
        <div className="flex-1">
          <Input
            type="text"
            className={fieldClass}
            placeholder={t('filter_exclude_ph')}
            value={searchFilters.excludeWords}
            onChange={e => setSearchFilters({ excludeWords: e.target.value })}
          />
        </div>
      </div>

      {/* Date range */}
      <div className={`${rowClass} mb-5`}>
        <label className={labelClass}>{t('filter_date')}</label>
        <div className="flex items-center gap-2 flex-1">
          <DatePicker
            mode="date"
            value={searchFilters.dateFrom || null}
            onChange={v => setSearchFilters({ dateFrom: v ?? '' })}
            placeholder={t('filter_date_from')}
            clearable
            className="flex-1"
          />
          <span className="text-text-tertiary text-sm">–</span>
          <DatePicker
            mode="date"
            value={searchFilters.dateTo || null}
            onChange={v => setSearchFilters({ dateTo: v ?? '' })}
            placeholder={t('filter_date_to')}
            clearable
            className="flex-1"
          />
        </div>
      </div>

      {/* Actions */}
      <div className="flex justify-end gap-4">
        <button
          type="button"
          onClick={handleReset}
          className="text-sm font-medium text-primary hover:text-primary-hover transition-colors"
        >
          {t('filter_reset')}
        </button>
        <button
          type="button"
          onClick={handleSearch}
          className="text-sm font-bold text-primary hover:text-primary-hover transition-colors"
        >
          {t('filter_search')}
        </button>
      </div>
    </div>
  )
}
