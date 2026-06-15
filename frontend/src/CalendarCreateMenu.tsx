import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { CalendarPlus, CheckSquare, Clock } from 'lucide-react'
import { useNavigate, useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useCalendarStore } from './store'

const ITEM_CLASS =
  'flex items-center gap-3 w-full px-3 py-2 text-sm text-text-primary ' +
  'hover:bg-surface-1 cursor-pointer outline-none'

export default function CalendarCreateMenu() {
  const navigate        = useNavigate()
  const { pathname }    = useLocation()
  const { t }           = useTranslation('calendar')
  const setPendingCreate = useCalendarStore((s) => s.setPendingCreate)

  if (!pathname.startsWith('/calendar')) return null

  const openCreateModal = () => {
    setPendingCreate(new Date())
    if (!pathname.startsWith('/calendar')) navigate('/calendar')
  }

  return (
    <>
      <DropdownMenu.Item onSelect={openCreateModal} className={ITEM_CLASS}>
        <CalendarPlus size={16} className="text-text-secondary" />
        {t('event')}
      </DropdownMenu.Item>

      <DropdownMenu.Item className={ITEM_CLASS}>
        <CheckSquare size={16} className="text-text-secondary" />
        {t('task')}
      </DropdownMenu.Item>

      <DropdownMenu.Item className={ITEM_CLASS}>
        <Clock size={16} className="text-text-secondary" />
        {t('appointment_schedule')}
      </DropdownMenu.Item>
    </>
  )
}
