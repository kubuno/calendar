// "Paramètres généraux" — every per-user preference of the Calendar module.
//
// The scalar rows come from the declarative manifest through
// <ModuleSettingsForm categories={…} />; the shaped preferences (world clock,
// work schedule) are bespoke controls stored in the same preference bag.
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import ModuleSettingsForm from '../ModuleSettingsForm'
import { tzLabel } from '../timezones'
import WorldClockField from './WorldClockField'
import WorkingHoursField from './WorkingHoursField'
import { Section, Field } from './parts'

/** Anchors of this page, in render order — the left nav mirrors them. */
export const GENERAL_SECTIONS = [
  'region', 'timezone', 'world-clock', 'events',
  'notifications', 'display', 'working-hours', 'shortcuts',
] as const

export default function GeneralSettings() {
  const { t } = useTranslation('calendar')

  const browserTz = useMemo(() => {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone } catch { return 'UTC' }
  }, [])

  return (
    <div>
      <Section id="region" title={t('settings_section_region', { defaultValue: 'Langue et région' })}>
        <ModuleSettingsForm moduleId="calendar" mode="user" categories={['region']} />
      </Section>

      <Section id="timezone" title={t('settings_section_timezone', { defaultValue: 'Fuseau horaire' })}>
        <Field label={t('settings_primary_timezone', { defaultValue: 'Fuseau horaire principal' })}
          help={t('settings_primary_timezone_help', { defaultValue: 'Détecté depuis votre appareil ; les horaires de l’agenda s’y rapportent.' })}>
          <div className="px-3 py-2 rounded-lg border border-border bg-surface-1 text-text-secondary truncate">
            {tzLabel(browserTz)}
          </div>
        </Field>
        <div className="mt-4">
          <ModuleSettingsForm moduleId="calendar" mode="user" categories={['timezone']} />
        </div>
      </Section>

      <Section id="world-clock" title={t('settings_section_world_clock', { defaultValue: 'Horloge mondiale' })}
        description={t('settings_world_clock_help', { defaultValue: 'Les fuseaux choisis sont affichés dans le panneau latéral de l’agenda.' })}>
        <WorldClockField />
      </Section>

      <Section id="events" title={t('settings_section_events', { defaultValue: 'Paramètres des événements' })}>
        <ModuleSettingsForm moduleId="calendar" mode="user" categories={['events']} />
      </Section>

      <Section id="notifications" title={t('settings_section_notifications', { defaultValue: 'Paramètres de notification' })}>
        <ModuleSettingsForm moduleId="calendar" mode="user" categories={['notifications']} />
      </Section>

      <Section id="display" title={t('settings_section_display', { defaultValue: 'Options d’affichage' })}>
        <ModuleSettingsForm moduleId="calendar" mode="user" categories={['display']} />
      </Section>

      <Section id="working-hours" title={t('settings_section_working_hours', { defaultValue: 'Heures et lieu de travail' })}>
        <WorkingHoursField />
      </Section>

      <Section id="shortcuts" title={t('settings_section_shortcuts', { defaultValue: 'Raccourcis clavier' })}>
        <ModuleSettingsForm moduleId="calendar" mode="user" categories={['shortcuts']} />
      </Section>
    </div>
  )
}
