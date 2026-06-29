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
// NOTE: this lives in the calendar module as the pilot. Promote it to `@kubuno/sdk`
// during the rollout so every module shares one implementation.
import React, { useMemo, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api, useAuthStore } from '@kubuno/sdk'
import { Button, Input, Spinner, Toggle, Radio } from '@ui'
import { Check, Save } from 'lucide-react'

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

// ── A single control bound to a value ───────────────────────────────────────────

function Control({ item, value, onChange, disabled }: {
  item: SettingItem
  value: unknown
  onChange: (v: unknown) => void
  disabled?: boolean
}) {
  if (item.type === 'bool') {
    return (
      <label className="flex items-center gap-2 cursor-pointer select-none">
        <Toggle checked={!!value} onChange={() => onChange(!value)} disabled={disabled} />
      </label>
    )
  }
  if (item.type === 'enum') {
    const opts = normOptions(item.values)
    return (
      <div className="flex flex-col items-start gap-2">
        {opts.map(opt => (
          <Radio
            key={String(opt.value)}
            checked={String(value) === String(opt.value)}
            onChange={() => onChange(opt.value)}
            label={opt.label}
            disabled={disabled}
          />
        ))}
      </div>
    )
  }
  // int | string
  return (
    <Input
      type={item.type === 'int' ? 'number' : 'text'}
      value={value === null || value === undefined ? '' : String(value)}
      onChange={e => onChange(item.type === 'int' ? Number(e.target.value) : e.target.value)}
      disabled={disabled}
      className="max-w-xs"
    />
  )
}

function Row({ label, description, children }: {
  label: string; description?: string | null; children: React.ReactNode
}) {
  return (
    <div className="flex items-start gap-8 py-4 border-b border-[#e8eaed] last:border-0">
      <div className="w-60 flex-shrink-0">
        <p className="text-sm text-[#202124] font-normal">{label}</p>
        {description && <p className="text-xs text-text-tertiary mt-0.5 leading-relaxed">{description}</p>}
      </div>
      <div className="flex-1">{children}</div>
    </div>
  )
}

// ── The form ────────────────────────────────────────────────────────────────────

export default function ModuleSettingsForm({ moduleId, mode }: {
  moduleId: string
  mode: 'admin' | 'user'
}) {
  const qc = useQueryClient()
  const { data, isLoading } = useQuery({
    queryKey: ['module-config', moduleId],
    queryFn:  () => api.get<ConfigResponse>(`/modules/${moduleId}/config`).then(r => r.data),
  })

  // Pending edits, keyed by setting key. For `user` overridable rows we also track
  // whether the row is "customized" (has an override) separately from its value.
  const [edits, setEdits]   = useState<Record<string, unknown>>({})
  const [savedFlag, setSaved] = useState(false)

  const items = useMemo(() => {
    const all = data?.settings ?? []
    return mode === 'admin'
      ? all.filter(s => s.scope === 'global' || s.scope === 'overridable')
      : all.filter(s => s.editable_by_user)
  }, [data, mode])

  const save = useMutation({
    mutationFn: async (changes: Record<string, unknown>) => {
      if (mode === 'admin') {
        // core.settings keys are prefixed with the module id.
        const payload: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(changes)) payload[`${moduleId}.${k}`] = v
        await api.patch('/admin/settings', payload)
      } else {
        const { data: res } = await api.patch<{ user: { preferences: Record<string, unknown> } }>(
          '/me', { preferences: { [moduleId]: changes } },
        )
        if (res?.user) useAuthStore.getState().updateUser({ preferences: res.user.preferences })
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['module-config', moduleId] })
      setEdits({})
      setSaved(true)
      setTimeout(() => setSaved(false), 2500)
    },
  })

  if (isLoading) return <div className="flex justify-center py-10"><Spinner size="md" /></div>
  if (items.length === 0) {
    return <p className="text-sm text-text-tertiary py-6">Aucun paramètre à afficher.</p>
  }

  // Resolved value currently shown for a row (pending edit wins).
  const shownValue = (s: SettingItem): unknown => {
    if (s.key in edits) return edits[s.key]
    if (mode === 'admin') return s.global ?? s.default
    return s.user ?? s.effective
  }
  // For user mode, is the row currently overridden (vs. using the instance default)?
  const isOverridden = (s: SettingItem): boolean => {
    if (s.scope !== 'overridable') return true // pure `user` rows are always "on"
    if (s.key in edits) return edits[s.key] !== null
    return s.user !== null && s.user !== undefined
  }

  const setEdit = (k: string, v: unknown) => setEdits(e => ({ ...e, [k]: v }))
  const isDirty = Object.keys(edits).length > 0

  return (
    <div>
      <p className="text-xs text-text-tertiary mb-4">
        {mode === 'admin'
          ? 'Réglages appliqués à toute l\'instance (administrateurs).'
          : 'Vos préférences personnelles. Les réglages marqués peuvent surcharger le défaut de l\'instance.'}
      </p>

      <div className="bg-white rounded-xl border border-border px-5">
        {items.map(s => {
          const overridable = s.scope === 'overridable'
          const overridden  = isOverridden(s)
          return (
            <Row key={s.key} label={s.label ?? s.key} description={s.description}>
              {mode === 'user' && overridable && (
                <label className="flex items-center gap-2 cursor-pointer select-none mb-2">
                  <Toggle
                    checked={overridden}
                    onChange={() => {
                      // Toggle override on/off. Off → store null (revert to instance default).
                      setEdit(s.key, overridden ? null : (s.user ?? s.global ?? s.default))
                    }}
                  />
                  <span className="text-xs text-text-secondary">
                    {overridden
                      ? 'Personnalisé'
                      : `Réglage de l'instance (${String(s.global ?? s.default)})`}
                  </span>
                </label>
              )}
              {(mode === 'admin' || !overridable || overridden) && (
                <Control
                  item={s}
                  value={shownValue(s)}
                  onChange={v => setEdit(s.key, v)}
                  disabled={mode === 'user' && overridable && !overridden}
                />
              )}
            </Row>
          )
        })}
      </div>

      <div className="mt-4 flex items-center gap-3 justify-end">
        <Button onClick={() => save.mutate(edits)} disabled={!isDirty || save.isPending}>
          {savedFlag
            ? <><Check size={14} className="mr-1.5 inline" />Enregistré</>
            : <><Save size={15} className="mr-1.5 inline" />Enregistrer</>}
        </Button>
      </div>
    </div>
  )
}
