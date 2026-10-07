// World clock block of the calendar sidebar — one live row per time zone picked
// in the settings ("Horloge mondiale"). Renders nothing when the list is empty.
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Globe } from 'lucide-react'
import { useCalendarSettings } from './calendarSettings'
import { tzTime, tzOffsetLabel } from './timezones'
import { MonoText } from './MonoText'

export default function WorldClock() {
  const { t } = useTranslation('calendar')
  const { worldClock, timeFormat } = useCalendarSettings()
  const [now, setNow] = useState(() => new Date())

  useEffect(() => {
    if (worldClock.length === 0) return
    // Aligned on the minute: the displayed times never lag behind by more than a tick.
    const id = setInterval(() => setNow(new Date()), 30_000)
    return () => clearInterval(id)
  }, [worldClock.length])

  if (worldClock.length === 0) return null

  return (
    <div className="px-2 pt-3">
      <div className="flex items-center gap-1.5 px-2 pb-1">
        <Globe size={11} className="text-text-tertiary" />
        <span className="text-[10px] font-bold text-text-tertiary uppercase tracking-widest">
          {t('settings_section_world_clock', { defaultValue: 'Horloge mondiale' })}
        </span>
      </div>
      <div className="space-y-0.5">
        {worldClock.map(tz => (
          <div key={tz} className="flex items-baseline gap-2 px-2 py-0.5" title={`${tz} · ${tzOffsetLabel(tz, now)}`}>
            <span className="flex-1 truncate text-xs text-text-secondary">
              {tz.split('/').pop()?.replace(/_/g, ' ')}
            </span>
            <span className="text-xs text-text-primary shrink-0">
              <MonoText>{tzTime(tz, now, timeFormat === '12h')}</MonoText>
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
