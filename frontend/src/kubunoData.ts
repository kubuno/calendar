/**
 * Cross-module data sharing over the clipboard (JSON envelopes) — producer side.
 *
 * VENDORED from core `@kubuno/sdk` (`DataTransferRegistry`): replace the local
 * copy with `import { … } from '@kubuno/sdk'` once `@kubuno/sdk >= 0.1.3` is
 * published on npm. The runtime contract (envelope shape, `data-kubuno` HTML
 * marker, `core.data-card` extension point) is shared with the host and all
 * consumer modules, so the copies MUST stay in sync.
 *
 * The envelope travels in two clipboard flavors at once: `text/plain` holds a
 * human-readable summary, `text/html` holds `<span data-kubuno="<base64 JSON>">`
 * that consumer modules (chat…) detect in their paste handlers.
 */
import { ExtensionRegistry, ModuleServiceRegistry, getDateLocale } from '@kubuno/sdk'
import { format, parseISO } from 'date-fns'
import type React from 'react'
import type { EventInstance } from './api'

export interface KubunoDataEnvelope {
  kubuno: 1
  type: string
  module: string
  title?: string
  text?: string
  href?: string
  data: unknown
}

/** Extension point through which producer modules register their card renderers. */
export const DATA_CARD_EXTENSION = 'core.data-card'

export interface DataCardProps { envelope: KubunoDataEnvelope }

/** Static rendering of an envelope, for consumers that cannot host live React. */
export interface DataCardStaticRender {
  svg?: string
  dataUrl?: string
  width: number
  height: number
}

export interface DataCardRenderer {
  types: string[]
  Component?: React.ComponentType<DataCardProps>
  renderStatic?: (envelope: KubunoDataEnvelope) => Promise<DataCardStaticRender | null>
}

/** Registers this module's card renderer on the shared extension point. */
export function registerDataCardRenderer(moduleId: string, renderer: DataCardRenderer): void {
  ExtensionRegistry.register(DATA_CARD_EXTENSION, moduleId, renderer)
}

function encodeBase64Utf8(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function kubunoDataToHtml(envelope: KubunoDataEnvelope): string {
  const b64 = encodeBase64Utf8(JSON.stringify(envelope))
  const label = envelope.text ?? envelope.title ?? envelope.type
  return `<span data-kubuno="${b64}">${escapeHtml(label)}</span>`
}

/** `document.execCommand('copy')` path for browsers without the async clipboard API. */
function execCopy(text: string, html: string): boolean {
  const onCopy = (e: ClipboardEvent) => {
    e.preventDefault()
    e.clipboardData?.setData('text/plain', text)
    e.clipboardData?.setData('text/html', html)
  }
  document.addEventListener('copy', onCopy, true)
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } finally {
    document.removeEventListener('copy', onCopy, true)
  }
}

/** Writes an envelope to the system clipboard (dual `text/plain` + `text/html`). */
export async function copyKubunoData(envelope: KubunoDataEnvelope): Promise<boolean> {
  const text = envelope.text ?? envelope.title ?? JSON.stringify(envelope)
  const html = kubunoDataToHtml(envelope)
  if (typeof navigator !== 'undefined' && navigator.clipboard && typeof ClipboardItem !== 'undefined') {
    try {
      await navigator.clipboard.write([new ClipboardItem({
        'text/plain': new Blob([text], { type: 'text/plain' }),
        'text/html': new Blob([html], { type: 'text/html' }),
      })])
      return true
    } catch { /* permission denied or insecure context: fall back */ }
  }
  return execCopy(text, html)
}

/* ── Calendar-specific envelope builder ──────────────────────────────────── */

/** Payload of a `calendar.event` envelope (mirrors `EventInstance`, trimmed). */
export interface CalendarEventData {
  /** Occurrence id (a recurring event expands to one instance per occurrence). */
  id: string
  /** Stable id of the parent event. */
  event_id: string
  title: string
  starts_at: string
  ends_at: string
  all_day: boolean
  location?: string
  description?: string
  color?: string
  rrule?: string
}

/** A video-meeting link produced by another module (chat: `/chat/meet/<room>`). */
export const MEETING_LINK_RE = /\/chat\/meet\/[\w-]+/

/** Deep link into the calendar: the day view, positioned on the event's day. */
export function eventHref(startsAt: string): string {
  return `/calendar/day?date=${format(parseISO(startsAt), 'yyyy-MM-dd')}`
}

/** Human-readable summary (clipboard `text/plain`, fallback card label). */
function eventSummary(event: EventInstance): string {
  const loc   = getDateLocale()
  const start = parseISO(event.starts_at)
  const cap   = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
  const when  = cap(event.all_day
    ? format(start, 'EEEE d MMMM yyyy', { locale: loc })
    : `${format(start, 'EEEE d MMMM yyyy', { locale: loc })} · ${format(start, 'HH:mm')}–${format(parseISO(event.ends_at), 'HH:mm')}`)
  // A meeting URL is machine-readable noise in a human summary — skip it.
  const where = event.location && !MEETING_LINK_RE.test(event.location) ? event.location : null
  return [event.title, when, where].filter(Boolean).join('\n')
}

/** Envelope for one event occurrence (clipboard copy, insertion into a chat message…). */
export function eventEnvelope(event: EventInstance): KubunoDataEnvelope {
  const data: CalendarEventData = {
    id:          event.id,
    event_id:    event.event_id,
    title:       event.title,
    starts_at:   event.starts_at,
    ends_at:     event.ends_at,
    all_day:     event.all_day,
    location:    event.location    ?? undefined,
    description: event.description ?? undefined,
    color:       event.color       ?? undefined,
    rrule:       event.rrule       ?? undefined,
  }
  return {
    kubuno: 1,
    type:   'calendar.event',
    module: 'calendar',
    title:  event.title,
    text:   eventSummary(event),
    href:   eventHref(event.starts_at),
    data,
  }
}

/** Opens the core's cross-module label picker on the element an envelope describes. */
export function openLabelPicker(envelope: KubunoDataEnvelope): Promise<boolean> {
  return ModuleServiceRegistry.call<Promise<boolean>>('core', 'openLabelPicker', envelope)
    ?? Promise.resolve(false)
}
