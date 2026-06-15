import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { useAuthStore } from '@kubuno/sdk'
import { calendarApi } from './api'
import { Copy, CalendarDays, Check, ExternalLink } from 'lucide-react'

function CopyButton({ text }: { text: string }) {
  const { t } = useTranslation('calendar')
  const [copied, setCopied] = useState(false)
  const copy = () => {
    navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }
  return (
    <button
      onClick={copy}
      className="flex-shrink-0 p-1.5 rounded hover:bg-surface-2 text-text-tertiary hover:text-text-primary transition-colors"
      title={t('caldav_copy')}
    >
      {copied ? <Check size={14} className="text-green-600" /> : <Copy size={14} />}
    </button>
  )
}

function ConnectRow({ label, value, mono = true }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center gap-2 py-2 border-b border-[#f1f3f4] last:border-0">
      <span className="text-sm text-text-tertiary w-28 flex-shrink-0">{label}</span>
      <span className={`flex-1 text-sm text-text-primary min-w-0 truncate ${mono ? 'font-mono bg-surface-2 rounded px-2 py-0.5' : ''}`}>
        {value}
      </span>
      <CopyButton text={value} />
    </div>
  )
}

function Instruction({ title, steps }: { title: string; steps: string[] }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="border border-border rounded-lg overflow-hidden">
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center justify-between px-4 py-3 text-sm font-medium text-text-primary hover:bg-surface-1 text-left"
      >
        <span>{title}</span>
        <ExternalLink size={13} className="text-text-tertiary flex-shrink-0" />
      </button>
      {open && (
        <ol className="px-4 pb-3 space-y-1.5 border-t border-border bg-surface-1">
          {steps.map((s, i) => (
            <li key={i} className="flex gap-2 text-sm text-text-secondary pt-2">
              <span className="flex-shrink-0 w-5 h-5 rounded-full bg-primary/10 text-primary text-xs flex items-center justify-center font-semibold">
                {i + 1}
              </span>
              <span>{s}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}

export default function CalendarCalDavSettings() {
  const { t } = useTranslation('calendar')
  const user = useAuthStore(s => s.user)

  const { data, isLoading } = useQuery({
    queryKey: ['calendar-calendars-caldav'],
    queryFn:  calendarApi.listCalendars,
    staleTime: 60_000,
  })

  const username  = user?.username ?? user?.email ?? ''
  const baseUrl   = window.location.origin
  const serverUrl = `${baseUrl}/api/v1/calendar/caldav/${username}/`

  return (
    <div className="mt-6 border border-border rounded-xl overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-3 px-5 py-4 bg-surface-1 border-b border-border">
        <div className="w-8 h-8 rounded-lg bg-green-100 flex items-center justify-center flex-shrink-0">
          <CalendarDays size={16} className="text-green-600" />
        </div>
        <div>
          <p className="text-sm font-semibold text-text-primary">{t('caldav_access')}</p>
          <p className="text-xs text-text-tertiary">{t('caldav_access_help')}</p>
        </div>
      </div>

      <div className="px-5 py-4">
        {/* Common server info */}
        <p className="text-xs font-semibold text-text-tertiary uppercase tracking-wider mb-3">
          {t('caldav_main_endpoint')}
        </p>
        <ConnectRow label={t('caldav_server_url')}  value={serverUrl} />
        <ConnectRow label={t('caldav_username')} value={username} />
        <p className="text-xs text-text-tertiary mt-2 mb-4">
          {t('caldav_password_note')}
        </p>

        {/* Per-calendar tokens */}
        {isLoading ? (
          <p className="text-sm text-text-tertiary py-2">{t('caldav_loading_calendars')}</p>
        ) : (data?.calendars?.length ?? 0) > 0 ? (
          <>
            <p className="text-xs font-semibold text-text-tertiary uppercase tracking-wider mb-3">
              {t('caldav_per_calendar_url')}
            </p>
            <div className="space-y-3 mb-5">
              {data!.calendars.map(cal => {
                const calUrl = `${baseUrl}/api/v1/calendar/caldav/${username}/${cal.caldav_token}/`
                return (
                  <div key={cal.id} className="rounded-lg border border-border p-3">
                    <div className="flex items-center gap-2 mb-2">
                      <span
                        className="w-3 h-3 rounded-full flex-shrink-0"
                        style={{ backgroundColor: cal.color }}
                      />
                      <p className="text-sm font-medium text-text-primary">{cal.name}</p>
                      {cal.is_default && (
                        <span className="text-xs bg-primary/10 text-primary rounded px-1.5 py-0.5">{t('caldav_default')}</span>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="flex-1 font-mono text-xs text-text-secondary bg-surface-2 rounded px-2 py-1 truncate">
                        {calUrl}
                      </span>
                      <CopyButton text={calUrl} />
                    </div>
                  </div>
                )
              })}
            </div>
          </>
        ) : null}

        {/* Instructions */}
        <div className="space-y-3">
          <p className="text-xs font-semibold text-text-tertiary uppercase tracking-wider">
            {t('caldav_how_to_connect')}
          </p>
          <Instruction
            title={t('caldav_apple_title')}
            steps={[
              t('caldav_apple_step1'),
              t('caldav_apple_step2'),
              t('caldav_apple_step3', { server: window.location.host }),
              t('caldav_apple_step4', { path: `/api/v1/calendar/caldav/${username}/` }),
              t('caldav_step_credentials'),
            ]}
          />
          <Instruction
            title={t('caldav_thunderbird_title')}
            steps={[
              t('caldav_thunderbird_step1'),
              t('caldav_thunderbird_step2'),
              t('caldav_thunderbird_step3', { url: serverUrl }),
              t('caldav_step_credentials'),
              t('caldav_thunderbird_step5'),
            ]}
          />
          <Instruction
            title={t('caldav_android_title')}
            steps={[
              t('caldav_android_step1'),
              t('caldav_android_step2'),
              t('caldav_android_step3', { url: serverUrl }),
              t('caldav_step_credentials'),
              t('caldav_android_step5'),
            ]}
          />
          <Instruction
            title={t('caldav_windows_title')}
            steps={[
              t('caldav_windows_step1'),
              t('caldav_windows_step2', { url: serverUrl }),
              t('caldav_step_credentials'),
              t('caldav_windows_step4'),
            ]}
          />
        </div>
      </div>
    </div>
  )
}
