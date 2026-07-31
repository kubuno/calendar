// Per-user, backend-persisted module preferences.
//
// Stored under `core.users.preferences[<moduleKey>]` (JSONB) via `PATCH /me`.
// PostgreSQL merges at the root level (`preferences || $1`), so writing a single
// module key never clobbers another module's keys. These settings follow the
// user across browsers/devices (unlike localStorage). The same tiny helper is
// copied verbatim into every module (modules can't share new SDK code without a
// republish).
import { useCallback } from 'react'
import { api, useAuthStore } from '@kubuno/sdk'

// Each `update` is a read-modify-write over the WHOLE module bag (PATCH /me merges
// at the root, so we must resend every key). Two updates fired before the first
// PATCH returns would both read the same base and the later one would clobber the
// earlier change — a real "my setting reverted after reload" bug when several
// fields are edited quickly. Serialising the writes on a shared promise chain
// makes each update read the store AFTER the previous one has applied its result,
// so no partial edit is ever lost. Module-scoped: all callers share the queue.
let writeChain: Promise<void> = Promise.resolve()

export function useModulePrefs<T extends Record<string, unknown>>(
  moduleKey: string,
  defaults: T,
): { prefs: T; update: (patch: Partial<T>) => Promise<void> } {
  const user = useAuthStore(s => s.user)
  const stored = (user?.preferences?.[moduleKey] as Partial<T> | undefined) ?? {}
  const prefs = { ...defaults, ...stored }

  const update = useCallback((patch: Partial<T>) => {
    writeChain = writeChain
      .catch(() => {})   // a failed write must not stall the queue
      .then(async () => {
        // Read fresh AFTER the previous write applied, so we merge onto the latest.
        const u = useAuthStore.getState().user
        const current = { ...defaults, ...((u?.preferences?.[moduleKey] as Partial<T> | undefined) ?? {}) }
        const next = { ...current, ...patch }
        const { data } = await api.patch<{ user: { preferences: Record<string, unknown> } }>(
          '/me',
          { preferences: { [moduleKey]: next } },
        )
        if (data?.user) useAuthStore.getState().updateUser({ preferences: data.user.preferences })
      })
    return writeChain
  }, [moduleKey]) // eslint-disable-line react-hooks/exhaustive-deps

  return { prefs, update }
}
