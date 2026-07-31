// Calendar chrome injected into the SHELL header (desktop only):
//   • the date navigation on the left  → slot `header-leading`
//   • the view switcher on the right    → slot `topbar-actions`
//
// Slots render for any active module regardless of route, so each component
// gates itself: it shows only on the calendar's VIEW routes (not settings /
// scheduling / booking) and only on desktop (mobile keeps the module toolbar +
// bottom tabs).
import { useLocation } from 'react-router-dom'
import { useIsMobile } from '@ui'
import { CalendarNav, CalendarViewSwitcher } from './CalendarToolbar'

const VIEW_SEGMENTS = new Set(['day', 'week', 'month', 'year', 'schedule', 'custom'])

/** True on `/calendar` and `/calendar/<view>`, false on settings/booking/etc. */
function isCalendarViewRoute(pathname: string): boolean {
  const seg = pathname.replace(/\/+$/, '').split('/')   // ['', 'calendar', 'day'?]
  if (seg[1] !== 'calendar') return false
  return seg.length === 2 || (seg.length === 3 && VIEW_SEGMENTS.has(seg[2]))
}

export function CalendarHeaderNav() {
  const { pathname } = useLocation()
  const isMobile = useIsMobile()
  if (isMobile || !isCalendarViewRoute(pathname)) return null
  return <CalendarNav />
}

export function CalendarHeaderViews() {
  const { pathname } = useLocation()
  const isMobile = useIsMobile()
  if (isMobile || !isCalendarViewRoute(pathname)) return null
  return (
    <div className="flex items-center mr-1">
      <CalendarViewSwitcher />
    </div>
  )
}
