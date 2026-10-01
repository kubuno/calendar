/**
 * One line of the guest list, and the card behind it.
 *
 * ## Three things a name has to carry
 *
 * Who they are (photo, name, the address when the name is not the address),
 * where their answer stands, and — the part that is easy to leave out — whether
 * we can say anything about their availability at all. A guest with no account
 * here is someone whose calendar this instance cannot read: the "Find a time"
 * grid will never draw a busy band for them, and a grid that stays empty
 * without saying why is read as "they are free".
 *
 * So such a guest is marked with an asterisk, and the asterisk is explained
 * once under the list rather than repeated on every line.
 *
 * ## The actions appear on hover, and say what they do
 *
 * Two circular buttons: welcome-but-not-required, and remove. They are quiet
 * until the pointer is on the row — a list of names should read as a list of
 * names — and each carries its own label, because a person icon and a cross are
 * not self-evident.
 */
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { UserMinus, X, HelpCircle, Mail, CalendarSearch, Building2, MapPin, Phone, Briefcase, Volume2,
  MessageSquare, Video, Link as LinkIcon, ExternalLink } from 'lucide-react'
import { AnchoredPopover } from '@ui'
import { HelpBubble } from './helpBubble'
import { ExtensionRegistry, ModuleServiceRegistry } from '@kubuno/sdk'
import { calendarApi, type DirectoryCard } from './api'

/**
 * What another module knows about a person, offered to any card that shows one.
 *
 * A generic point, filled by whoever has something to say: contacts today, an
 * HR module tomorrow. The key names no module, and an instance where nobody
 * fills it simply shows what the directory knows — which is the behaviour
 * before this existed.
 */
export const PERSON_DETAILS = 'person.details'

/** One person, as every source can recognise them. An account has an id; a
 *  plain address has only itself; most have both. */
export interface PersonRef {
  email?:  string
  userId?: string
}

export interface PersonDetail {
  /** `job_title` | `organisation` | `department` | `phone` | `address` | `note` */
  kind:   string
  value:  string
  label?: string
}

/** A named address elsewhere — a site, a profile. Rendered as a link. */
export interface PersonLink {
  label: string
  url:   string
}

/**
 * Something a module can DO with this person, offered as a button.
 *
 * The module supplies the label and the doing; the card supplies the place.
 * That is the whole point: writing to someone belongs to whoever handles mail,
 * chatting to whoever handles chat, and a calendar has no business knowing how
 * either is done.
 */
export interface PersonAction {
  id:      string
  label:   string
  /** `mail` | `chat` | `video` | `calendar` | `open` — the card picks a glyph. */
  icon?:   string
  /** Shown as the wide primary button rather than a round one. */
  primary?: boolean
  run:     () => void | Promise<void>
}

export interface PersonContribution {
  /** A photo this source holds for the person, when it has one. */
  avatar?:  string
  details?: PersonDetail[]
  links?:   PersonLink[]
  actions?: PersonAction[]
}

interface PersonDetailsProvider {
  lookup: (person: PersonRef) => Promise<PersonContribution>
}

export interface GuestLike {
  id?:           string
  email?:        string | null
  user_id?:      string | null
  display_name?: string | null
  is_organizer?: boolean
  optional?:     boolean
  /** Text under the name: the reply, or "organiser". */
  subtitle?:     string
  avatar_url?:   string | null
}

/**
 * Which of these guests already have something else at that hour.
 *
 * Asked per person, over the event's own window, and only for guests with an
 * account: the others' calendars are not ours to read — that is what the
 * asterisk says. One request each, debounced, because the hours move while the
 * form is being written and a list of five guests is five small questions, not
 * a report.
 *
 * A clash is NOT a refusal. It is the thing an organiser wants to know BEFORE
 * sending the invitation, and the reason the hour gets moved — so it is said on
 * the line, in amber, and nothing is blocked.
 */
