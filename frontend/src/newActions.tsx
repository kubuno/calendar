/**
 * Items of the shell's "New" button for the calendar module.
 *
 * Contributed as DATA (`MenuItem[]` from @ui) to the `shell.new-actions`
 * extension point — the shell renders them with the project's MenuDropdown.
 * `newActionItems` is evaluated when the menu OPENS, outside any React
 * component: no hooks here (stores via `getState()`, i18n via `i18n.t`).
 */
import { CalendarPlus, CheckSquare, Clock } from 'lucide-react'
import { i18n, navigate } from '@kubuno/sdk'
import type { MenuItem } from '@ui'
import { useCalendarStore } from './store'

export function newActionItems(): MenuItem[] {
  // The "Créer" button only makes sense inside the calendar views (the
  // settings pages register their own sidebar config without new-actions).
  if (!window.location.pathname.startsWith('/calendar')) return []

  return [
    {
      type: 'action',
      label: i18n.t('calendar:event'),
      icon: <CalendarPlus size={16} />,
      // Opens the event-creation modal on today's date (we are already on a
      // /calendar route — items() returns [] elsewhere).
      onClick: () => useCalendarStore.getState().setPendingCreate(new Date()),
    },
    {
      type: 'action',
      label: i18n.t('calendar:task'),
      icon: <CheckSquare size={16} />,
      // Parity with the previous menu: the entry existed but had no handler yet.
      onClick: () => {},
    },
    {
      type: 'action',
      label: i18n.t('calendar:appointment_schedule'),
      icon: <Clock size={16} />,
      // Appointment schedules are created on a full dedicated page, not a modal.
      onClick: () => navigate('/calendar/booking/new'),
    },
  ]
}
