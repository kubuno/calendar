/**
 * "Add guests" — a name you recognise, or an address you type.
 *
 * ## Why suggestions, and from two places
 *
 * Inviting used to mean knowing an address by heart and typing it without a
 * mistake. Most of the people you invite are people you already know of: the
 * colleagues your instance's directory lists, and the contacts you keep
 * yourself. So the field offers both, and typing an address nobody knows still
 * works — that is how someone outside gets invited.
 *
 * The two sources are asked the same question and merged by address, so a
 * colleague who is also in your contacts appears once. The directory answers
 * with an avatar and a display name; a contact answers with whatever it has.
 * Neither is imported: the directory is the core's own endpoint, and contacts
 * arrive through the generic suggestion point any module may fill.
 *
 * ## What it does not do
 *
 * It does not decide whether a guest may be invited. The instance's policy —
 * outside addresses, guest ceiling — is applied by the panel that owns the list
 * and, for real, by the server.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ExtensionRegistry } from '@kubuno/sdk'
import { Input } from '@ui'
import { calendarApi } from './api'

export interface GuestSuggestion {
  /** Empty when the person was picked from the directory and the instance
   *  keeps addresses private — `user_id` then carries the invitation. */
  email:        string
  user_id?:     string
  display_name?: string | null
  avatar_url?:  string | null
}

/** A suggestion source contributed by another module (contacts, today). The
 *  shape is the core's generic mention provider, so nothing here names a
 *  module and an instance without one simply has fewer suggestions. */
interface MentionLike {
  search: (q: string, opts?: { limit?: number; signal?: AbortSignal }) =>
    Promise<Array<{ label?: string; secondary?: string; email?: string; avatarUrl?: string }>>
}

const LIMIT = 6

/**
 * How many letters are needed before asking anyone.
 *
 * Two, normally — one letter matches half the directory and the answer is
 * worthless. But an input that OPENS with `@` has already said what it wants:
 * it is reaching for someone, not typing an address. That is an intention
 * stated before the first letter, so the first letter is enough.
 */
function queryOf(value: string): { q: string; mention: boolean } {
  const s = value.trim()
  if (s.startsWith('@')) return { q: s.slice(1).trim(), mention: true }
  return { q: s, mention: false }
}

/**
 * Does this read as an address at all?
 *
 * `@m` contains an `@` and is not an address — it is someone half-way through
 * naming a person. Anything that decides "this is an outside address" or
 * invites what was typed asks here rather than looking for the character.
 */
export function looksLikeAddress(raw: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw.trim())
}

/**
 * `Toto <toto@toto.com>` → `{ email, name }`.
 *
 * The form people paste, from a mail client or a message. Understood here so
 * the chip shows a name the moment it is added; the server understands it too,
 * which is what makes it true for an import or a script as well.
 */
export function parseAddress(raw: string): { email: string; name?: string } {
  const s = raw.trim()
  const open = s.lastIndexOf('<')
  if (open < 0 || !s.endsWith('>')) return { email: s }
  const email = s.slice(open + 1, -1).trim()
  if (!email.includes('@')) return { email: s }
  const name = s.slice(0, open).trim().replace(/^"|"$/g, '').trim()
  return { email, name: name || undefined }
}