export function useGuestConflicts(
  from: Date,
  to: Date,
  guests: Array<{ user_id?: string | null }>,
): Set<string> {
  const [busy, setBusy] = useState<Set<string>>(new Set())
  const ids = guests.map(g => g.user_id).filter(Boolean).join(',')
  const win = `${from.toISOString()}|${to.toISOString()}`

  useEffect(() => {
    const list = ids ? ids.split(',') : []
    if (!list.length) { setBusy(new Set()); return }
    let alive = true
    const timer = setTimeout(async () => {
      const found = new Set<string>()
      await Promise.all(list.map(async uid => {
        try {
          const r = await calendarApi.findCommonSlots({
            from: from.toISOString(), until: to.toISOString(), user_ids: [uid],
          })
          // The window is free only when a returned slot covers it whole with
          // nobody busy. Anything less — a partial slot, no slot at all — is a
          // clash. ⚠️ An account the instance would not let us read comes back
          // in `hidden_user_ids`: absent from the computation, NOT free, so it
          // must not be reported as available.
          const covers = (r.slots ?? []).some(sl =>
            sl.score >= 0.999
            && new Date(sl.starts_at) <= from
            && new Date(sl.ends_at) >= to)
          if (!covers && !(r.hidden_user_ids ?? []).includes(uid)) found.add(uid)
        } catch { /* une question sans réponse n'est pas un conflit */ }
      }))
      if (alive) setBusy(found)
    }, 400)
    return () => { alive = false; clearTimeout(timer) }
  }, [ids, win]) // eslint-disable-line react-hooks/exhaustive-deps

  return busy
}

/**
 * The face of a guest, without asking anyone.
 *
 * The core serves an account's photo at a URL derived from its id, so a guest
 * who has an account has a face for free — no lookup, no waiting, and it works
 * for the twenty names of a list at once. It is only when nothing is known that
 * the initial stands in.
 *
 * Order matters: what a source gave explicitly (a contact's photo, the
 * directory card) wins over the derived address, because it is the one that was
 * chosen for this person rather than computed from their id.
 */
export function avatarOf(g: { avatar_url?: string | null; user_id?: string | null }): string | null {
  return g.avatar_url || (g.user_id ? `/api/v1/users/${g.user_id}/avatar` : null)
}

/** True when this instance cannot read that person's calendar. */
export function calendarUnknown(g: GuestLike): boolean {
  return !g.is_organizer && !g.user_id
}

/**
 * Write to this person — through the instance's own mailbox when it has one.
 *
 * `mailto:` hands the reader to whatever the operating system opens, which on
 * an instance that HAS a mail module is the wrong answer: it leaves the product
 * to write a message the product could have written, and loses the signature,
 * the drafts and the sent copy. So the module is asked first, and `mailto:` is
 * what remains when nobody answers — which is the right behaviour for an
 * instance without one.
 *
 * Asked of the registry at the moment of the click, not at render: the module
 * list settles after the first paint, and a lookup frozen too early would
 * decide "nobody" for the life of the card.
 */
type ComposeFn = (draft: { to?: string[]; subject?: string; bodyHtml?: string }) => void

function writeTo(address: string): boolean {
  const compose = ModuleServiceRegistry.get<ComposeFn>('mail', 'compose')
  if (!compose) return false
  compose({ to: [address] })
  return true
}

/** The glyph for a contributed action. The module names an intent, not an icon:
 *  it has no business knowing which icon set this shell uses. */
function glyph(icon?: string) {
  switch (icon) {
    case 'chat':     return <MessageSquare size={15} />
    case 'video':    return <Video size={15} />
    case 'calendar': return <CalendarSearch size={15} />
    case 'mail':     return <Mail size={15} />
    default:         return <ExternalLink size={15} />
  }
}

/** One line of the card, drawn only when there is something to draw. */
function detail(Icon: typeof Building2, value?: string | null) {
  if (!value) return null
  return (
    <div className="flex items-start gap-2 text-text-secondary">
      <Icon size={14} className="mt-0.5 shrink-0 text-text-tertiary" />
      <span className="min-w-0 flex-1 break-words">{value}</span>
    </div>
  )
}

