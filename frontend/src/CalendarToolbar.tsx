import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronLeft, ChevronRight, ChevronDown } from 'lucide-react'
import { useIsFetching, useQueryClient } from '@tanstack/react-query'
import { formatDate, addDays, addMonths, subMonths, startOfWeek, addYears, subYears, api, useAuthStore, ExtensionRegistry } from '@kubuno/sdk'
import { useCalendarStore, type ViewMode } from './store'
import { useCalendarSettings } from './calendarSettings'
import { CALENDAR_VIEW_OPTION, type CalendarViewOption } from './viewOptions'
import { Button, Spinner, MenuDropdown, useMenuDropdown, useIsMobile, type MenuItem } from '@ui'

const VIEW_LABEL_KEYS: Record<ViewMode, string> = {
  day:      'view_day',
  week:     'view_week',
  month:    'view_month',
  year:     'view_year',
  schedule: 'view_schedule',
  custom:   'view_custom',
}

// The views listed in the switcher, with their Google-style keyboard shortcut.
const SWITCHER_VIEWS: { view: ViewMode; shortcut: string }[] = [
  { view: 'day',      shortcut: 'D' },
  { view: 'week',     shortcut: 'W' },
  { view: 'month',    shortcut: 'M' },
  { view: 'year',     shortcut: 'Y' },
  { view: 'schedule', shortcut: 'A' },
  { view: 'custom',   shortcut: 'X' },
]

/**
 * Date navigation: Today + prev/next + current-period title. Shared between the
 * shell header (desktop) and the module toolbar (mobile).
 */
