import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Users, Copy, Check, Trash2, Globe, Search, RefreshCw } from 'lucide-react'
import { FloatingWindow, Button, Dropdown, Spinner } from '@ui'
import { calendarApi, type Calendar, type UserBrief } from './api'

/**
 * Share dialog for a calendar: share with other Kubuno users (read / write),
 * list & revoke existing shares, and manage the public read-only .ics link.
 */
export default function CalendarShareModal({ calendar, onClose }: {
  calendar: Calendar
  onClose: () => void
}) {
  const { t } = useTranslation('calendar')
  const qc = useQueryClient()

  // ── Existing shares (+ name resolution via /users/lookup) ───────────────────
  const { data: sharesData, isLoading: sharesLoading } = useQuery({
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

  // ── Recherche d'utilisateurs ─────────────────────────────────────────────────
  const [query, setQuery] = useState('')
  const [suggestions, setSuggestions] = useState<UserBrief[]>([])
  const [permission, setPermission] = useState<'read' | 'write'>('read')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current)
    const q = query.trim()
    if (q.length < 2) { setSuggestions([]); return }
    searchTimer.current = setTimeout(async () => {
      try {
        const users = await calendarApi.searchUsers(q)
        const already = new Set(shares.map(s => s.shared_with))
        setSuggestions(users.filter(u => !already.has(u.id) && u.id !== calendar.owner_id))
      } catch { setSuggestions([]) }
    }, 250)
    return () => { if (searchTimer.current) clearTimeout(searchTimer.current) }
  }, [query, shares, calendar.owner_id])

  const addShare = async (user: UserBrief) => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await calendarApi.shareCalendar(calendar.id, { user_id: user.id, permission })
      setQuery(''); setSuggestions([])
      qc.invalidateQueries({ queryKey: ['calendar-shares', calendar.id] })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally { setBusy(false) }
  }

  const removeShare = async (userId: string) => {
    try {
      await calendarApi.unshareCalendar(calendar.id, userId)
      qc.invalidateQueries({ queryKey: ['calendar-shares', calendar.id] })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const changePermission = async (userId: string, perm: 'read' | 'write') => {
    try {
      await calendarApi.shareCalendar(calendar.id, { user_id: userId, permission: perm })
      qc.invalidateQueries({ queryKey: ['calendar-shares', calendar.id] })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  // ── Lien public ──────────────────────────────────────────────────────────────
  const [isPublic, setIsPublic] = useState(calendar.is_public)
  const [copied, setCopied] = useState(false)
  const [togglingPublic, setTogglingPublic] = useState(false)
  const feedUrl = calendarApi.publicFeedUrl(calendar)

  const togglePublic = async () => {
    if (togglingPublic) return
    setTogglingPublic(true)
    try {
      await calendarApi.updateCalendar(calendar.id, { is_public: !isPublic })
      setIsPublic(p => !p)
      qc.invalidateQueries({ queryKey: ['calendar-calendars'] })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally { setTogglingPublic(false) }
  }

  const copyFeed = async () => {
    try {
      await navigator.clipboard.writeText(feedUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch { /* clipboard indisponible */ }
  }

  const permOptions = [
    { value: 'read',  label: t('share_perm_read',  { defaultValue: 'Lecture seule' }) },
    { value: 'write', label: t('share_perm_write', { defaultValue: 'Modification' }) },
  ]

  return (
    <FloatingWindow
      title={t('share_title', { defaultValue: 'Partager « {{name}} »', name: calendar.name })}
      icon={<Users size={16} className="text-primary" />}
      onClose={onClose}
      defaultWidth={480}
      defaultHeight={540}
      resizable
      backdrop
    >
      <div className="flex flex-col min-h-0 flex-1 p-5 gap-4 overflow-y-auto">
        {/* Ajout d'un utilisateur */}
        <div>
          <label className="block text-xs font-semibold text-text-secondary mb-1.5">
            {t('share_with_user', { defaultValue: 'Partager avec un utilisateur' })}
          </label>
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-tertiary" />
              <input
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder={t('share_search_placeholder', { defaultValue: 'Nom ou identifiant…' })}
                className="w-full pl-8 pr-3 py-2 text-sm rounded-lg border border-border bg-surface-0
                           text-text-primary outline-none focus:border-primary transition-colors"
              />
              {suggestions.length > 0 && (
                <div className="absolute z-20 left-0 right-0 top-full mt-1 rounded-lg border border-border
                                bg-surface-0 shadow-lg overflow-hidden">
                  {suggestions.map(u => (
                    <button
                      key={u.id}
                      onClick={() => addShare(u)}
                      className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-surface-1 transition-colors"
                    >
                      <UserAvatar user={u} />
                      <span className="text-sm text-text-primary truncate">{u.display_name || u.username}</span>
                      <span className="text-xs text-text-tertiary truncate">@{u.username}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <Dropdown
              value={permission}
              onChange={(v: string) => setPermission(v as 'read' | 'write')}
              options={permOptions}
              className="w-36 shrink-0"
            />
          </div>
        </div>

        {/* Partages existants */}
        <div>
          <label className="block text-xs font-semibold text-text-secondary mb-1.5">
            {t('share_current', { defaultValue: 'Personnes ayant accès' })}
          </label>
          {sharesLoading ? (
            <div className="py-3 text-center"><Spinner size="sm" /></div>
          ) : shares.length === 0 ? (
            <p className="text-sm text-text-tertiary italic">
              {t('share_none', { defaultValue: 'Cet agenda n’est partagé avec personne.' })}
            </p>
          ) : (
            <div className="space-y-1">
              {shares.map(s => {
                const u = userById.get(s.shared_with)
                return (
                  <div key={s.id} className="flex items-center gap-2 px-3 py-2 rounded-lg border border-border">
                    <UserAvatar user={u} />
                    <span className="flex-1 text-sm text-text-primary truncate">
                      {u ? (u.display_name || u.username) : s.shared_with.slice(0, 8)}
                    </span>
                    <Dropdown
                      value={s.permission}
                      onChange={(v: string) => changePermission(s.shared_with, v as 'read' | 'write')}
                      options={permOptions}
                      className="w-32 shrink-0"
                    />
                    <button
                      onClick={() => removeShare(s.shared_with)}
                      title={t('share_revoke', { defaultValue: 'Retirer l’accès' })}
                      className="p-1.5 rounded text-text-tertiary hover:text-danger hover:bg-danger/10 transition-colors"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* Lien public .ics */}
        <div className="rounded-xl border border-border p-3 space-y-2">
          <div className="flex items-center gap-2">
            <Globe size={15} className={isPublic ? 'text-primary' : 'text-text-tertiary'} />
            <span className="flex-1 text-sm font-medium text-text-primary">
              {t('share_public_link', { defaultValue: 'Lien public (lecture seule)' })}
            </span>
            <Button size="sm" variant={isPublic ? 'ghost' : 'primary'} onClick={togglePublic} disabled={togglingPublic}>
              {togglingPublic
                ? <RefreshCw size={13} className="animate-spin" />
                : isPublic
                  ? t('share_public_disable', { defaultValue: 'Désactiver' })
                  : t('share_public_enable', { defaultValue: 'Activer' })}
            </Button>
          </div>
          <p className="text-xs text-text-tertiary">
            {t('share_public_hint', { defaultValue: 'Toute personne disposant du lien peut consulter cet agenda (flux .ics, compatible avec les autres applications d’agenda).' })}
          </p>
          {isPublic && (
            <div className="flex items-center gap-2">
              <code className="flex-1 truncate text-xs px-2.5 py-2 rounded-lg bg-surface-1 border border-border text-text-secondary">
                {feedUrl}
              </code>
              <Button size="sm" variant="ghost" onClick={copyFeed}
                title={t('share_copy_link', { defaultValue: 'Copier le lien' })}>
                {copied ? <Check size={14} className="text-success" /> : <Copy size={14} />}
              </Button>
            </div>
          )}
        </div>

        {error && <p className="text-sm text-danger">{error}</p>}

        <div className="flex items-center justify-end pt-1 mt-auto">
          <Button variant="ghost" onClick={onClose}>
            {t('import_close', { defaultValue: 'Fermer' })}
          </Button>
        </div>
      </div>
    </FloatingWindow>
  )
}

function UserAvatar({ user }: { user?: UserBrief }) {
  if (user?.avatar_url) {
    return <img src={user.avatar_url} alt="" className="w-6 h-6 rounded-full object-cover shrink-0" />
  }
  const letter = (user?.display_name || user?.username || '?').charAt(0).toUpperCase()
  return (
    <span className="w-6 h-6 rounded-full bg-primary/15 text-primary text-xs font-semibold
                     flex items-center justify-center shrink-0">
      {letter}
    </span>
  )
}
