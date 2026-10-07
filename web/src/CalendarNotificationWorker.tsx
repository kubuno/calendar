import { useEffect, useRef } from 'react'
import { formatDate, toDate, addDays, addMinutes, i18n, useNotificationStore, useAuthStore, useWsStore } from '@kubuno/sdk'
import { calendarApi } from './api'
import type { EventInstance } from './api'
import { useQueryClient } from '@tanstack/react-query'
import { useCalendarSettings } from './calendarSettings'

const REMINDER_LABEL_KEYS: Record<number, string> = {
  5: 'notif_reminder_5min', 10: 'notif_reminder_10min', 15: 'notif_reminder_15min',
  30: 'notif_reminder_30min', 60: 'notif_reminder_1h', 120: 'notif_reminder_2h',
  1440: 'notif_reminder_1day',
}

/** Short chime for a firing reminder — synthesised, so no asset to ship. */
function playChime() {
  try {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctor) return
    const ctx = new Ctor()
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(880, ctx.currentTime)
    gain.gain.setValueAtTime(0.0001, ctx.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.2, ctx.currentTime + 0.02)
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.35)
    osc.connect(gain); gain.connect(ctx.destination)
    osc.start()
    osc.stop(ctx.currentTime + 0.36)
    osc.onended = () => ctx.close().catch(() => { /* already closed */ })
  } catch { /* autoplay policy / no audio device */ }
}

export default function CalendarNotificationWorker() {
  const firedRef = useRef<Set<string>>(new Set())
  const isLoggedIn = useAuthStore(s => !!s.user)
  const { notificationsMode, notificationSound, notifyOnlyIfAccepted } = useCalendarSettings()

  // Desktop notifications need the browser's permission — asked for once, when
  // the preference selects that mode.
  useEffect(() => {
    if (notificationsMode !== 'desktop') return
    if (typeof Notification === 'undefined' || Notification.permission !== 'default') return
    Notification.requestPermission().catch(() => { /* dismissed */ })
  }, [notificationsMode])

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
    if (notificationsMode === 'off') return

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
        // "Notify me only if I answered Yes or Maybe": events the user was
        // invited to but has not accepted are skipped (their own events, which
        // carry no RSVP, always notify).
        if (notifyOnlyIfAccepted && ev.my_status
            && ev.my_status !== 'accepted' && ev.my_status !== 'tentative') continue
        const reminders = ev.reminders ?? []
        for (const reminder of reminders) {
          const key = `${ev.event_id}-${reminder.minutes_before}`
          if (firedRef.current.has(key)) continue

          const eventStart    = toDate(ev.starts_at)
          const reminderFires = addMinutes(eventStart, -reminder.minutes_before)
          const diffMs        = reminderFires.getTime() - now.getTime()

          // Fire within a ±1 minute window around the reminder time
          if (Math.abs(diffMs) <= 60_000) {
            firedRef.current.add(key)
            const labelKey = REMINDER_LABEL_KEYS[reminder.minutes_before]
            const label = labelKey
              ? i18n.t(labelKey, { ns: 'calendar' })
              : i18n.t('notif_reminder_minutes', { ns: 'calendar', count: reminder.minutes_before })

            const body = ev.all_day
              ? i18n.t('notif_all_day_body', { ns: 'calendar', date: formatDate(eventStart, { day: 'numeric', month: 'short' }) })
              : i18n.t('notif_timed_body', { ns: 'calendar', time: formatDate(eventStart, 'time'), label })

            useNotificationStore.getState().push({
              title:    ev.title,
              body,
              moduleId: 'calendar',
              icon:     'Calendar',
              link:     '/calendar',
            })

            if (notificationsMode === 'desktop'
                && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
              try { new Notification(ev.title, { body, tag: key }) }
              catch { /* unsupported outside a secure context */ }
            }
            if (notificationSound) playChime()
          }
        }
      }
    }

    check()
    const id = setInterval(check, 60_000)
    return () => clearInterval(id)
  }, [isLoggedIn, notificationsMode, notificationSound, notifyOnlyIfAccepted])

  return null
}
