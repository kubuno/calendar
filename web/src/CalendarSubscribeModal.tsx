import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import { Rss } from 'lucide-react'
import { FloatingWindow, Button, Input, Spinner } from '@ui'
import { calendarApi } from './api'

/**
 * Subscribe to a remote iCalendar feed (http(s):// or webcal:// URL). The
 * backend creates a mirror calendar, syncs it immediately, then hourly.
 */
export default function CalendarSubscribeModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation('calendar')
  const qc = useQueryClient()

  const [name, setName] = useState('')
  const [url, setUrl]   = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const canSubmit = name.trim().length > 0 && /^(https?|webcal):\/\/.+/i.test(url.trim())

  const subscribe = async () => {
    if (!canSubmit || busy) return
    setBusy(true)
    setError(null)
    try {
      await calendarApi.subscribeCalendar({ name: name.trim(), url: url.trim() })
      qc.invalidateQueries({ queryKey: ['calendar-calendars'] })
      qc.invalidateQueries({ queryKey: ['calendar-events'] })
      onClose()
    } catch (e) {
      const msg = (e as { response?: { data?: { message?: string } } })?.response?.data?.message
      setError(msg || (e instanceof Error ? e.message : String(e)))
    } finally {
      setBusy(false)
    }
  }

  return (
    <FloatingWindow
      title={t('sub_title', { defaultValue: 'S’abonner à un agenda' })}
      icon={<Rss size={15} className="text-primary" />}
      onClose={onClose}
      defaultWidth={440}
      backdrop
    >
      <div className="flex flex-col p-5 gap-4">
        <p className="text-sm text-text-secondary">
          {t('sub_hint', { defaultValue: 'Collez l’adresse d’un flux iCalendar public (jours fériés, agenda d’équipe, calendrier sportif…). Le contenu est en lecture seule et actualisé automatiquement toutes les heures.' })}
        </p>
        <Input
          autoFocus
          label={t('cal_name', { defaultValue: 'Nom' })}
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder={t('sub_name_placeholder', { defaultValue: 'Ex. Jours fériés France' })}
        />
        <Input
          label={t('sub_url', { defaultValue: 'Adresse du flux (.ics)' })}
          value={url}
          onChange={e => setUrl(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') subscribe() }}
          placeholder="https://… ou webcal://…"
        />
        {error && <p className="text-sm text-danger">{error}</p>}
        <div className="flex items-center justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose}>{t('common_cancel', { defaultValue: 'Annuler' })}</Button>
          <Button onClick={subscribe} disabled={!canSubmit || busy}>
            {busy
              ? <><Spinner size="xs" className="mr-1.5 inline" />{t('sub_running', { defaultValue: 'Abonnement…' })}</>
              : t('sub_action', { defaultValue: 'S’abonner' })}
          </Button>
        </div>
      </div>
    </FloatingWindow>
  )
}
