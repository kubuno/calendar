/**
 * Entry point of the calendar MODULE bundle (loaded at runtime by the host).
 *
 * Built separately via `vite.module.config.ts`: every shared specifier
 * (`@kubuno/sdk`, `@ui`, react…) is `external` and resolved at runtime by the
 * host's import map. The host calls `register()` after importing this file;
 * `sdkVersion` lets it cleanly reject an incompatibility.
 */
import { lazy } from 'react'
import { Calendar } from 'lucide-react'
import {
  RouteRegistry,
  SlotRegistry,
  ModuleServiceRegistry,
  ModuleSettingsRegistry,
  NotificationRegistry,
  WidgetRegistry,
  WaffleAppRegistry,
  FaviconRegistry,
  useSidebarStore,
  useToolbarStore,
  useSearchStore,
  useRightPanelStore,
  SDK_VERSION,
} from '@kubuno/sdk'
import './index.css'
import './calendar.css'
import './i18n'
import CalendarLogo from './CalendarLogo'
import { useCalendarStore } from './store'
import CalendarCreateMenu from './CalendarCreateMenu'
import CalendarSidebarBody from './CalendarSidebarBody'
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
  FaviconRegistry.register('calendar', '/calendar-logo.svg')

  WaffleAppRegistry.register('calendar', 'Calendar', [
    { id: 'calendar', label: 'Calendar', Icon: CalendarLogo, path: '/calendar' },
  ])

  // The header gear button opens the per-user Calendar settings while in /calendar.
  // Instance-wide (admin) settings live at /calendar/settings, reached from the
  // admin Modules panel and a link on the user page.
  ModuleSettingsRegistry.register('calendar', '/calendar/user-settings')

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

  useSidebarStore.getState().register({
    moduleId:          'calendar',
    routePrefix:       '/calendar',
    newButtonLabelKey: 'calendar:create',
    NewActions:        CalendarCreateMenu,
    SidebarBody:       CalendarSidebarBody,
    collapsedBody: true,
  })

  useToolbarStore.getState().register({
    moduleId:         'calendar',
    routePrefix:      '/calendar',
    ToolbarComponent: CalendarToolbar,
    noPadding:        true,
  })

  useToolbarStore.getState().register({
    moduleId:    'calendar-settings',
    routePrefix: '/calendar/settings',
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
    icon:           Calendar,
    label:          'Calendar',
    panelComponent: CalendarMiniPanel,
    openPath:       '/calendar',
  })

  // Inter-module services: let other modules drive the calendar UI without any
  // hard dependency — the assistant (jarvis) opens the agenda on a given date,
  // chat asks the user to pick an event to insert into a conversation.
  ModuleServiceRegistry.publish('calendar', {
    // () => Promise<KubunoDataEnvelope | null> — opens the event picker and
    // resolves with the chosen event's `calendar.event` envelope (null = cancelled).
    pickEvent,

    openDate: (arg?: { date?: string } | string) => {
      const dateStr = typeof arg === 'string' ? arg : arg?.date
      const d = dateStr ? new Date(`${dateStr}T00:00:00`) : new Date()
      if (!Number.isNaN(d.getTime())) useCalendarStore.getState().setCurrentDate(d)
      // Navigate into the calendar if we're elsewhere (react-router v6 listens
      // to popstate, so pushState + a popstate event triggers the route change).
      if (typeof window !== 'undefined' && !window.location.pathname.startsWith('/calendar')) {
        window.history.pushState({}, '', '/calendar/day')
        window.dispatchEvent(new PopStateEvent('popstate'))
      }
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
  // View in the URL: /calendar/day, /calendar/week, /calendar/month, /calendar/year.
  // (the static routes above take precedence over this dynamic param in react-router)
  RouteRegistry.register('calendar/:view',      CalendarApp)
}
