// Multi-day / all-day events rendered as continuous horizontal bars (Google
// style). A bar reads as ONE element spanning its days; the end that runs past
// the visible period is a pointed arrow tip in a darker shade of the event, and
// any other end is a rounded pill cap. Used by the Day / Week / N-day views (a
// dedicated row under the headers) and, via BannerBar, by the Month overlay.
import type { Calendar, EventInstance } from './api'
import { layoutBanners, shade } from './calendarUtils'

const BANNER_H = 22
const TIP = 7   // px width of the arrow tip when a bar continues off-period

/** A single banner bar: [dark arrow tip]?[body pill][dark arrow tip]?. `arrowLeft`
 *  / `arrowRight` make that end a pointed continuation tip (event runs past the
 *  visible period); otherwise the end is a rounded cap. `style` carries the
 *  caller's placement (grid column/row, height, marginTop…). */
export function BannerBar({ title, color, arrowLeft, arrowRight, shortenRight, style, onClick, onContextMenu }: {
  title: string
  color: string
  arrowLeft: boolean
  arrowRight: boolean
  /** True end of the event in this segment: leave a 10px gap on the right to mark
   *  where it stops (Google style). Ignored when the right end is an arrow. */
  shortenRight?: boolean
  style?: React.CSSProperties
  onClick?: (e: React.MouseEvent) => void
  onContextMenu?: (e: React.MouseEvent) => void
}) {
  const dark = shade(color, 0.62)
  return (
    <button onClick={onClick} onContextMenu={onContextMenu} title={title}
      style={{
        ...style,
        marginLeft:  arrowLeft  ? 0 : 3,
        marginRight: arrowRight ? 0 : (shortenRight ? 10 : 3),
      }}
      className="pointer-events-auto flex items-stretch overflow-hidden text-xs font-medium text-white
                 leading-none cursor-pointer hover:brightness-[1.05] transition-[filter]">
      {arrowLeft && (
        <span className="shrink-0" style={{ width: TIP, backgroundColor: dark, clipPath: 'polygon(100% 0, 100% 100%, 0 50%)' }} />
      )}
      <span
        style={{
          backgroundColor:         color,
          borderTopLeftRadius:     arrowLeft  ? 0 : 5,
          borderBottomLeftRadius:  arrowLeft  ? 0 : 5,
          borderTopRightRadius:    arrowRight ? 0 : 5,
          borderBottomRightRadius: arrowRight ? 0 : 5,
        }}
        className="flex-1 min-w-0 flex items-center px-1.5 truncate">
        {title}
      </span>
      {arrowRight && (
        <span className="shrink-0" style={{ width: TIP, backgroundColor: dark, clipPath: 'polygon(0 0, 0 100%, 100% 50%)' }} />
      )}
    </button>
  )
}

/** The row of all-day / multi-day bars for a set of visible days (Day/Week/N-day).
 *  Renders nothing when no event spans the range. Bars are placed on a grid
 *  matching the view's columns (gutters first). In a single-week strip, any event
 *  extending past the strip is a continuation → arrow tip. */
export function BannerRow({ days, events, calendars, gridCols, leadingGutters, onEventClick, onEventContextMenu }: {
  days: Date[]
  events: EventInstance[]
  calendars: Calendar[]
  gridCols: string
  leadingGutters: number
  onEventClick: (ev: EventInstance) => void
  onEventContextMenu: (e: React.MouseEvent, ev: EventInstance) => void
}) {
  const { segs, rows } = layoutBanners(events, days)
  if (rows === 0) return null
  const calMap = new Map(calendars.map(c => [c.id, c]))

  return (
    <div className="grid shrink-0 bg-surface-0 border-b border-border py-1"
      style={{ gridTemplateColumns: gridCols, gridTemplateRows: `repeat(${rows}, ${BANNER_H}px)`, rowGap: 2 }}>
      {segs.map(seg => {
        const cal   = calMap.get(seg.ev.calendar_id)
        const color = seg.ev.color ?? cal?.color ?? '#1a73e8'
        return (
          <BannerBar key={seg.ev.id}
            title={seg.ev.title}
            color={color}
            arrowLeft={seg.continuesBefore}
            arrowRight={seg.continuesAfter}
            shortenRight={!seg.continuesAfter}
            onClick={() => onEventClick(seg.ev)}
            onContextMenu={e => onEventContextMenu(e, seg.ev)}
            style={{
              gridColumn: `${leadingGutters + seg.startCol + 1} / ${leadingGutters + seg.endCol + 2}`,
              gridRow:    seg.row + 1,
            }}
          />
        )
      })}
    </div>
  )
}
