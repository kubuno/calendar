// Render each glyph of a clock label in a fixed cell so a proportional font
// (DM Sans) lines up like monospace — every digit occupies the same width. The
// colon gets a narrower cell so the digits sit closer around it (e.g. "09:00").
// Shared by every time label across the module (grids, panels, widgets, cards).
export function MonoText({ children }: { children: string }) {
  // `whitespace-nowrap` keeps the token atomic: per-character spans would
  // otherwise allow a line break between any two glyphs (splitting "17:00").
  return (
    <span className="whitespace-nowrap">
      {children.split('').map((c, i) => (
        <span key={i} className="inline-block text-center" style={{ width: c === ':' ? '0.4ch' : '1ch' }}>
          {c === ' ' ? ' ' : c}
        </span>
      ))}
    </span>
  )
}
