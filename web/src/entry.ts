/**
 * Entry point of the calendar MODULE bundle (loaded at runtime by the host).
 *
 * Built separately via `vite.module.config.ts`: every shared specifier
 * (`@kubuno/sdk`, `@ui`, react…) is `external` and resolved at runtime by the
 * host's import map. The host calls `register()` after importing this file;
 * `sdkVersion` lets it cleanly reject an incompatibility.
 */
import { lazy } from 'react'
import { Calendar, Calendar1, Columns3, LayoutGrid, List } from 'lucide-react'
import { RouteRegistry, SlotRegistry, ModuleServiceRegistry, ModuleSettingsRegistry, NotificationRegistry, WidgetRegistry, WaffleAppRegistry, FaviconRegistry, ExtensionRegistry, type CalendarOverlayItem, type CalendarOverlayProvider, useSidebarStore, useToolbarStore, useSearchStore, useRightPanelStore, navigate, SDK_VERSION, toISODate, toDate, formatDate } from '@kubuno/sdk'
import { calendarApi } from './api'
import './index.css'
import { ShareRecipientKinds } from './shareSdk'
import './calendar.css'
import './i18n'
import CalendarLogo from './CalendarLogo'
import { useCalendarStore } from './store'
import { newActionItems } from './newActions'
import CalendarSidebarBody from './CalendarSidebarBody'
import CalendarSettingsNav from './settings/SettingsNav'
import { CalendarHeaderNav, CalendarHeaderViews } from './CalendarHeaderSlots'
import CalendarToolbar from './CalendarToolbar'
import CalendarMiniPanel from './CalendarMiniPanel'
import CalendarFilterPanel from './CalendarFilterPanel'
import CalendarEventsWidget from './CalendarEventsWidget'
import CalendarWeatherWidget from './CalendarWeatherWidget'
import CalendarNotificationWorker from './CalendarNotificationWorker'
import EventDataCard from './EventDataCard'
import EventPickerDialog, { pickEvent } from './EventPickerDialog'
import { registerDataCardRenderer } from './kubunoData'

export const sdkVersion = SDK_VERSION

