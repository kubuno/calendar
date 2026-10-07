// Working-hours location band (Google-style): a coloured pill at the run start
// followed by a thin line joining same-location days. Shared by Day/Week/Month.
import { useTranslation } from 'react-i18next'
import { toDate } from '@kubuno/sdk'
import { Home, Building, Building2, MapPin } from 'lucide-react'
import { workDayFor, type CalendarSettings, type WorkLocation } from './calendarSettings'

export const WORK_LOCATION_META: Record<WorkLocation, { icon: React.ReactNode; key: string; fallback: string }> = {
  office:       { icon: <Building2 size={12} />, key: 'work_loc_office',       fallback: 'Bureau' },
  home:         { icon: <Home size={12} />,      key: 'work_loc_home',         fallback: 'Domicile' },
  unspecified:  { icon: null,                    key: 'work_loc_unspecified',  fallback: 'Non spécifié' },
  other_office: { icon: <Building size={12} />,  key: 'work_loc_other_office', fallback: 'Autre bureau' },
  elsewhere:    { icon: <MapPin size={12} />,    key: 'work_loc_elsewhere',    fallback: 'Ailleurs' },
}

/** The work location to display for a day, or null when the admin has disabled
 *  work locations, it is not a working day, or the location is unspecified.
 *  Independent of the hours toggle: the location is a separate concept. */
export function workLocationOf(date: Date, settings: CalendarSettings): WorkLocation | null {
  if (!settings.workingLocationAllowed) return null
  const day = workDayFor(settings.workSchedule, toDate(date).getDay())
  return day && day.location !== 'unspecified' ? day.location : null
}

/** The user-entered place for a day, when its location is Other office / Elsewhere. */
export function customLocationOf(date: Date, settings: CalendarSettings): string | undefined {
  const day = workDayFor(settings.workSchedule, toDate(date).getDay())
  if (!day || (day.location !== 'other_office' && day.location !== 'elsewhere')) return undefined
  return day.custom && day.custom.trim() ? day.custom : undefined
}

// Google's working-location blue: a light-blue pill for the label, and a thinner
// bar of the same colour extending to the right.
export const WORK_LOC_FILL = '#d2e3fc'
export const WORK_LOC_TEXT = '#1a56c4'

/** Style for the thin work-location bar; rounds only the run's outer ends so a
 *  multi-day run reads as one continuous line. */
export function workBarStyle(runStart: boolean, runEnd: boolean): React.CSSProperties {
  return {
    height: 4,
    backgroundColor: WORK_LOC_FILL,
    borderTopLeftRadius:     runStart ? 9999 : 0,
    borderBottomLeftRadius:  runStart ? 9999 : 0,
    borderTopRightRadius:    runEnd ? 9999 : 0,
    borderBottomRightRadius: runEnd ? 9999 : 0,
  }
}

/** Icon + name of a work location as a light-blue pill (Google style). `text`
 *  overrides the name with a user-entered custom location. */
export function WorkLocationLabel({ location, text, className = '' }: {
  location: WorkLocation; text?: string; className?: string
}) {
  const { t } = useTranslation('calendar')
  const meta = WORK_LOCATION_META[location]
  return (
    <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 whitespace-nowrap text-[11px] leading-none ${className}`}
      style={{ backgroundColor: WORK_LOC_FILL, color: WORK_LOC_TEXT }}>
      {meta.icon}
      {text && text.trim() ? text : t(meta.key, { defaultValue: meta.fallback })}
    </span>
  )
}

/** Work-location band under the headers of the timed views (Day/Week/N-day),
 *  mirroring Google Calendar: the coloured label at the run start, followed by a
 *  thin blue line that fills the rest of the run and joins across the days that
 *  share a location. Renders nothing when no day in view has a location. */
export function WorkLocationBand({ days, gridCols, leadingGutters, settings }: {
  days: Date[]; gridCols: string; leadingGutters: number; settings: CalendarSettings
}) {
  const locs = days.map(d => workLocationOf(d, settings))
  if (locs.every(l => l === null)) return null
  return (
    <div className="grid shrink-0 bg-surface-0 border-b border-border" style={{ gridTemplateColumns: gridCols }}>
      {Array.from({ length: leadingGutters }, (_, i) => <div key={`g${i}`} />)}
      {days.map((d, i) => {
        const loc      = locs[i]
        const runStart = loc !== null && (i === 0 || locs[i - 1] !== loc)
        const runEnd   = loc !== null && (i === locs.length - 1 || locs[i + 1] !== loc)
        const custom   = loc !== null ? customLocationOf(d, settings) : undefined
        return (
          <div key={d.toISOString()} className="relative flex items-center" style={{ minHeight: 26 }}>
            {/* One continuous bar per cell (left-0 right-0) so neighbours touch
                seamlessly; only the run's outer ends are rounded. */}
            {loc !== null && <span className="absolute left-0 right-0 top-1/2 -translate-y-1/2"
              style={{ ...workBarStyle(runStart, runEnd), right: runEnd ? 10 : undefined }} />}
            {/* The pill starts at the cell's left edge so it fully covers the bar
                on its left: the line only ever shows to the RIGHT of the pill. */}
            {runStart && <WorkLocationLabel location={loc!} text={custom} className="relative z-10" />}
          </div>
        )
      })}
    </div>
  )
}