export function CalendarNav({ mobile = false }: { mobile?: boolean }) {
  const { t, i18n } = useTranslation('calendar')
  const { viewMode, currentDate, setCurrentDate } = useCalendarStore()
  const { weekStartsOn, customViewDays } = useCalendarSettings()
  const isFetching = useIsFetching({ queryKey: ['calendar-events'] }) > 0

  const prev = () => {
    if (viewMode === 'day')          setCurrentDate(addDays(currentDate, -1))
    else if (viewMode === 'custom')  setCurrentDate(addDays(currentDate, -customViewDays))
    else if (viewMode === 'week')    setCurrentDate(addDays(currentDate, -7))
    else if (viewMode === 'year')    setCurrentDate(subYears(currentDate, 1))
    else                             setCurrentDate(subMonths(currentDate, 1))  // month + schedule
  }
  const next = () => {
    if (viewMode === 'day')          setCurrentDate(addDays(currentDate, 1))
    else if (viewMode === 'custom')  setCurrentDate(addDays(currentDate, customViewDays))
    else if (viewMode === 'week')    setCurrentDate(addDays(currentDate, 7))
    else if (viewMode === 'year')    setCurrentDate(addYears(currentDate, 1))
    else                             setCurrentDate(addMonths(currentDate, 1))  // month + schedule
  }

  const title = useMemo(() => {
    if (viewMode === 'day')
      return formatDate(currentDate, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
    if (viewMode === 'custom')
      return t('toolbar_range', {
        defaultValue: '{{from}} – {{to}}',
        from: formatDate(currentDate, { day: 'numeric', month: 'short' }),
        to:   formatDate(addDays(currentDate, customViewDays - 1), { day: 'numeric', month: 'short', year: 'numeric' }),
      })
    if (viewMode === 'week')
      return t('toolbar_week_of', { date: formatDate(startOfWeek(currentDate, weekStartsOn), 'dateLong') })
    if (viewMode === 'year')
      return formatDate(currentDate, { year: 'numeric' })
    return formatDate(currentDate, 'monthYear')  // month + schedule
  }, [viewMode, currentDate, t, i18n.language, weekStartsOn, customViewDays])

  return (
    <div className={`flex items-center gap-1 min-w-0 ${mobile ? 'w-full' : 'w-auto'}`}>
      <Button variant="secondary" size="sm" onClick={() => setCurrentDate(new Date())}>
        {t('toolbar_today')}
      </Button>
      <button onClick={prev}
        className="w-8 h-8 flex items-center justify-center rounded-full flex-shrink-0
                   hover:bg-surface-2 text-text-secondary transition-colors">
        <ChevronLeft size={18} />
      </button>
      <button onClick={next}
        className="w-8 h-8 flex items-center justify-center rounded-full flex-shrink-0
                   hover:bg-surface-2 text-text-secondary transition-colors">
        <ChevronRight size={18} />
      </button>
      <h1 className={`${mobile ? 'text-lg' : 'text-[22px]'} font-normal text-text-primary ml-2 capitalize tracking-tight truncate min-w-0`}>
        {title}
      </h1>
      {isFetching && <Spinner size="xs" className="ml-1 flex-shrink-0" />}
    </div>
  )
}

/** Label of a view for the trigger button and the menu ("4 jours" for custom). */
function viewLabel(view: ViewMode, customViewDays: number, t: ReturnType<typeof useTranslation>['t']): string {
  return view === 'custom'
    ? t('view_custom_days', { defaultValue: '{{count}} jours', count: customViewDays })
    : t(VIEW_LABEL_KEYS[view])
}

/**
 * View switcher as a Google-style dropdown: a "[current view] ▾" button opening
 * a menu that lists every view (with its keyboard shortcut) plus the three
 * quick display toggles (week-ends, declined events, completed tasks).
 */
export function CalendarViewSwitcher() {
  const { t } = useTranslation('calendar')
  const { viewMode, setViewMode } = useCalendarStore()
  const settings = useCalendarSettings()
  const { pos, open, close } = useMenuDropdown()
  const qc = useQueryClient()

  // Persist a display toggle the same way the settings form does: merge the
  // module's preference bag and refresh the shared config query so the views
  // (which read useCalendarSettings) update at once.
  const toggle = async (key: string, value: boolean) => {
    const current = (useAuthStore.getState().user?.preferences?.calendar ?? {}) as Record<string, unknown>
    const { data } = await api.patch<{ user: { preferences: Record<string, unknown> } }>(
      '/me', { preferences: { calendar: { ...current, [key]: value } } })
    if (data?.user) useAuthStore.getState().updateUser({ preferences: data.user.preferences })
    qc.invalidateQueries({ queryKey: ['module-config', 'calendar'] })
  }

  // Display toggles contributed by overlay modules (e.g. tasks → "show completed
  // tasks"): the calendar renders them and refreshes the overlays when one flips,
  // but each module owns its own state + filtering.
  const extraOptions = ExtensionRegistry.getAll<CalendarViewOption>(CALENDAR_VIEW_OPTION)

  const items: MenuItem[] = [
    ...SWITCHER_VIEWS.map(({ view, shortcut }): MenuItem => ({
      type: 'action',
      label: viewLabel(view, settings.customViewDays, t),
      shortcut,
      onClick: () => setViewMode(view),
    })),
    { type: 'separator' },
    { type: 'action', label: t('setting_show_weekends', { defaultValue: 'Afficher les week-ends' }),
      checked: settings.showWeekends, onClick: () => toggle('show_weekends', !settings.showWeekends) },
    { type: 'action', label: t('setting_show_declined_events', { defaultValue: 'Afficher les événements refusés' }),
      checked: settings.showDeclinedEvents, onClick: () => toggle('show_declined_events', !settings.showDeclinedEvents) },
    ...extraOptions.map((opt): MenuItem => ({
      type: 'action',
      label: opt.label(),
      checked: opt.isChecked(),
      onClick: async () => {
        await opt.setChecked(!opt.isChecked())
        qc.invalidateQueries({ queryKey: ['calendar-overlay'] })
      },
    })),
  ]

  return (
    <>
      {/* Same trigger style as the chat status pill to its right: a borderless
          rounded-full button with a soft hover, not a bordered box. */}
      <button onClick={open} aria-haspopup="menu"
        className="flex items-center gap-1.5 h-8 px-2.5 rounded-md transition-colors hover:bg-black/5">
        <span className="text-sm text-text-primary">{viewLabel(viewMode, settings.customViewDays, t)}</span>
        <ChevronDown className="w-3.5 h-3.5 text-text-tertiary" />
      </button>
      {pos && <MenuDropdown pos={pos} onClose={close} items={items} minWidth={200} />}
    </>
  )
}

/**
 * Module toolbar. On DESKTOP it renders nothing: the navigation and the view
 * switcher live in the shell header (see CalendarHeaderNav / CalendarHeaderViews).
 * On MOBILE it keeps a single-line date navigation (view switching is done from
 * the shell's bottom tabs).
 */
export default function CalendarToolbar() {
  const isMobile = useIsMobile()
  if (!isMobile) return null
  return (
    <div className="flex items-center min-h-14 px-4 py-2 no-print">
      <CalendarNav mobile />
    </div>
  )
}