export function register() {
  FaviconRegistry.register('calendar', '/calendar-logo.png')

  // Datepicker override: with calendar installed, the shared <DatePicker> grows a
  // right-hand column listing the selected/hovered day's events. Neutral core
  // channel via a string-literal key ('datepicker.day-panel') so no new SDK export
  // is needed; reuses the CalendarOverlay item shape. The panel also folds in
  // CALENDAR_OVERLAY items (tasks), so it shows « events OR tasks » for the day.
  ExtensionRegistry.register('datepicker.day-panel', 'calendar', {
    fetch: async (fromISO, toISO) => {
      try {
        const { events } = await calendarApi.listEvents(fromISO, toISO)
        return events.map<CalendarOverlayItem>(e => ({
          id:    `event-${e.id}`,
          date:  toISODate(toDate(e.starts_at)),
          title: e.title || '(sans titre)',
          color: e.color ?? '#1a73e8',
        }))
      } catch {
        return []
      }
    },
  } satisfies CalendarOverlayProvider)

  WaffleAppRegistry.register('calendar', 'Calendar', [
    { id: 'calendar', label: 'Calendar', Icon: CalendarLogo, path: '/calendar' },
  ])

  // The header gear button opens the per-user Calendar settings while in /calendar.
  // Instance-wide (admin) settings live in the core admin console
  // (Modules ▸ Calendar, split into "Valeurs par défaut" and "Fonctionnalités"),
  // not at a route inside the module.
  ModuleSettingsRegistry.register('calendar', '/calendar/user-settings')

  // Calendar events can receive a share, so the core's share field says so.
  ShareRecipientKinds?.add({
    id: 'calendar-events', moduleId: 'calendar', order: 20,
    label: "des évènements d'agenda",
  })

  // Declare the notification activities shown in the core Settings → Notifications matrix.
  NotificationRegistry.register({
    moduleId: 'calendar',
    title: 'Agenda',
    order: 20,
    activities: [
      { id: 'event_invite', label: 'Invitation à un événement', emailDefault: true, pushDefault: true },
      { id: 'event_reminder', label: "Rappel d'un événement", pushDefault: true },
      { id: 'calendar_shared', label: 'Un agenda est partagé avec vous', emailDefault: true },
      { id: 'event_changed', label: 'Un événement est modifié' },
    ],
  })

  // Notification worker mounted globally at shell level (runs on all routes)
  SlotRegistry.register('app-dialogs', 'calendar', CalendarNotificationWorker)
  // Event picker, likewise global: consumer modules (chat…) open it from anywhere
  // through the `calendar.pickEvent` service below.
  SlotRegistry.register('app-dialogs', 'calendar', EventPickerDialog)

  WidgetRegistry.register({ id: 'calendar-events',  moduleId: 'calendar', Component: CalendarEventsWidget,  size: 'medium', order: 10 })
  WidgetRegistry.register({ id: 'calendar-weather', moduleId: 'calendar', Component: CalendarWeatherWidget, size: 'large',  order: 11 })

  // "New" button menu: MenuItem[] DATA contributed to the shell's extension
  // point (rendered by the project's MenuDropdown; `items` is re-evaluated on
  // each open, so labels and store state stay fresh).
  ExtensionRegistry.register('shell.new-actions', 'calendar', {
    moduleId: 'calendar',
    items: newActionItems,
  })

  useSidebarStore.getState().register({
    moduleId:          'calendar',
    routePrefix:       '/calendar',
    newButtonLabelKey: 'calendar:create',
    SidebarBody:       CalendarSidebarBody,
    collapsedBody: true,
    // Bottom nav (portrait) / left rail (landscape) rendered by the shell on
    // mobile — one tab per calendar view, mirroring the desktop view switcher.
    mobileTabs: [
      { id: 'schedule', labelKey: 'calendar:view_schedule', Icon: List,       path: '/calendar/schedule' },
      { id: 'day',      labelKey: 'calendar:view_day',      Icon: Calendar1,  path: '/calendar/day' },
      { id: 'week',     labelKey: 'calendar:view_week',     Icon: Columns3,   path: '/calendar/week' },
      { id: 'month',    labelKey: 'calendar:view_month',    Icon: LayoutGrid, path: '/calendar/month' },
    ],
  })

  useToolbarStore.getState().register({
    moduleId:         'calendar',
    routePrefix:      '/calendar',
    ToolbarComponent: CalendarToolbar,
    noPadding:        true,
  })

  // Desktop: the date navigation and the view switcher live in the SHELL header
  // (left + right) rather than in a second toolbar band. Both components gate
  // themselves to the calendar's view routes and to desktop widths.
  SlotRegistry.register('header-leading', 'calendar', CalendarHeaderNav)
  SlotRegistry.register('topbar-actions', 'calendar', CalendarHeaderViews)

  // The settings page carries its own breadcrumb: no date navigation / view
  // switcher. Only `/calendar/user-settings` exists as a route — the old
  // `/calendar/settings` toolbar entry pointed at nothing and was removed.
  useToolbarStore.getState().register({
    moduleId:    'calendar-user-settings',
    routePrefix: '/calendar/user-settings',
  })

  // While the settings are open, the shell's left panel carries the settings
  // navigation instead of the calendar's usual sidebar. The store resolves the
  // MOST SPECIFIC route prefix, so this one wins over '/calendar' above.
  // No 'shell.new-actions' provider is registered for THIS moduleId, so the
  // "Créer" button (meaningless on a settings page) is not shown here.
  useSidebarStore.getState().register({
    moduleId:      'calendar-user-settings',
    routePrefix:   '/calendar/user-settings',
    SidebarBody:   CalendarSettingsNav,
    collapsedBody: true,
  })

  useSearchStore.getState().register({
    moduleId:       'calendar',
    routePrefix:    '/calendar',
    placeholder:    'Rechercher dans les événements…',
    placeholderKey: 'calendar:search_ph',
    onSearch:       (q) => useCalendarStore.getState().setSearchQuery(q),
    FilterPanel:    CalendarFilterPanel,
  })

  useRightPanelStore.getState().registerEntry({
    moduleId:       'calendar',
    icon:           CalendarLogo,
    label:          'Calendar',
    panelComponent: CalendarMiniPanel,
    openPath:       '/calendar',
  })

  // Inter-module services: let other modules drive the calendar UI without any
  // hard dependency — the assistant module opens the agenda on a given date,
  // chat asks the user to pick an event to insert into a conversation.
  ModuleServiceRegistry.publish('calendar', {
    // () => Promise<KubunoDataEnvelope | null> — opens the event picker and
    // resolves with the chosen event's `calendar.event` envelope (null = cancelled).
    pickEvent,

    openDate: (arg?: { date?: string } | string) => {
      const dateStr = typeof arg === 'string' ? arg : arg?.date
      const d = dateStr ? new Date(`${dateStr}T00:00:00`) : new Date()
      if (!Number.isNaN(d.getTime())) useCalendarStore.getState().setCurrentDate(d)
      // Navigate into the calendar if we're elsewhere (the SDK helper drives the
      // host router from outside React).
      if (typeof window !== 'undefined' && !window.location.pathname.startsWith('/calendar')) {
        navigate('/calendar/day')
      }
    },

    // Create an event from another module (mail's "Add to calendar" on a rich
    // card, an assistant action…) without that module knowing the user's
    // calendars: we resolve the default calendar here. `startsAt`/`endsAt` are
    // ISO strings; a missing end defaults to +1h (or the whole day for all-day).
    createEvent: async (input: {
      title: string
      startsAt: string
      endsAt?: string
      description?: string
      location?: string
      url?: string
      allDay?: boolean
      status?: string
    }) => {
      const { calendars } = await calendarApi.listCalendars()
      // Only a calendar the user can write to (owner/write) is a valid target —
      // a read-only shared calendar would 403. Prefer a writable DEFAULT, then
      // an owned one, then any writable calendar.
      const writable = calendars.filter(c => c.my_permission === 'owner' || c.my_permission === 'write' || c.my_permission == null)
      const target =
        writable.find(c => c.is_default && c.my_permission === 'owner')
        ?? writable.find(c => c.my_permission === 'owner')
        ?? writable.find(c => c.is_default)
        ?? writable[0]
      if (!target) throw new Error('no writable calendar')
      const start = new Date(input.startsAt)
      const end = input.endsAt
        ? new Date(input.endsAt)
        : new Date(start.getTime() + (input.allDay ? 24 * 3600e3 : 3600e3))
      const { event } = await calendarApi.createEvent({
        calendar_id: target.id,
        title:       input.title,
        description: input.description,
        location:    input.location,
        url:         input.url,
        starts_at:   start.toISOString(),
        ends_at:     end.toISOString(),
        all_day:     input.allDay ?? false,
        status:      input.status,
      })
      return event
    },
  })

  // `calendar.event` JSON envelopes (event "Copier" in the detail panel, event
  // picker): consumer modules (chat, notes…) resolve this card through `core.data-card`.
  registerDataCardRenderer('calendar', {
    types: ['calendar.event'],
    Component: EventDataCard,
  })

  // Routes
  const CalendarApp             = lazy(() => import('./CalendarApp'))
  const CalendarSettingsPage    = lazy(() => import('./CalendarSettingsPage'))
  const AppointmentSchedulePage = lazy(() => import('./AppointmentScheduleEditor'))

  RouteRegistry.register('calendar',               CalendarApp)
  RouteRegistry.register('calendar/scheduling',    CalendarApp)
  // Appointment-schedule editor — a full dedicated page (two panes), not a modal.
  // `new` creates; any other value edits that schedule id. 3 segments → never
  // collides with the `calendar/:view` param route below.
  RouteRegistry.register('calendar/booking/:id',   AppointmentSchedulePage)
  // Per-user settings live in the module (reached via the header gear). Instance-wide
  // (admin) settings are configured from the core admin console, not here.
  RouteRegistry.register('calendar/user-settings', CalendarSettingsPage)
  // Deep link into one section of the settings page (a general section, the
  // import/export pane, or `cal-<id>` for a given calendar).
  RouteRegistry.register('calendar/user-settings/:section', CalendarSettingsPage)
  // View in the URL: /calendar/day, /calendar/week, /calendar/month, /calendar/year.
  // (the static routes above take precedence over this dynamic param in react-router)
  RouteRegistry.register('calendar/:view',      CalendarApp)
}