export function GuestField({ value, onChange, onPick, disabled, placeholder, exclude }: {
  value: string
  onChange: (v: string) => void
  /** A suggestion was chosen, or Enter was pressed on a typed address. */
  onPick: (g: GuestSuggestion) => void
  disabled?: boolean
  placeholder?: string
  /** Addresses already on the list — offering them again invites nobody. */
  exclude: string[]
}) {
  const { t } = useTranslation('calendar')
  const [items, setItems] = useState<GuestSuggestion[]>([])
  const [open, setOpen] = useState(false)
  const [hi, setHi] = useState(0)
  const boxRef = useRef<HTMLDivElement>(null)

  const taken = useMemo(() => new Set(exclude.map(e => e.toLowerCase())), [exclude])

  useEffect(() => {
    const { q, mention } = queryOf(value)
    if (q.length < (mention ? 1 : 2)) { setItems([]); setOpen(false); return }
    const ctl = new AbortController()
    // A pause, so a name typed at speed costs one round trip and not eight.
    const timer = setTimeout(async () => {
      const merged = new Map<string, GuestSuggestion>()
      const add = (g: GuestSuggestion) => {
        // Keyed by address when there is one, by account otherwise — so a
        // colleague found in both the directory and your contacts appears once.
        const key = (g.email.trim().toLowerCase() || `id:${g.user_id}`)
        if (key === 'id:undefined' || taken.has(key) || merged.has(key)) return
        merged.set(key, { ...g, email: g.email.trim() })
      }
      // The instance's own directory.
      try {
        for (const u of await calendarApi.searchUsers(q)) {
          // No address in the answer is the normal case: most instances keep
          // them private. The account IS the invitation then — the server
          // resolves it, and the address never passes through here.
          add({
            email: u.email ?? '',
            user_id: u.email ? undefined : u.id,
            display_name: u.display_name ?? u.username,
            avatar_url: u.avatar_url,
          })
        }
      } catch { /* a directory that is closed or silent simply suggests nothing */ }
      // Whatever else this instance offers — contacts, today.
      try {
        const providers = ExtensionRegistry.getAll<MentionLike>('mentions.provider')
        const lists = await Promise.all(providers.map(p =>
          p.search(q, { limit: LIMIT, signal: ctl.signal }).catch(() => [])))
        for (const item of lists.flat()) {
          const email = item.email ?? (item.secondary?.includes('@') ? item.secondary : undefined)
          if (email) add({ email, display_name: item.label, avatar_url: item.avatarUrl })
        }
      } catch { /* idem */ }
      if (ctl.signal.aborted) return
      const list = [...merged.values()].slice(0, LIMIT)
      setItems(list)
      setHi(0)
      setOpen(list.length > 0)
    }, 180)
    return () => { ctl.abort(); clearTimeout(timer) }
  }, [value, taken])

  // Closing on an outside press, in the CAPTURE phase: this field lives inside
  // a floating window, and a window stops the press on its way up to decide
  // which window it raises. See the same note on the date picker.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown, true)
    return () => document.removeEventListener('mousedown', onDown, true)
  }, [open])

  const choose = (g: GuestSuggestion) => { onPick(g); onChange(''); setItems([]); setOpen(false) }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (open && items.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setHi(i => Math.min(i + 1, items.length - 1)); return }
      if (e.key === 'ArrowUp')   { e.preventDefault(); setHi(i => Math.max(i - 1, 0)); return }
      if (e.key === 'Escape')    { e.preventDefault(); setOpen(false); return }
      if (e.key === 'Enter')     { e.preventDefault(); choose(items[hi]); return }
    }
    // No suggestion taken: what was typed is the invitation, which is how
    // someone outside the instance is invited at all.
    if (e.key === 'Enter') {
      e.preventDefault()
      const v = parseAddress(value)
      // An address, not merely something holding an `@`: pressing Enter on the
      // `@mar` of a name being reached for would otherwise invite `@mar`.
      if (looksLikeAddress(v.email)) onPick({ email: v.email, display_name: v.name })
    }
  }

  return (
    <div ref={boxRef} className="relative">
      <Input
        type="text"
        inputMode="email"
        autoComplete="off"
        spellCheck={false}
        disabled={disabled}
        placeholder={placeholder ?? t('guests_add', { defaultValue: 'Ajouter des invités' })}
        value={value}
        onChange={e => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        className="w-full"
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
      />
      {open && (
        <ul role="listbox"
          className="absolute left-0 right-0 top-full z-20 mt-1 max-h-64 overflow-y-auto rounded-md border border-border bg-surface-0 py-1 shadow-lg">
          {items.map((g, i) => (
            <li key={g.email || g.user_id} role="option" aria-selected={i === hi}>
              <button type="button"
                onMouseEnter={() => setHi(i)}
                /* The press, not the click: a click would first blur the field,
                   and a blur that closes the list takes the target away before
                   the click lands. */
                onMouseDown={e => { e.preventDefault(); choose(g) }}
                className={`flex w-full items-center gap-2 px-2 py-1.5 text-left ${i === hi ? 'bg-surface-2' : ''}`}>
                {g.avatar_url
                  ? <img src={g.avatar_url} alt="" width={28} height={28} className="h-7 w-7 shrink-0 rounded-full object-cover" />
                  : <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-surface-2 text-xs">
                      {(g.display_name || g.email)[0]?.toUpperCase()}
                    </span>}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-text-primary">{g.display_name || g.email}</span>
                  {g.display_name && g.email
                    && <span className="block truncate text-xs text-text-secondary">{g.email}</span>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
