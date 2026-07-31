// "Importer et exporter" — inline counterpart of the .ics import modal, plus a
// per-calendar export (and a one-click archive of every writable calendar).
import { useState, useRef, useMemo, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { UploadCloud, FileUp, CheckCircle2, AlertTriangle, Download } from 'lucide-react'
import { Button, Dropdown, Spinner } from '@ui'
import { calendarApi, type ImportResult } from '../api'
import { Section, Field } from './parts'

export default function ImportExportSettings() {
  const { t } = useTranslation('calendar')
  const qc = useQueryClient()
  const inputRef = useRef<HTMLInputElement>(null)

  const { data: calData } = useQuery({
    queryKey: ['calendar-calendars'],
    queryFn:  calendarApi.listCalendars,
  })
  const allCalendars = useMemo(() => calData?.calendars ?? [], [calData])
  // Only calendars the user can WRITE to are valid import targets (read-only
  // shares and subscription mirrors would reject the import with a 403).
  const targets = useMemo(() => allCalendars.filter(c =>
    (c.my_permission == null || c.my_permission === 'owner' || c.my_permission === 'write')
    && !c.subscription_url), [allCalendars])

  const [calendarId, setCalendarId] = useState('')
  const [files, setFiles]     = useState<File[]>([])
  const [dragOver, setDragOver] = useState(false)
  const [busy, setBusy]       = useState(false)
  const [result, setResult]   = useState<ImportResult | null>(null)
  const [error, setError]     = useState<string | null>(null)

  const effectiveCalendarId =
    calendarId || targets.find(c => c.is_default)?.id || targets[0]?.id || ''

  const addFiles = useCallback((list: FileList | null) => {
    if (!list) return
    const picked = Array.from(list).filter(f =>
      f.name.toLowerCase().endsWith('.ics') || f.type === 'text/calendar')
    if (picked.length) setFiles(prev => [...prev, ...picked])
  }, [])

  const runImport = async () => {
    if (!effectiveCalendarId || files.length === 0) return
    setBusy(true); setError(null); setResult(null)
    try {
      // Accumulate results across every selected file.
      const agg: ImportResult = { total: 0, imported: 0, updated: 0, skipped: 0, errors: [] }
      for (const file of files) {
        const r = await calendarApi.importIcs(effectiveCalendarId, await file.text())
        agg.total += r.total; agg.imported += r.imported
        agg.updated += r.updated; agg.skipped += r.skipped
        agg.errors.push(...r.errors)
      }
      setResult(agg)
      setFiles([])
      if (agg.imported > 0 || agg.updated > 0) qc.invalidateQueries({ queryKey: ['calendar-events'] })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally { setBusy(false) }
  }

  const [exporting, setExporting] = useState<string | null>(null)
  const exportOne = async (id: string, name: string) => {
    setExporting(id)
    try { await calendarApi.exportCalendar(id, name) }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setExporting(null) }
  }

  return (
    <div>
      <Section id="import" title={t('settings_section_import', { defaultValue: 'Importer' })}>
        <div className="space-y-3 max-w-lg">
          <div
            onClick={() => inputRef.current?.click()}
            onDragOver={e => { e.preventDefault(); setDragOver(true) }}
            onDragLeave={() => setDragOver(false)}
            onDrop={e => { e.preventDefault(); setDragOver(false); addFiles(e.dataTransfer.files) }}
            className={`flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed
                        px-4 py-8 text-center cursor-pointer transition-colors
                        ${dragOver ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/50 hover:bg-surface-1'}`}
          >
            <UploadCloud size={26} className="text-text-tertiary" />
            <p className="text-text-secondary">
              {t('settings_import_pick', { defaultValue: 'Sélectionner un fichier sur votre ordinateur' })}
            </p>
            <input ref={inputRef} type="file" accept=".ics,text/calendar" multiple className="hidden"
              onChange={e => addFiles(e.target.files)} />
          </div>

          {files.length > 0 && (
            <div className="space-y-1">
              {files.map((f, i) => (
                <div key={i} className="flex items-center gap-2 px-3 py-2 rounded-lg border border-border">
                  <FileUp size={14} className="text-text-tertiary shrink-0" />
                  <span className="flex-1 truncate text-text-primary">{f.name}</span>
                  <span className="text-xs text-text-tertiary shrink-0">{(f.size / 1024).toFixed(1)} Ko</span>
                  <button onClick={() => setFiles(prev => prev.filter((_, j) => j !== i))}
                    className="text-text-tertiary hover:text-danger transition-colors"
                    title={t('import_remove_file', { defaultValue: 'Retirer' })}>✕</button>
                </div>
              ))}
            </div>
          )}

          <Field label={t('settings_import_target', { defaultValue: 'Ajouter à l’agenda' })}
            help={t('settings_import_help', { defaultValue: 'Vous pouvez importer les détails des événements au format iCalendar (.ics).' })}>
            {targets.length === 0 ? (
              <p className="text-text-tertiary italic">{t('no_calendars', { defaultValue: 'Aucun agenda disponible' })}</p>
            ) : (
              <Dropdown
                value={effectiveCalendarId}
                onChange={(v) => setCalendarId(v)}
                options={targets.map(c => ({ value: c.id, label: c.name }))}
                width="100%"
                height={36}
              />
            )}
          </Field>

          {result && (
            <div className="rounded-lg border border-border p-3 space-y-1 bg-surface-1">
              <div className="flex items-center gap-2 text-text-primary">
                <CheckCircle2 size={16} className="text-success" />
                {t('import_done', { defaultValue: 'Import terminé' })}
              </div>
              <p className="text-text-secondary">
                {t('import_summary', {
                  defaultValue: '{{imported}} ajouté(s), {{updated}} mis à jour, {{skipped}} ignoré(s) sur {{total}}.',
                  imported: result.imported, updated: result.updated,
                  skipped: result.skipped, total: result.total,
                })}
              </p>
              {result.errors.length > 0 && (
                <div className="text-xs text-danger space-y-0.5">
                  <div className="flex items-center gap-1"><AlertTriangle size={12} />
                    {t('import_errors', { defaultValue: '{{count}} erreur(s)', count: result.errors.length })}
                  </div>
                  {result.errors.slice(0, 5).map((er, i) => <p key={i} className="truncate pl-4">{er}</p>)}
                </div>
              )}
            </div>
          )}

          {error && (
            <div className="flex items-center gap-2 rounded-lg border border-danger/30 bg-danger/5 p-3 text-danger">
              <AlertTriangle size={16} className="shrink-0" />{error}
            </div>
          )}

          <Button onClick={runImport} disabled={busy || files.length === 0 || !effectiveCalendarId}>
            {busy
              ? <><Spinner size="xs" className="mr-1.5 inline" />{t('import_running', { defaultValue: 'Import…' })}</>
              : t('import_action', { defaultValue: 'Importer' })}
          </Button>
        </div>
      </Section>

      <Section id="export" title={t('settings_section_export', { defaultValue: 'Exporter' })}
        description={t('settings_export_help', { defaultValue: 'Téléchargez au format iCalendar (.ics) les agendas auxquels vous avez accès.' })}>
        {allCalendars.length === 0 ? (
          <p className="text-text-tertiary italic">{t('no_calendars', { defaultValue: 'Aucun agenda disponible' })}</p>
        ) : (
          <div className="space-y-1 max-w-lg">
            {allCalendars.map(c => (
              <div key={c.id} className="flex items-center gap-3 px-3 py-2 rounded-lg border border-border">
                <span className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: c.color }} />
                <span className="flex-1 truncate text-text-primary">{c.name}</span>
                <Button size="sm" variant="ghost" onClick={() => exportOne(c.id, c.name)} disabled={exporting === c.id}>
                  {exporting === c.id
                    ? <Spinner size="xs" />
                    : <><Download size={13} className="mr-1.5 inline" />{t('settings_export_action', { defaultValue: 'Exporter' })}</>}
                </Button>
              </div>
            ))}
          </div>
        )}
      </Section>
    </div>
  )
}
