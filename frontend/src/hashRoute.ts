// Addressable sidebar views that have no dedicated route (filters, selected
// calendar, weather location, display mode) are encoded in the URL hash:
//   /calendar/#<kind>/<id>
// They are navigated with real links (react-router `Link to=`) and read back
// from `useLocation().hash`, so direct links and the browser Back button work.

export interface HashSelection {
  kind: string
  id: string
}

/** Build the link target for an addressable, route-less sidebar view. */
export function hashTo(kind: string, id: string): string {
  return `/calendar/#${encodeURIComponent(kind)}/${encodeURIComponent(id)}`
}

/** Parse a `useLocation().hash` value back into a selection (null if absent/invalid). */
export function fromHash(hash: string | undefined | null): HashSelection | null {
  if (!hash) return null
  const raw = hash.startsWith('#') ? hash.slice(1) : hash
  const m = /^([^/]+)\/(.+)$/.exec(raw)
  if (!m) return null
  try {
    return { kind: decodeURIComponent(m[1]), id: decodeURIComponent(m[2]) }
  } catch {
    return null
  }
}

/** Read the id selected for `kind`, or null when the hash points elsewhere. */
export function hashId(hash: string | undefined | null, kind: string): string | null {
  const sel = fromHash(hash)
  return sel && sel.kind === kind ? sel.id : null
}