export function GuestRow({ guest, conflict, onToggleOptional, onRemove, onShowAvailability }: {
  guest: GuestLike
  /** Already has something else at that hour. Said, never blocked. */
  conflict?: boolean
  onToggleOptional?: () => void
  onRemove?: () => void
  /** Offered on the card: look at when this person is free. */
  onShowAvailability?: () => void
}) {
  const { t } = useTranslation('calendar')
  const [card, setCard] = useState(false)
  // ⚠️ Revealed by React state and an INLINE opacity, not by
  // `opacity-0 group-hover:opacity-100`. A module's utilities live in a cascade
  // layer the host's own utilities outrank, so that pair behaves erratically
  // here — the buttons stayed visible, measured. An inline style beats every
  // layer, which is the only property that makes this deterministic.
  const [hover, setHover] = useState(false)
  const [focused, setFocused] = useState(false)
  // Fetched when the card OPENS, not with the list: a meeting with twenty
  // guests would otherwise cost twenty requests nobody asked for.
  const [profile, setProfile] = useState<DirectoryCard | null>(null)
  const [extra, setExtra] = useState<PersonContribution>({})
  const anchor = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!card) return
    let alive = true
    if (guest.user_id) {
      calendarApi.userCard(guest.user_id).then(c => { if (alive && c) setProfile(c) })
    }
    // Everything else this instance knows, from whoever knows it. Asked by
    // ADDRESS **and** by account: on an instance whose directory keeps
    // addresses private, a colleague picked from the people list has only an
    // account id, and a source keyed on the address alone would find nobody.
    // Failures are silent: a card that shows less beats a card that shows an
    // error.
    const ref: PersonRef = { email: guest.email?.trim() || undefined, userId: guest.user_id ?? undefined }
    if (ref.email || ref.userId) {
      const providers = ExtensionRegistry.getAll<PersonDetailsProvider>(PERSON_DETAILS)
      Promise.all(providers.map(p => p.lookup(ref).catch(() => ({} as PersonContribution))))
        .then(parts => {
          if (!alive) return
          setExtra({
            avatar:  parts.find(p => p.avatar)?.avatar,
            details: parts.flatMap(p => p.details ?? []),
            links:   parts.flatMap(p => p.links ?? []),
            actions: parts.flatMap(p => p.actions ?? []),
          })
        })
    }
    return () => { alive = false }
  }, [card, guest.user_id, guest.email])

  const name = profile?.display_name || guest.display_name || guest.email || '?'
  const address = profile?.email || guest.email || ''
  // The photo the row shows, and the bigger one on the card. A source that
  // contributed one (a contact's) outranks both.
  const rowFace  = extra.avatar || avatarOf(guest)
  const cardFace = extra.avatar || profile?.avatar_url || avatarOf(guest)
  const details = extra.details ?? []
  // A module may ask for the wide row (a "open the full view" kind of act) or
  // take a round button beside the others.
  const wide  = (extra.actions ?? []).filter(a => a.primary)
  const round = (extra.actions ?? []).filter(a => !a.primary)
  const unknown = calendarUnknown(guest)
  // Shown on hover, kept for the keyboard, and kept for a guest already marked
  // optional — a state you can see is a state you can undo.
  const reveal = hover || focused || card
  const actionStyle = (always: boolean) => ({
    opacity: always || reveal ? 1 : 0,
    pointerEvents: (always || reveal ? 'auto' : 'none') as React.CSSProperties['pointerEvents'],
  })

  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      style={{ background: reveal ? 'var(--color-surface-1)' : undefined }}
      className="flex items-center gap-2 rounded px-1 py-1 text-sm transition-colors">
      {/* The name opens the card. A button, not a div: it is something you
          press, and the keyboard must reach it like anything else. */}
      <button ref={anchor} type="button" onClick={() => setCard(v => !v)}
        className="flex min-w-0 flex-1 items-center gap-2 text-left">
        {rowFace
          ? <img src={rowFace} alt="" width={28} height={28} loading="lazy"
              /* A photo that fails to load must not leave a broken frame: the
                 initial takes over, which is what the reader would have had. */
              onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none' }}
              className="h-7 w-7 shrink-0 rounded-full bg-surface-2 object-cover" />
          : <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-surface-2 text-xs">
              {name[0]?.toUpperCase()}
            </span>}
        <span className="min-w-0 flex-1">
          <span className="block truncate">
            {name}
            {unknown && <span className="text-text-tertiary"> *</span>}
          </span>
          {(guest.subtitle || guest.optional || conflict) && (
            <span className="block truncate text-[11px] text-text-tertiary">
              {guest.subtitle}
              {guest.optional && `${guest.subtitle ? ' · ' : ''}${t('guest_optional', { defaultValue: 'Facultatif' })}`}
              {conflict && (
                <span className="text-warning">
                  {(guest.subtitle || guest.optional) ? ' · ' : ''}
                  {t('guest_busy_then', { defaultValue: 'Occupé à cette heure' })}
                </span>
              )}
            </span>
          )}
        </span>
      </button>

      {onToggleOptional && (
        <button type="button" onClick={onToggleOptional}
          title={guest.optional
            ? t('guest_mark_required', { defaultValue: 'Marquer comme obligatoire' })
            : t('guest_mark_optional', { defaultValue: 'Marquer comme facultatif' })}
          style={actionStyle(Boolean(guest.optional))}
          className={`grid h-7 w-7 shrink-0 place-items-center rounded-full transition-opacity hover:bg-surface-2
                      ${guest.optional ? 'text-primary' : 'text-text-secondary'}`}>
          <UserMinus size={14} />
        </button>
      )}
      {onRemove && (
        <button type="button" onClick={onRemove}
          title={t('delete', { defaultValue: 'Supprimer' })}
          style={actionStyle(false)}
          className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-text-secondary
                     transition-opacity hover:bg-surface-2 hover:text-danger">
          <X size={14} />
        </button>
      )}

      {card && (
        <AnchoredPopover anchorRef={anchor} open onClose={() => setCard(false)}>
          <div data-guest-card className="w-[320px] rounded-xl border border-border bg-surface-0 p-4 shadow-xl"
            onMouseDown={e => e.stopPropagation()}>
            <div className="flex items-start gap-3">
              {cardFace
                ? <img src={cardFace} alt="" width={56} height={56} loading="lazy"
                    onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none' }}
                    className="h-14 w-14 shrink-0 rounded-full bg-surface-2 object-cover" />
                : <span className="grid h-14 w-14 shrink-0 place-items-center rounded-full bg-surface-2 text-lg">
                    {name[0]?.toUpperCase()}
                  </span>}
              <div className="min-w-0 flex-1">
                <p className="truncate text-base text-text-primary">
                  {name}
                  {/* The pronouns someone asked for belong beside their name,
                      which is the only place they are of any use. */}
                  {profile?.pronouns && (
                    <span className="ml-1.5 text-xs text-text-tertiary">({profile.pronouns})</span>
                  )}
                </p>
                {profile?.name_pronunciation && (
                  <p className="flex items-center gap-1 truncate text-xs text-text-secondary">
                    <Volume2 size={12} className="shrink-0" /> {profile.name_pronunciation}
                  </p>
                )}
                {(profile?.email || guest.email) && (
                  <p className="truncate text-xs text-text-secondary">{profile?.email || guest.email}</p>
                )}
              </div>
            </div>

            {/* Everything the sources had to say. Nothing is invented and no
                empty row is drawn: a card that lists blanks tells the reader
                the person is missing something, when it is the directory that
                is. */}
            {(profile?.org_unit || profile?.work_location || details.length > 0) && (
              <dl className="mt-3 space-y-1.5 border-t border-border pt-3 text-sm">
                {detail(Briefcase, details.find(d => d.kind === 'job_title')?.value)}
                {detail(Building2, details.find(d => d.kind === 'organisation')?.value
                  ?? details.find(d => d.kind === 'department')?.value ?? profile?.org_unit)}
                {detail(MapPin, profile?.work_location ?? details.find(d => d.kind === 'address')?.value)}
                {details.filter(d => d.kind === 'phone').slice(0, 2).map((d, i) => (
                  <div key={`ph${i}`} className="flex items-start gap-2 text-text-secondary">
                    <Phone size={14} className="mt-0.5 shrink-0 text-text-tertiary" />
                    <a href={`tel:${d.value.replace(/\s+/g, '')}`} className="truncate text-primary hover:underline">
                      {d.value}
                    </a>
                  </div>
                ))}
              </dl>
            )}

            {profile?.introduction && (
              <p className="mt-3 border-t border-border pt-3 text-sm text-text-secondary">
                {profile.introduction}
              </p>
            )}

            {/* What can be DONE, and only what really can. The wide button is
                the obvious act; the round ones are what other modules brought.
                An instance without chat simply has fewer buttons — no glyph is
                drawn for something nobody can perform. */}
            <div className="mt-3 border-t border-border pt-3">
              <div className="flex items-center gap-2">
                {address && (
                  <a href={`mailto:${address}`}
                    onClick={e => {
                      // The composer, when this instance has one. Only then is
                      // the default prevented: with no mail module, the link
                      // must keep doing exactly what a link does.
                      if (writeTo(address)) { e.preventDefault(); setCard(false) }
                    }}
                    className="flex flex-1 items-center justify-center gap-2 rounded-full bg-primary-light px-3 py-2 text-sm font-medium text-primary hover:bg-primary/15">
                    <Mail size={15} /> {t('guest_send_email', { defaultValue: 'Envoyer un e-mail' })}
                  </a>
                )}
                {round.map(a => (
                  <button key={a.id} type="button" title={a.label} aria-label={a.label}
                    onClick={() => { setCard(false); void a.run() }}
                    className="grid h-9 w-9 shrink-0 place-items-center rounded-full border border-border
                               text-text-secondary hover:bg-surface-1 hover:text-text-primary">
                    {glyph(a.icon)}
                  </button>
                ))}
                {onShowAvailability && !unknown && (
                  <button type="button"
                    title={t('guest_see_availability', { defaultValue: 'Voir sa disponibilité' })}
                    aria-label={t('guest_see_availability', { defaultValue: 'Voir sa disponibilité' })}
                    onClick={() => { setCard(false); onShowAvailability() }}
                    className="grid h-9 w-9 shrink-0 place-items-center rounded-full border border-border
                               text-text-secondary hover:bg-surface-1 hover:text-text-primary">
                    <CalendarSearch size={15} />
                  </button>
                )}
              </div>

              {(extra.links ?? []).map((l, i) => (
                <a key={`ln${i}`} href={l.url} target="_blank" rel="noopener noreferrer"
                  className="mt-2 flex items-center gap-2 rounded-md bg-surface-1 px-2 py-1.5 text-sm text-primary hover:underline">
                  <LinkIcon size={14} className="shrink-0 text-text-tertiary" />
                  <span className="truncate">{l.label}</span>
                </a>
              ))}

              {wide.map(a => (
                <button key={a.id} type="button" onClick={() => { setCard(false); void a.run() }}
                  className="mt-1 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-primary hover:bg-primary/5">
                  {glyph(a.icon)} {a.label} <ExternalLink size={13} className="ml-auto opacity-60" />
                </button>
              ))}

              {unknown && (
                <p className="px-1 pt-2 text-xs text-text-tertiary">
                  {t('guest_no_calendar_short', { defaultValue: 'Sa disponibilité ne peut pas être affichée.' })}
                </p>
              )}
            </div>
          </div>
        </AnchoredPopover>
      )}
    </div>
  )
}

