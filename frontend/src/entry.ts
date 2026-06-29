/**
 * Point d'entrée du bundle MODULE calendar (chargé à l'exécution par le host).
 *
 * Buildé séparément via `vite.module.config.ts` : tous les specifiers partagés
 * (`@kubuno/sdk`, `@ui`, react…) sont `external` et résolus au runtime par
 * l'import map du host. Le host appelle `register()` après avoir importé ce
 * fichier ; `sdkVersion` permet de rejeter proprement une incompatibilité.
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

export const sdkVersion = SDK_VERSION

export function register() {
  FaviconRegistry.register('calendar', '/calendar-logo.svg')

  // Police JetBrains Mono pour les libellés d'heures de la vue Jour (chargée une seule fois).
  if (typeof document !== 'undefined' && !document.getElementById('kubuno-jetbrains-mono')) {
    const link = document.createElement('link')
    link.id = 'kubuno-jetbrains-mono'
    link.rel = 'stylesheet'
    link.href = 'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500&display=swap'
    document.head.appendChild(link)
  }

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

  // Inter-module service: lets the assistant (jarvis) drive the calendar UI —
  // e.g. open the agenda on a given date — without any hard dependency.
  ModuleServiceRegistry.publish('calendar', {
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

  // Routes
  const CalendarApp          = lazy(() => import('./CalendarApp'))
  const CalendarSettingsPage = lazy(() => import('./CalendarSettingsPage'))

  RouteRegistry.register('calendar',               CalendarApp)
  RouteRegistry.register('calendar/scheduling',    CalendarApp)
  // Per-user settings live in the module (reached via the header gear). Instance-wide
  // (admin) settings are configured from the core admin console, not here.
  RouteRegistry.register('calendar/user-settings', CalendarSettingsPage)
  // Vue dans l'URL : /calendar/day, /calendar/week, /calendar/month, /calendar/year.
  // (les routes statiques ci-dessus priment sur ce param dynamique côté react-router)
  RouteRegistry.register('calendar/:view',      CalendarApp)
}
