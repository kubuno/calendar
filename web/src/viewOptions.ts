// Extension point for the calendar's view menu.
//
// A module that overlays the calendar (e.g. tasks, via CALENDAR_OVERLAY) can also
// contribute a display TOGGLE to the "views" dropdown — and owns its behaviour.
// The calendar knows nothing about tasks: it just renders whatever toggles were
// registered and re-fetches the overlays when one flips.
//
// Same convention as CALENDAR_OVERLAY: a string key on the shared ExtensionRegistry
// (contributors register the literal 'calendar.view-option', no cross-module import).
export const CALENDAR_VIEW_OPTION = 'calendar.view-option'

export interface CalendarViewOption {
  /** Stable id (used as React key). */
  id: string
  /** Menu label — a function so it follows the active language. */
  label: () => string
  /** Current state (read fresh each time the menu opens). */
  isChecked: () => boolean
  /** Persist the new state. May be async; the calendar refreshes overlays after. */
  setChecked: (checked: boolean) => void | Promise<void>
}
