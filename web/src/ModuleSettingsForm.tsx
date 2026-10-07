// Generic, schema-driven settings renderer.
//
// Reads the resolved settings of a module from the core endpoint
// `GET /api/v1/modules/:module/config` (schema + global default + user override +
// effective value, already filtered by the caller's role) and renders the form
// without the module having to hand-craft any control.
//
//  • mode="admin" → instance-wide settings (scope global|overridable), saved through
//    PATCH /admin/settings.
//  • mode="user"  → per-user settings (scope user|overridable), saved through
//    PATCH /me. For an `overridable` setting the user chooses between the instance
//    default and a personal value; reverting stores a JSON null (treated as
//    "no override" by the core).
//
// Changes are applied on the spot (no Save button): every control writes through
// and the shared `['module-config', moduleId]` query is invalidated, so the views
// reading `useCalendarSettings()` update immediately.
//
// NOTE: this lives in the calendar module as the pilot. Promote it to `@kubuno/sdk`
// during the rollout so every module shares one implementation.
import React, { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api, useAuthStore } from '@kubuno/sdk'
import { Input, Spinner, Checkbox, Dropdown } from '@ui'
import { RotateCcw } from 'lucide-react'

type Scope = 'global' | 'user' | 'overridable'
type ValueType = 'bool' | 'int' | 'string' | 'enum'

// An enum domain entry is either a scalar or a { value, label } pair.
type EnumOption = string | number | boolean | { value: unknown; label?: string }

interface SettingItem {
  key:              string
  scope:            Scope
  type:             ValueType
  values:           EnumOption[] | null
  label:            string | null
  description:      string | null
  category:         string
  default:          unknown
  global:           unknown            // instance value (global|overridable), else null
  user:             unknown            // user override if present, else null
  effective:        unknown
  editable_by_user: boolean
}

interface ConfigResponse {
  module:   string
  settings: SettingItem[]
}

function normOptions(values: EnumOption[] | null): { value: unknown; label: string }[] {
  return (values ?? []).map(v =>
    v !== null && typeof v === 'object'
      ? { value: (v as { value: unknown }).value, label: String((v as { label?: string }).label ?? (v as { value: unknown }).value) }
      : { value: v, label: String(v) },
  )
}

/** Enum values are round-tripped as strings by <Dropdown>; restore the original type. */
function coerceLike(sample: unknown, raw: string): unknown {
  if (typeof sample === 'number')  return Number(raw)
  if (typeof sample === 'boolean') return raw === 'true'
  return raw
}

