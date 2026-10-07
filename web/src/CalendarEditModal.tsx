import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import { CalendarPlus, Pencil } from 'lucide-react'
import { FloatingWindow, Button, Input, Spinner, AnchoredPopover, ColorSwatchPicker } from '@ui'
import { calendarApi, type Calendar } from './api'
import { CALENDAR_COLORS } from './calendarColors'

/**
 * Create / edit dialog for a calendar: name, colour, description. Editing a
 * subscription calendar only exposes name + colour (content mirrors the feed).
 */
export default function CalendarEditModal({ calendar, onClose }: {
  /** undefined = creation */
  calendar?: Calendar
  onClose: () => void
}) {
  const { t } = useTranslation('calendar')
  const qc = useQueryClient()
  const isEdit = !!calendar

  const [name, setName]   = useState(calendar?.name ?? '')
  const [color, setColor] = useState(calendar?.color ?? CALENDAR_COLORS[0])
  const [description, setDescription] = useState(calendar?.description ?? '')
  const [customOpen, setCustomOpen] = useState(false)
  const customBtnRef = useRef<HTMLButtonElement>(null)
  const [busy, setBusy]   = useState(false)
  const [error, setError] = useState<string | null>(null)

  const save = async () => {
    if (!name.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      if (isEdit) {
        await calendarApi.updateCalendar(calendar.id, {
          name: name.trim(), color, description: description.trim() || undefined,
        })
      } else {
        await calendarApi.createCalendar({
          name: name.trim(), color, description: description.trim() || undefined,
        })
      }
      qc.invalidateQueries({ queryKey: ['calendar-calendars'] })
      qc.invalidateQueries({ queryKey: ['calendar-events'] })
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <FloatingWindow
      title={isEdit
        ? t('cal_edit_title', { defaultValue: 'Modifier l’agenda' })
        : t('cal_create_title', { defaultValue: 'Nouvel agenda' })}
      icon={isEdit ? <Pencil size={15} className="text-primary" /> : <CalendarPlus size={16} className="text-primary" />}
      onClose={onClose}
      defaultWidth={420}
      backdrop
    >
      <div className="flex flex-col p-5 gap-4">
        <Input
          autoFocus
          label={t('cal_name', { defaultValue: 'Nom' })}
          value={name}
          onChange={e => setName(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') save() }}
          placeholder={t('cal_name_placeholder', { defaultValue: 'Ex. Travail, Famille…' })}
        />

        {/* Couleur */}
        <div>
          <label className="block text-xs font-semibold text-text-secondary mb-1.5">
            {t('cal_color', { defaultValue: 'Couleur' })}
          </label>
          <div className="flex items-center gap-1.5 flex-wrap">
            {CALENDAR_COLORS.map(c => (
              <button
                key={c}
                onClick={() => setColor(c)}
                className={`w-6 h-6 rounded-full border-2 transition-transform ${
                  color === c ? 'border-primary scale-110' : 'border-transparent hover:scale-105'}`}
                style={{ background: c }}
                aria-label={c}
              />
            ))}
            {/* Custom color */}
            <button
              ref={customBtnRef}
              onClick={() => setCustomOpen(o => !o)}
              title={t('cal_color_custom', { defaultValue: 'Couleur personnalisée' })}
              className={`w-6 h-6 rounded-full border-2 flex items-center justify-center text-[10px] font-bold
                          ${CALENDAR_COLORS.includes(color) ? 'border-border text-text-tertiary' : 'border-primary scale-110 text-white'}`}
              style={CALENDAR_COLORS.includes(color) ? { background: 'conic-gradient(red, yellow, lime, cyan, blue, magenta, red)' } : { background: color }}
            >
              +
            </button>
            <AnchoredPopover anchorRef={customBtnRef} open={customOpen} onClose={() => setCustomOpen(false)}>
              <ColorSwatchPicker color={color} onChange={setColor} onClose={() => setCustomOpen(false)} t={t} />
            </AnchoredPopover>
          </div>
        </div>

        <Input
          label={t('cal_description', { defaultValue: 'Description (facultatif)' })}
          value={description}
          onChange={e => setDescription(e.target.value)}
        />

        {error && <p className="text-sm text-danger">{error}</p>}

        <div className="flex items-center justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose}>{t('common_cancel', { defaultValue: 'Annuler' })}</Button>
          <Button onClick={save} disabled={busy || !name.trim()}>
            {busy
              ? <><Spinner size="xs" className="mr-1.5 inline" />{t('cal_saving', { defaultValue: 'Enregistrement…' })}</>
              : isEdit
                ? t('common_save', { defaultValue: 'Enregistrer' })
                : t('cal_create_action', { defaultValue: 'Créer' })}
          </Button>
        </div>
      </div>
    </FloatingWindow>
  )
}
