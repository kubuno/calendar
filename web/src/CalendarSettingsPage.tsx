// Per-user settings page for Calendar (route `/calendar/user-settings[/:section]`).
//
// The page is only the CONTENT pane: its navigation is rendered by the shell in
// its left panel (see `SettingsNav`, registered in entry.ts for this route
// prefix), which replaces the calendar's usual sidebar while the settings are
// open instead of stacking a second column beside it.
//
// The scalar preferences themselves are rendered from the module's declarative
// manifest — see GeneralSettings / ModuleSettingsForm.
import { useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import { Spinner } from '@ui'
import { calendarApi } from './api'
import CalendarCalDavSettings from './CalendarCalDavSettings'
import GeneralSettings from './settings/GeneralSettings'
import ImportExportSettings from './settings/ImportExportSettings'
import CalendarDetailSettings from './settings/CalendarDetailSettings'
import { WeatherSection, AboutSection } from './settings/MiscSettings'
import { Section } from './settings/parts'

export default function CalendarSettingsPage() {
  const { t } = useTranslation('calendar')
  const { section } = useParams()
  const navigate = useNavigate()

  /** `general` | `import-export` | `caldav` | `weather` | `about` | `cal-<id>` */
  const page = section ?? 'general'

  const { data, isLoading } = useQuery({
    queryKey: ['calendar-calendars'],
    queryFn:  calendarApi.listCalendars,
  })
  const calendars = useMemo(() => data?.calendars ?? [], [data])

  const activeCalendar = page.startsWith('cal-')
    ? calendars.find(c => c.id === page.slice(4))
    : undefined

  // A calendar deleted from its own settings page leaves the pane orphaned.
  useEffect(() => {
    if (page.startsWith('cal-') && !isLoading && !activeCalendar) navigate('/calendar/user-settings')
  }, [page, activeCalendar, isLoading, navigate])

  const pane = (() => {
    if (isLoading) return <div className="flex justify-center py-16"><Spinner size="md" /></div>
    if (activeCalendar) return <CalendarDetailSettings key={activeCalendar.id} calendar={activeCalendar} />
    switch (page) {
      case 'import-export': return <ImportExportSettings />
      case 'caldav':        return <Section id="caldav" title="CalDAV"><CalendarCalDavSettings /></Section>
      case 'weather':       return <WeatherSection />
      case 'about':         return <AboutSection />
      default:              return <GeneralSettings />
    }
  })()

  return (
    <div className="flex flex-col h-full bg-surface-0 overflow-hidden">
      {/* Breadcrumb header */}
      <div className="flex items-center gap-2 px-6 py-2.5 border-b border-border shrink-0 bg-surface-1">
        <Link to="/calendar" className="flex items-center gap-1.5 text-primary hover:underline">
          <ArrowLeft size={14} />
          {t('calendar_settings_breadcrumb', { defaultValue: 'Agenda' })}
        </Link>
        <span className="text-text-tertiary">/</span>
        <span className="text-text-primary">{t('settings_title', { defaultValue: 'Paramètres' })}</span>
      </div>

      <div id="calendar-settings-pane" className="flex-1 min-h-0 overflow-y-auto">
        <div className="max-w-3xl px-8 py-6">{pane}</div>
      </div>
    </div>
  )
}