export default function ModuleSettingsForm({ moduleId, mode, categories }: {
  moduleId: string
  mode: 'admin' | 'user'
  /** Render only these categories, in this order. Omit for all of them. */
  categories?: string[]
}) {
  const { t } = useTranslation('calendar')
  const qc = useQueryClient()
  const { data, isLoading } = useQuery({
    queryKey: ['module-config', moduleId],
    queryFn:  () => api.get<ConfigResponse>(`/modules/${moduleId}/config`).then(r => r.data),
  })

  const [savingKey, setSavingKey] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const items = useMemo(() => {
    const all = data?.settings ?? []
    const visible = mode === 'admin'
      ? all.filter(s => s.scope === 'global' || s.scope === 'overridable')
      : all.filter(s => s.editable_by_user)
    if (!categories) return visible
    // Preserve the caller's category order, then the manifest order inside each.
    return categories.flatMap(c => visible.filter(s => s.category === c))
  }, [data, mode, categories])

  const save = useMutation({
    mutationFn: async (changes: Record<string, unknown>) => {
      if (mode === 'admin') {
        // core.settings keys are prefixed with the module id.
        const payload: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(changes)) payload[`${moduleId}.${k}`] = v
        await api.patch('/admin/settings', payload)
      } else {
        // `preferences` is merged at the ROOT level only (`preferences || $1`),
        // so the module's whole bag must be resent or the keys left out would be
        // dropped — including those written by other parts of the module.
        const current = (useAuthStore.getState().user?.preferences?.[moduleId] ?? {}) as Record<string, unknown>
        const { data: res } = await api.patch<{ user: { preferences: Record<string, unknown> } }>(
          '/me', { preferences: { [moduleId]: { ...current, ...changes } } },
        )
        if (res?.user) useAuthStore.getState().updateUser({ preferences: res.user.preferences })
      }
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['module-config', moduleId] }),
    onError:   (e) => setError(e instanceof Error ? e.message : String(e)),
  })

  const commit = (key: string, value: unknown) => {
    setError(null)
    setSavingKey(key)
    save.mutate({ [key]: value }, { onSettled: () => setSavingKey(k => (k === key ? null : k)) })
  }

  if (isLoading) return <div className="flex justify-center py-10"><Spinner size="md" /></div>
  if (items.length === 0) return null

  // Value currently in effect for a row.
  const shownValue = (s: SettingItem): unknown =>
    mode === 'admin' ? (s.global ?? s.default) : (s.user ?? s.effective)

  // In user mode an `overridable` row may be following the instance default.
  const isOverridden = (s: SettingItem): boolean =>
    s.scope !== 'overridable' || (s.user !== null && s.user !== undefined)

  const labelOf = (s: SettingItem) =>
    t(`setting_${s.key}`, { defaultValue: s.label ?? s.key })
  const helpOf = (s: SettingItem) => {
    const fallback = s.description ?? ''
    const translated = t(`setting_${s.key}_help`, { defaultValue: fallback })
    return translated.length > 0 ? translated : undefined
  }

  const renderControl = (s: SettingItem) => {
    const value    = shownValue(s)
    const disabled = savingKey === s.key
    if (s.type === 'enum') {
      const opts = normOptions(s.values)
      const sample = opts.find(o => o.value !== '' && o.value !== null)?.value
      return (
        <Dropdown
          value={String(value ?? '')}
          onChange={(v) => commit(s.key, coerceLike(sample, v))}
          options={opts.map(o => ({
            value: String(o.value),
            // Option labels are translated when the module ships a key for them,
            // otherwise the manifest's own wording is used.
            label: t(`setting_${s.key}_opt_${String(o.value)}`, { defaultValue: o.label }),
          }))}
          disabled={disabled}
          width="100%"
          height={36}
          className="max-w-sm"
        />
      )
    }
    return (
      <Input
        type={s.type === 'int' ? 'number' : 'text'}
        defaultValue={value === null || value === undefined ? '' : String(value)}
        onBlur={e => {
          const raw = e.target.value
          const next = s.type === 'int' ? Number(raw) : raw
          if (String(next) !== String(value ?? '')) commit(s.key, next)
        }}
        disabled={disabled}
        className="max-w-sm"
      />
    )
  }

  return (
    <div className="space-y-4">
      {items.map(s => {
        const overridable = s.scope === 'overridable' && mode === 'user'
        const overridden  = isOverridden(s)

        // Booleans read best as a plain checkbox row (label on the right).
        if (s.type === 'bool') {
          return (
            <div key={s.key}>
              <Checkbox
                checked={!!shownValue(s)}
                onChange={(v) => commit(s.key, v)}
                label={labelOf(s)}
                description={helpOf(s)}
                disabled={savingKey === s.key}
              />
              {overridable && overridden && (
                <RevertLink onClick={() => commit(s.key, null)} label={t('setting_revert_instance', { defaultValue: 'Rétablir le réglage de l’instance' })} />
              )}
            </div>
          )
        }

        return (
          <div key={s.key} className="max-w-sm">
            <label className="block text-xs text-text-tertiary mb-1">{labelOf(s)}</label>
            {renderControl(s)}
            {helpOf(s) && (
              <p className="text-xs text-text-tertiary mt-1 leading-relaxed">{helpOf(s)}</p>
            )}
            {overridable && overridden && (
              <RevertLink onClick={() => commit(s.key, null)} label={t('setting_revert_instance', { defaultValue: 'Rétablir le réglage de l’instance' })} />
            )}
          </div>
        )
      })}

      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  )
}

function RevertLink({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button onClick={onClick}
      className="mt-1 inline-flex items-center gap-1 text-xs text-primary hover:underline">
      <RotateCcw size={11} />
      {label}
    </button>
  )
}
