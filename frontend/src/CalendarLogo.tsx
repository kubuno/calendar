// Calendar logo (designer artwork, raster). Served by the host from
// `/calendar-logo.png`; rendered as a square image so it weighs the same as
// its neighbours in the waffle menu. Signature matches the icon slots
// (size + className + title).
interface CalendarLogoProps {
  size?:      number
  className?: string
  title?:     string
}

export function CalendarLogo({ size = 24, className, title = 'Calendar' }: CalendarLogoProps) {
  return (
    <img
      src="/calendar-logo.png"
      width={size}
      height={size}
      alt={title}
      className={className}
      style={{ display: 'block', objectFit: 'contain' }}
    />
  )
}

export default CalendarLogo
