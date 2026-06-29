import { useState, useRef, useMemo, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { CalendarPlus, UploadCloud, FileUp, CheckCircle2, AlertTriangle } from 'lucide-react'
import { FloatingWindow, Button, Dropdown, Spinner } from '@ui'
import { calendarApi, type ImportResult } from './api'

/**
 * Modal letting the user import one or more `.ics` (iCalendar) files into a
 * chosen calendar. Files are read client-side as text and posted to the
 * `/calendar/import` endpoint, which upserts each VEVENT (idempotent on UID).
 */
export default function CalendarImportModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation('calendar')
  const qc = useQueryClient()
  const inputRef = useRef<HTMLInputElement>(null)

  const { data: calData } = useQuery({
    queryKey: ['calendar-calendars'],
    queryFn:  calendarApi.listCalendars,
  })
  const calendars = useMemo(() => calData?.calendars ?? [], [calData])

  const [calendarId, setCalendarId] = useState<string>('')
  const [files, setFiles]   = useState<File[]>([])
  const [dragOver, setDragOver] = useState(false)
  const [busy, setBusy]     = useState(false)
  const [result, setResult] = useState<ImportResult | null>(null)
  const [error, setError]   = useState<string | null>(null)

  // Default the target to the user's default calendar (or the first one).
  const effectiveCalendarId =
    calendarId || calendars.find(c => c.is_default)?.id || calendars[0]?.id || ''

  const addFiles = useCallback((list: FileList | null) => {
    if (!list) return
    const picked = Array.from(list).filter(f =>
      f.name.toLowerCase().endsWith('.ics') || f.type === 'text/calendar')
    if (picked.length) setFiles(prev => [...prev, ...picked])
  }, [])

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    addFiles(e.dataTransfer.files)
  }

  const runImport = async () => {
    if (!effectiveCalendarId || files.length === 0) return
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      // Accumulate results across every selected file.
      const agg: ImportResult = { total: 0, imported: 0, updated: 0, skipped: 0, errors: [] }
      for (const file of files) {
        const text = await file.text()
        const r = await calendarApi.importIcs(effectiveCalendarId, text)
        agg.total    += r.total
        agg.imported += r.imported
        agg.updated  += r.updated
        agg.skipped  += r.skipped
        agg.errors.push(...r.errors)
      }
      setResult(agg)
      if (agg.imported > 0 || agg.updated > 0) {
        qc.invalidateQueries({ queryKey: ['calendar-events'] })
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <FloatingWindow
      title={t('import_title', { defaultValue: 'Importer un calendrier (.ics)' })}
      icon={<CalendarPlus size={16} className="text-primary" />}
      onClose={onClose}
      defaultWidth={460}
      defaultHeight={520}
      resizable
      backdrop
    >
      <div className="flex flex-col min-h-0 flex-1 p-5 gap-4 overflow-y-auto">
        {/* Target calendar */}
        <div>
          <label className="block text-xs font-semibold text-text-secondary mb-1.5">
            {t('import_target_calendar', { defaultValue: 'Agenda de destination' })}
          </label>
          {calendars.length === 0 ? (
            <p className="text-sm text-text-tertiary italic">
              {t('no_calendars', { defaultValue: 'Aucun agenda disponible' })}
            </p>
          ) : (
            <Dropdown
              value={effectiveCalendarId}
              onChange={(v: string) => setCalendarId(v)}
              options={calendars.map(c => ({ value: c.id, label: c.name }))}
              className="w-full"
            />
          )}
        </div>

        {/* Drop zone */}
        <div
          onClick={() => inputRef.current?.click()}
          onDragOver={e => { e.preventDefault(); setDragOver(true) }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
          className={`flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed
                      px-4 py-8 text-center cursor-pointer transition-colors
                      ${dragOver
                        ? 'border-primary bg-primary/5'
                        : 'border-border hover:border-primary/50 hover:bg-surface-1'}`}
        >
          <UploadCloud size={28} className="text-text-tertiary" />
          <p className="text-sm text-text-secondary">
            {t('import_drop_hint', { defaultValue: 'Glissez vos fichiers .ics ici, ou cliquez pour parcourir' })}
          </p>
          <input
            ref={inputRef}
            type="file"
            accept=".ics,text/calendar"
            multiple
            className="hidden"
            onChange={e => addFiles(e.target.files)}
          />
        </div>

        {/* Selected files */}
        {files.length > 0 && (
          <div className="space-y-1">
            {files.map((f, i) => (
              <div key={i} className="flex items-center gap-2 px-3 py-2 rounded-lg border border-border text-sm">
                <FileUp size={14} className="text-text-tertiary shrink-0" />
                <span className="flex-1 truncate text-text-primary">{f.name}</span>
                <span className="text-xs text-text-tertiary shrink-0">{(f.size / 1024).toFixed(1)} Ko</span>
                <button
                  onClick={() => setFiles(prev => prev.filter((_, j) => j !== i))}
                  className="text-text-tertiary hover:text-error transition-colors"
                  title={t('import_remove_file', { defaultValue: 'Retirer' })}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Result summary */}
        {result && (
          <div className="rounded-lg border border-border p-3 space-y-2 bg-surface-1">
            <div className="flex items-center gap-2 text-sm font-semibold text-text-primary">
              <CheckCircle2 size={16} className="text-success" />
              {t('import_done', { defaultValue: 'Import terminé' })}
            </div>
            <p className="text-sm text-text-secondary">
              {t('import_summary', {
                defaultValue: '{{imported}} ajouté(s), {{updated}} mis à jour, {{skipped}} ignoré(s) sur {{total}}.',
                imported: result.imported,
                updated:  result.updated,
                skipped:  result.skipped,
                total:    result.total,
              })}
            </p>
            {result.errors.length > 0 && (
              <div className="text-xs text-error space-y-0.5">
                <div className="flex items-center gap-1 font-medium">
                  <AlertTriangle size={12} />
                  {t('import_errors', { defaultValue: '{{count}} erreur(s)', count: result.errors.length })}
                </div>
                {result.errors.slice(0, 5).map((er, i) => (
                  <p key={i} className="truncate pl-4">{er}</p>
                ))}
              </div>
            )}
          </div>
        )}

        {error && (
          <div className="flex items-center gap-2 rounded-lg border border-error/30 bg-error/5 p-3 text-sm text-error">
            <AlertTriangle size={16} className="shrink-0" />
            {error}
          </div>
        )}

        {/* Actions */}
        <div className="flex items-center justify-end gap-2 pt-1 mt-auto">
          <Button variant="ghost" onClick={onClose}>
            {result
              ? t('import_close', { defaultValue: 'Fermer' })
              : t('import_cancel', { defaultValue: 'Annuler' })}
          </Button>
          <Button
            onClick={runImport}
            disabled={busy || files.length === 0 || !effectiveCalendarId}
          >
            {busy
              ? <><Spinner size="xs" className="mr-1.5 inline" />{t('import_running', { defaultValue: 'Import…' })}</>
              : t('import_action', { defaultValue: 'Importer' })}
          </Button>
        </div>
      </div>
    </FloatingWindow>
  )
}
