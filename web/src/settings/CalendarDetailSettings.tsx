// Settings of ONE calendar: identity, sharing, access permissions, integration
// URLs, and removal (delete for an owned calendar, unsubscribe for a mirrored
// feed). Read-only sections are hidden when the user is not the owner.
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Copy, Check, Trash2, Search, RefreshCw, Download } from 'lucide-react'
import { Input, Textarea, Button, Dropdown, Spinner, Checkbox, ConfirmDialog, AnchoredPopover, ColorSwatchPicker } from '@ui'
import { useAuthStore, useConfirm } from '@kubuno/sdk'
import { calendarApi, type Calendar, type UserBrief } from '../api'
import { CALENDAR_COLORS } from '../calendarColors'
import { Section, Field } from './parts'
import { useInstancePolicy } from '../instancePolicy'

/** Anchors of this page, in render order. */
export function calendarSections(cal: Calendar, isOwner: boolean): string[] {
  if (!isOwner) return ['settings', 'permissions', 'integrate', 'remove']
  return ['settings', 'shared', 'permissions', 'integrate', 'remove']
}

function CopyField({ label, value, help }: { label: string; value: string; help?: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch { /* clipboard unavailable (insecure context) */ }
  }
  return (
    <div className="max-w-xl">
      <label className="block text-xs text-text-tertiary mb-1">{label}</label>
      <div className="flex items-center gap-2">
        <code className="flex-1 truncate text-xs px-2.5 py-2 rounded-lg bg-surface-1 border border-border text-text-secondary">
          {value}
        </code>
        <Button size="sm" variant="ghost" onClick={copy}>
          {copied ? <Check size={14} className="text-success" /> : <Copy size={14} />}
        </Button>
      </div>
      {help && <p className="text-xs text-text-tertiary mt-1 leading-relaxed">{help}</p>}
    </div>
  )
}

function UserAvatar({ user }: { user?: UserBrief }) {
  if (user?.avatar_url) {
    return <img src={user.avatar_url} alt="" className="w-6 h-6 rounded-full object-cover shrink-0" />
  }
  const letter = (user?.display_name || user?.username || '?').charAt(0).toUpperCase()
  return (
    <span className="w-6 h-6 rounded-full bg-primary/15 text-primary text-xs
                     flex items-center justify-center shrink-0">{letter}</span>
  )
}

// ── Partagé avec ───────────────────────────────────────────────────────────────

