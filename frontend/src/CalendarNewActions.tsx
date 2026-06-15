import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { CalendarPlus } from 'lucide-react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'

export default function CalendarNewActions() {
  const location = useLocation()
  const navigate = useNavigate()
  const { t } = useTranslation('calendar')
  if (!location.pathname.startsWith('/calendar')) return null
  return (
    <DropdownMenu.Item
      onSelect={() => navigate('/calendar')}
      className="flex items-center gap-2.5 px-3 py-2 text-sm text-text-primary rounded-md
                 hover:bg-surface-2 cursor-pointer outline-none transition-colors"
    >
      <CalendarPlus size={16} className="text-primary" />
      {t('new_event')}
    </DropdownMenu.Item>
  )
}
