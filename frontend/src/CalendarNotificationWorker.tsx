import { useEffect, useRef } from 'react'
import { parseISO, addDays, addMinutes, format } from 'date-fns'
import { getDateLocale } from '@kubuno/sdk'
import { i18n } from '@kubuno/sdk'
import { calendarApi } from './api'
import type { EventInstance } from './api'
import { useNotificationStore } from '@kubuno/sdk'
import { useAuthStore } from '@kubuno/sdk'
import { useWsStore } from '@kubuno/sdk'
import { useQueryClient } from '@tanstack/react-query'

const REMINDER_LABEL_KEYS: Record<number, string> = {
  5: 'notif_reminder_5min', 10: 'notif_reminder_10min', 15: 'notif_reminder_15min',
  30: 'notif_reminder_30min', 60: 'notif_reminder_1h', 120: 'notif_reminder_2h',
  1440: 'notif_reminder_1day',
}

export default function CalendarNotificationWorker() {
  const firedRef = useRef<Set<string>>(new Set())
  const isLoggedIn = useAuthStore(s => !!s.user)

  // Notifications temps réel : un événement partagé a été modifié (push WS ciblé).
  const wsMessages = useWsStore(s => s.messages)
  const lastWsRef = useRef(0)
  const qc = useQueryClient()
  useEffect(() => {
    for (let i = lastWsRef.current; i < wsMessages.length; i++) {
      const m = wsMessages[i]
      const p = m.payload as { type?: string; payload?: { event_type?: string; payload?: { title?: string } } } | undefined
      if (p?.type === 'Custom' && p.payload?.event_type === 'EventModified') {
        const title = p.payload.payload?.title ?? ''
        useNotificationStore.getState().push({
          title: i18n.t('calendar:notif_event_modified_title'),
          body:  i18n.t('calendar:notif_event_modified_body', { title }),
          moduleId: 'calendar',
          link: '/calendar',
        })
        qc.invalidateQueries({ queryKey: ['calendar-events'] })
      }
    }
    lastWsRef.current = wsMessages.length
  }, [wsMessages, qc])

  useEffect(() => {
    if (!isLoggedIn) return

    const check = async () => {
      const now        = new Date()
      const rangeStart = now.toISOString()
      const rangeEnd   = addDays(now, 7).toISOString()

      let events: EventInstance[] = []
      try {
        const result = await calendarApi.listEvents(rangeStart, rangeEnd)
        events = result.events
      } catch {
        return
      }

      for (const ev of events) {
        const reminders = ev.reminders ?? []
        for (const reminder of reminders) {
          const key = `${ev.event_id}-${reminder.minutes_before}`
          if (firedRef.current.has(key)) continue

          const eventStart    = parseISO(ev.starts_at)
          const reminderFires = addMinutes(eventStart, -reminder.minutes_before)
          const diffMs        = reminderFires.getTime() - now.getTime()

          // Fire within a ±1 minute window around the reminder time
          if (Math.abs(diffMs) <= 60_000) {
            firedRef.current.add(key)
            const labelKey = REMINDER_LABEL_KEYS[reminder.minutes_before]
            const label = labelKey
              ? i18n.t(labelKey, { ns: 'calendar' })
              : i18n.t('notif_reminder_minutes', { ns: 'calendar', count: reminder.minutes_before })

            useNotificationStore.getState().push({
              title:    ev.title,
              body:     ev.all_day
                ? i18n.t('notif_all_day_body', { ns: 'calendar', date: format(eventStart, 'd MMM', { locale: getDateLocale() }) })
                : i18n.t('notif_timed_body', { ns: 'calendar', time: format(eventStart, 'HH:mm'), label }),
              moduleId: 'calendar',
              icon:     'Calendar',
              link:     '/calendar',
            })
          }
        }
      }
    }

    check()
    const id = setInterval(check, 60_000)
    return () => clearInterval(id)
  }, [isLoggedIn])

  return null
}