/**
 * The footnote that gives the asterisk its meaning.
 *
 * Shown only when at least one name carries one, and written once for the
 * whole list. The reasons sit behind a question mark because they are the
 * answer to "why?", not something to read every time.
 */
export function GuestCalendarNote() {
  const { t } = useTranslation('calendar')
  const [why, setWhy] = useState(false)
  const anchor = useRef<HTMLButtonElement>(null)
  return (
    <p className="flex items-center gap-1 pt-1 text-xs text-text-tertiary">
      <span>* {t('guest_no_calendar', { defaultValue: 'Impossible d’afficher la disponibilité' })}</span>
      <button ref={anchor} type="button" onClick={() => setWhy(v => !v)}
        aria-label={t('guest_no_calendar_why', { defaultValue: 'Pourquoi ?' })}
        className="text-text-tertiary hover:text-text-primary">
        <HelpCircle size={13} />
      </button>
      <HelpBubble anchorRef={anchor} open={why} onClose={() => setWhy(false)}
        title={t('guest_no_calendar_intro', { defaultValue: 'La disponibilité de ces invités ne peut pas être affichée, pour l’une des raisons suivantes :' })}>
        <ul className="list-disc space-y-1 pl-4">
          <li>{t('guest_no_calendar_r1', { defaultValue: 'Ces invités n’ont pas de compte sur cette instance.' })}</li>
          <li>{t('guest_no_calendar_r2', { defaultValue: 'Leur agenda ne vous est pas partagé.' })}</li>
          <li>{t('guest_no_calendar_r3', { defaultValue: 'Leur agenda ne publie pas ses disponibilités.' })}</li>
        </ul>
      </HelpBubble>
    </p>
  )
}