function SharingBlock({ calendar }: { calendar: Calendar }) {
  const { t } = useTranslation('calendar')
  const qc = useQueryClient()

  const { data: sharesData, isLoading } = useQuery({
    queryKey: ['calendar-shares', calendar.id],
    queryFn:  () => calendarApi.listShares(calendar.id),
  })
  const shares = useMemo(() => sharesData?.shares ?? [], [sharesData])

  const { data: sharedUsers = [] } = useQuery({
    queryKey: ['calendar-share-users', shares.map(s => s.shared_with).join(',')],
    queryFn:  () => calendarApi.lookupUsers(shares.map(s => s.shared_with)),
    enabled:  shares.length > 0,
  })
  const userById = useMemo(() => new Map(sharedUsers.map(u => [u.id, u])), [sharedUsers])

  const [query, setQuery] = useState('')
  const [suggestions, setSuggestions] = useState<UserBrief[]>([])
  const [permission, setPermission] = useState<'read' | 'write'>('read')
  const [error, setError] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current)
    const q = query.trim()
    if (q.length < 2) { setSuggestions([]); return }
    timer.current = setTimeout(async () => {
      try {
        const users = await calendarApi.searchUsers(q)
        const already = new Set(shares.map(s => s.shared_with))
        setSuggestions(users.filter(u => !already.has(u.id) && u.id !== calendar.owner_id))
      } catch { setSuggestions([]) }
    }, 250)
    return () => { if (timer.current) clearTimeout(timer.current) }
  }, [query, shares, calendar.owner_id])

  const share = async (userId: string, perm: 'read' | 'write') => {
    try {
      await calendarApi.shareCalendar(calendar.id, { user_id: userId, permission: perm })
      setQuery(''); setSuggestions([])
      qc.invalidateQueries({ queryKey: ['calendar-shares', calendar.id] })
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }

  const revoke = async (userId: string) => {
    try {
      await calendarApi.unshareCalendar(calendar.id, userId)
      qc.invalidateQueries({ queryKey: ['calendar-shares', calendar.id] })
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }

  const permOptions = [
    { value: 'read',  label: t('share_perm_read',  { defaultValue: 'Lecture seule' }) },
    { value: 'write', label: t('share_perm_write', { defaultValue: 'Modification' }) },
  ]

  return (
    <div className="max-w-xl space-y-3">
      {isLoading ? (
        <Spinner size="sm" />
      ) : shares.length === 0 ? (
        <p className="text-text-tertiary italic">
          {t('share_none', { defaultValue: 'Cet agenda n’est partagé avec personne.' })}
        </p>
      ) : (
        <div className="space-y-1">
          {shares.map(s => {
            const u = userById.get(s.shared_with)
            return (
              <div key={s.id} className="flex items-center gap-2 px-3 py-2 rounded-lg border border-border">
                <UserAvatar user={u} />
                <span className="flex-1 truncate text-text-primary">
                  {u ? (u.display_name || u.username) : s.shared_with.slice(0, 8)}
                </span>
                <Dropdown value={s.permission} options={permOptions} height={32} className="w-36 shrink-0"
                  onChange={(v) => share(s.shared_with, v as 'read' | 'write')} />
                <button onClick={() => revoke(s.shared_with)}
                  title={t('share_revoke', { defaultValue: 'Retirer l’accès' })}
                  className="p-1.5 rounded text-text-tertiary hover:text-danger hover:bg-danger/10 transition-colors">
                  <Trash2 size={14} />
                </button>
              </div>
            )
          })}
        </div>
      )}

      <div>
        <label className="block text-sm text-text-tertiary mb-1">
          {t('settings_add_people', { defaultValue: 'Ajouter des personnes' })}
        </label>
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Input value={query} onChange={e => setQuery(e.target.value)}
              placeholder={t('share_search_placeholder', { defaultValue: 'Nom ou identifiant…' })}
              leftIcon={<Search size={14} />} className="w-full" />
            {suggestions.length > 0 && (
              <div className="absolute z-20 left-0 right-0 top-full mt-1 rounded-lg border border-border
                              bg-surface-0 shadow-lg overflow-hidden">
                {suggestions.map(u => (
                  <button key={u.id} onClick={() => share(u.id, permission)}
                    className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-surface-1 transition-colors">
                    <UserAvatar user={u} />
                    <span className="text-text-primary truncate">{u.display_name || u.username}</span>
                    <span className="text-xs text-text-tertiary truncate">@{u.username}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <Dropdown value={permission} options={permOptions} height={36} className="w-36 shrink-0"
            onChange={(v) => setPermission(v as 'read' | 'write')} />
        </div>
      </div>

      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  )
}

// ── Page ───────────────────────────────────────────────────────────────────────

export default function CalendarDetailSettings({ calendar }: { calendar: Calendar }) {
  const { t } = useTranslation('calendar')
  const qc = useQueryClient()
  const { confirm, confirmState, handleConfirm, handleCancel } = useConfirm()
  const me = useAuthStore(s => s.user)
  const colorBtnRef = useRef<HTMLButtonElement>(null)
  const [colorOpen, setColorOpen] = useState(false)
  const isOwner       = calendar.my_permission == null || calendar.my_permission === 'owner'
  const isSubscription = !!calendar.subscription_url

  const [name, setName]   = useState(calendar.name)
  const [desc, setDesc]   = useState(calendar.description ?? '')
  const [color, setColor] = useState(calendar.color)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy]   = useState(false)

  // Switching to another calendar in the left nav remounts the same component.
  useEffect(() => {
    setName(calendar.name); setDesc(calendar.description ?? ''); setColor(calendar.color)
    setSaved(false); setError(null)
  }, [calendar.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const patch = async (dto: Parameters<typeof calendarApi.updateCalendar>[1]) => {
    setError(null)
    try {
      await calendarApi.updateCalendar(calendar.id, dto)
      qc.invalidateQueries({ queryKey: ['calendar-calendars'] })
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }

  const remove = async () => {
    const ok = await confirm({
      title: isSubscription
        ? t('settings_unsubscribe', { defaultValue: 'Se désabonner de l’agenda' })
        : t('settings_delete_calendar', { defaultValue: 'Supprimer l’agenda' }),
      message: isSubscription
        ? t('settings_unsubscribe_confirm', { defaultValue: 'Vous n’aurez plus accès à cet agenda. Continuer ?' })
        : t('settings_delete_confirm', { defaultValue: 'Tous les événements de cet agenda seront supprimés. Cette action est irréversible.' }),
      confirmLabel: isSubscription
        ? t('settings_unsubscribe_action', { defaultValue: 'Se désabonner' })
        : t('common_delete', { defaultValue: 'Supprimer' }),
      cancelLabel: t('common_cancel', { defaultValue: 'Annuler' }),
      variant: 'danger',
    })
    if (!ok) return
    setBusy(true)
    try {
      await calendarApi.deleteCalendar(calendar.id)
      qc.invalidateQueries({ queryKey: ['calendar-calendars'] })
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }

  const refresh = async () => {
    setBusy(true)
    try {
      await calendarApi.refreshCalendar(calendar.id)
      qc.invalidateQueries({ queryKey: ['calendar-events'] })
      setSaved(true); setTimeout(() => setSaved(false), 2000)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }

  const baseUrl  = window.location.origin
  const username = me?.username ?? ''
  const caldavUrl = `${baseUrl}/api/v1/calendar/caldav/${username}/${calendar.caldav_token}/`
  const feedUrl   = calendarApi.publicFeedUrl(calendar)
  // Publishing may be closed instance-wide; the server refuses the flag either
  // way, so the checkbox gives way to the reason rather than to a failing click.
  const policy    = useInstancePolicy()

  return (
    <div>
      <Section id="settings" title={t('settings_section_calendar', { defaultValue: 'Paramètres de l’agenda' })}>
        <div className="space-y-4 max-w-sm">
          <Field label={t('calendar_name', { defaultValue: 'Nom' })}>
            <Input value={name} onChange={e => setName(e.target.value)} disabled={!isOwner}
              onBlur={() => { if (name.trim() && name !== calendar.name) patch({ name: name.trim() }) }}
              className="w-full" />
          </Field>

          <Field label={t('description', { defaultValue: 'Description' })}>
            <Textarea value={desc} onChange={e => setDesc(e.target.value)} disabled={!isOwner} rows={3}
              onBlur={() => { if (desc !== (calendar.description ?? '')) patch({ description: desc }) }}
              className="w-full" />
          </Field>

          {isOwner && (
            <Field label={t('cal_color', { defaultValue: 'Couleur' })}>
              <div className="flex items-center gap-1.5 flex-wrap">
                {CALENDAR_COLORS.map(c => (
                  <button key={c} onClick={() => { setColor(c); patch({ color: c }) }} aria-label={c}
                    className={`w-6 h-6 rounded-full border-2 transition-transform
                                ${color === c ? 'border-primary scale-110' : 'border-transparent hover:scale-105'}`}
                    style={{ background: c }} />
                ))}
                <button ref={colorBtnRef} onClick={() => setColorOpen(o => !o)}
                  title={t('cal_color_custom', { defaultValue: 'Couleur personnalisée' })}
                  className={`w-6 h-6 rounded-full border-2 flex items-center justify-center text-[10px]
                              ${CALENDAR_COLORS.includes(color) ? 'border-border text-text-tertiary' : 'border-primary scale-110 text-white'}`}
                  style={CALENDAR_COLORS.includes(color)
                    ? { background: 'conic-gradient(red, yellow, lime, cyan, blue, magenta, red)' }
                    : { background: color }}>
                  +
                </button>
                <AnchoredPopover anchorRef={colorBtnRef} open={colorOpen} onClose={() => setColorOpen(false)}>
                  <ColorSwatchPicker color={color} t={t} onClose={() => setColorOpen(false)}
                    onChange={(c: string) => { setColor(c); patch({ color: c }) }} />
                </AnchoredPopover>
              </div>
            </Field>
          )}

          <Field label={t('timezone', { defaultValue: 'Fuseau horaire' })}>
            <div className="px-3 py-2 rounded-lg border border-border bg-surface-1 text-text-secondary truncate">
              {calendar.timezone}
            </div>
          </Field>

          {isSubscription && (
            <Field label={t('settings_subscription_url', { defaultValue: 'Adresse du flux synchronisé' })}
              help={calendar.last_synced_at
                ? t('settings_last_synced', { defaultValue: 'Dernière synchronisation : {{date}}', date: new Date(calendar.last_synced_at).toLocaleString() })
                : undefined}>
              <code className="block truncate text-xs px-2.5 py-2 rounded-lg bg-surface-1 border border-border text-text-secondary">
                {calendar.subscription_url}
              </code>
            </Field>
          )}

          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => calendarApi.exportCalendar(calendar.id, calendar.name)}>
              <Download size={13} className="mr-1.5 inline" />
              {t('settings_export_calendar', { defaultValue: 'Exporter l’agenda' })}
            </Button>
            {isSubscription && (
              <Button variant="ghost" size="sm" onClick={refresh} disabled={busy}>
                <RefreshCw size={13} className={`mr-1.5 inline ${busy ? 'animate-spin' : ''}`} />
                {t('settings_refresh_feed', { defaultValue: 'Synchroniser maintenant' })}
              </Button>
            )}
            {saved && <span className="text-xs text-success">{t('saved', { defaultValue: 'Enregistré' })}</span>}
          </div>

          {error && <p className="text-xs text-danger">{error}</p>}
        </div>
      </Section>

      {isOwner && !isSubscription && (
        <Section id="shared" title={t('settings_section_shared', { defaultValue: 'Partagé avec' })}>
          <SharingBlock calendar={calendar} />
        </Section>
      )}

      <Section id="permissions" title={t('settings_section_permissions', { defaultValue: 'Autorisations d’accès aux événements' })}>
        <div className="max-w-xl space-y-3">
          {policy.allowPublicCalendars ? (
            <>
              <Checkbox
                checked={calendar.is_public}
                onChange={(v) => patch({ is_public: v })}
                disabled={!isOwner}
                label={t('settings_make_public', { defaultValue: 'Rendre disponible publiquement' })}
                description={t('settings_make_public_help', { defaultValue: 'Toute personne disposant du lien peut consulter cet agenda en lecture seule.' })}
              />
              {calendar.is_public && (
                <CopyField label={t('share_public_link', { defaultValue: 'Lien public (lecture seule)' })} value={feedUrl} />
              )}
            </>
          ) : (
            <p className="text-xs text-text-tertiary">
              {t('settings_public_disabled', { defaultValue: 'La publication d’un agenda est désactivée sur cette instance.' })}
            </p>
          )}
        </div>
      </Section>

      <Section id="integrate" title={t('settings_section_integrate', { defaultValue: 'Intégrer l’agenda' })}>
        <div className="space-y-3">
          <CopyField
            label={t('settings_caldav_url', { defaultValue: 'Adresse CalDAV' })}
            value={caldavUrl}
            help={t('settings_caldav_help', { defaultValue: 'À utiliser depuis une autre application d’agenda (Thunderbird, iOS, Evolution…).' })}
          />
          <CopyField
            label={t('settings_ical_url', { defaultValue: 'Adresse publique au format iCal' })}
            value={feedUrl}
            help={t('settings_ical_help', { defaultValue: 'Cette adresse ne fonctionne que si l’agenda est public.' })}
          />
        </div>
      </Section>

      <Section id="remove"
        title={isSubscription
          ? t('settings_unsubscribe', { defaultValue: 'Se désabonner de l’agenda' })
          : t('settings_delete_calendar', { defaultValue: 'Supprimer l’agenda' })}
        description={isSubscription
          ? t('settings_unsubscribe_help', { defaultValue: 'En vous désabonnant, vous n’aurez plus accès à cet agenda.' })
          : t('settings_delete_help', { defaultValue: 'Tous les événements de cet agenda seront supprimés.' })}>
        <Button variant="danger" onClick={remove} disabled={busy || (!isOwner && !isSubscription)}>
          {isSubscription
            ? t('settings_unsubscribe_action', { defaultValue: 'Se désabonner' })
            : t('common_delete', { defaultValue: 'Supprimer' })}
        </Button>
      </Section>

      {confirmState && (
        <ConfirmDialog {...confirmState} onConfirm={handleConfirm} onCancel={handleCancel} />
      )}
    </div>
  )
}
