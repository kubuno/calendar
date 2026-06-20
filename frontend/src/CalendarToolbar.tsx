import { useMemo, useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useIsFetching } from '@tanstack/react-query'
import {
  format, startOfWeek,
  addDays, addMonths, addYears, subMonths, subYears,
} from 'date-fns'
import { getDateLocale } from '@kubuno/sdk'
import { useCalendarStore, type ViewMode } from './store'
import { Button, Spinner } from '@ui'

const VIEW_LABEL_KEYS: Record<ViewMode, string> = {
  day:   'view_day',
  week:  'view_week',
  month: 'view_month',
  year:  'view_year',
}

export default function CalendarToolbar() {
  const { t, i18n } = useTranslation('calendar')
  const {
    viewMode, setViewMode,
    currentDate, setCurrentDate,
  } = useCalendarStore()

  const isFetching = useIsFetching({ queryKey: ['calendar-events'] }) > 0

  // Piloté en JS (pas via variantes `sm:`) car les utilitaires responsives du
  // module sont écrasés par les utilitaires de base du host (couche utilities >
  // kubuno-module). Sur mobile : titre pleine ligne, sélecteur de vue en dessous.
  const [isMobile, setIsMobile] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia('(max-width: 1023px)').matches)
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 1023px)')
    const on = () => setIsMobile(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])

  const prev = () => {
    if (viewMode === 'day')        setCurrentDate(addDays(currentDate, -1))
    else if (viewMode === 'week')  setCurrentDate(addDays(currentDate, -7))
    else if (viewMode === 'month') setCurrentDate(subMonths(currentDate, 1))
    else                           setCurrentDate(subYears(currentDate, 1))
  }
  const next = () => {
    if (viewMode === 'day')        setCurrentDate(addDays(currentDate, 1))
    else if (viewMode === 'week')  setCurrentDate(addDays(currentDate, 7))
    else if (viewMode === 'month') setCurrentDate(addMonths(currentDate, 1))
    else                           setCurrentDate(addYears(currentDate, 1))
  }

  const title = useMemo(() => {
    if (viewMode === 'day')
      return format(currentDate, 'EEEE d MMMM yyyy', { locale: getDateLocale(i18n.language) })
    if (viewMode === 'week')
      return t('toolbar_week_of', { date: format(startOfWeek(currentDate, { weekStartsOn: 1 }), 'd MMMM yyyy', { locale: getDateLocale(i18n.language) }) })
    if (viewMode === 'year')
      return format(currentDate, 'yyyy')
    return format(currentDate, 'MMMM yyyy', { locale: getDateLocale(i18n.language) })
  }, [viewMode, currentDate, t, i18n.language])

  return (
    // min-h (pas h fixe) : sur mobile le titre + le sélecteur de vue passent à la
    // ligne (flex-wrap) sans se chevaucher. gap-y réserve l'espace vertical.
    <div className={`flex items-center justify-between min-h-14 px-4 gap-x-2 gap-y-2 py-2 no-print ${isMobile ? 'flex-wrap' : 'flex-nowrap'}`}>
      {/* Gauche — navigation. Pleine ligne sur mobile → le titre a la place ;
          le sélecteur de vue passe à la ligne en dessous. */}
      <div className={`flex items-center gap-1 min-w-0 ${isMobile ? 'w-full' : 'w-auto'}`}>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => setCurrentDate(new Date())}
        >
          {t('toolbar_today')}
        </Button>
        <button
          onClick={prev}
          className="w-8 h-8 flex items-center justify-center rounded-full flex-shrink-0
                     hover:bg-surface-2 text-text-secondary transition-colors"
        >
          <ChevronLeft size={18} />
        </button>
        <button
          onClick={next}
          className="w-8 h-8 flex items-center justify-center rounded-full flex-shrink-0
                     hover:bg-surface-2 text-text-secondary transition-colors"
        >
          <ChevronRight size={18} />
        </button>
        <h1 className={`${isMobile ? 'text-lg' : 'text-[22px]'} font-normal text-text-primary ml-2 capitalize tracking-tight truncate min-w-0`}>
          {title}
        </h1>
        {isFetching && (
          <Spinner size="xs" className="ml-1 flex-shrink-0" />
        )}
      </div>

      {/* Droite — sélecteur vue + bouton création */}
      <div className="flex items-center gap-2 flex-shrink-0">
        <div className="flex border border-border rounded overflow-hidden">
          {(['day', 'week', 'month', 'year'] as ViewMode[]).map((v) => (
            <button
              key={v}
              onClick={() => setViewMode(v)}
              className={`px-3 py-1.5 text-sm transition-colors
                          ${viewMode === v
                            ? 'bg-primary text-white'
                            : 'text-text-secondary hover:bg-surface-2'}`}
            >
              {t(VIEW_LABEL_KEYS[v])}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
