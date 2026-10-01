// World clock — the list of extra time zones shown in the calendar sidebar.
//
// A list has no representation in the declarative settings manifest (scalars
// only), so it is stored next to the declared keys in the module's preference
// bag (`core.users.preferences.calendar.world_clock`).
import { useTranslation } from 'react-i18next'
import { Trash2, Plus } from 'lucide-react'
import { Dropdown } from '@ui'
import { useModulePrefs } from '../userPrefs'
import { TIMEZONES, tzLabel } from '../timezones'
import { Field } from './parts'

export default function WorldClockField() {
  const { t } = useTranslation('calendar')
  const { prefs, update } = useModulePrefs<{ world_clock: string[] }>('calendar', { world_clock: [] })
  const zones = Array.isArray(prefs.world_clock) ? prefs.world_clock : []

  const available = TIMEZONES.filter(tz => !zones.includes(tz))

  return (
    <div className="space-y-2">
      {zones.length > 0 && (
        <div className="space-y-1 max-w-sm">
          {zones.map(tz => (
            <div key={tz}
              className="flex items-center gap-2 px-3 py-2 rounded-lg border border-border group">
              <span className="flex-1 truncate text-text-primary">{tzLabel(tz)}</span>
              <button
                onClick={() => update({ world_clock: zones.filter(z => z !== tz) })}
                title={t('delete', { defaultValue: 'Supprimer' })}
                className="p-1 rounded text-text-tertiary hover:text-danger hover:bg-danger/10
                           transition-colors opacity-0 group-hover:opacity-100 focus:opacity-100"
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
      )}

      <Field>
        <Dropdown
          value=""
          onChange={(tz) => { if (tz) update({ world_clock: [...zones, tz] }) }}
          options={available.map(tz => ({ value: tz, label: tzLabel(tz) }))}
          placeholder={t('settings_world_clock_add', { defaultValue: 'Ajouter le fuseau horaire' })}
          width="100%"
          height={36}
        />
      </Field>

      {zones.length === 0 && (
        <p className="text-xs text-text-tertiary flex items-center gap-1">
          <Plus size={11} />
          {t('settings_world_clock_empty', { defaultValue: 'Aucun fuseau horaire dans l’horloge mondiale.' })}
        </p>
      )}
    </div>
  )
}
