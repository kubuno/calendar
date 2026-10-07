// Shared layout primitives of the Calendar settings page.
//
// The page is a single scrollable column of titled sections, mirrored by the
// left-hand navigation: each <Section> owns the anchor id the nav scrolls to.
import React from 'react'

export function Section({ id, title, description, children }: {
  id?: string
  title: string
  description?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section id={id} className="scroll-mt-4 pb-10">
      <h2 className="text-lg text-text-primary mb-1">{title}</h2>
      {description && (
        <p className="text-xs text-text-tertiary mb-4 leading-relaxed max-w-2xl">{description}</p>
      )}
      <div className={description ? '' : 'mt-4'}>{children}</div>
    </section>
  )
}

/** A secondary heading inside a section (e.g. "Autorisations des invités"). */
export function SubHeading({ children }: { children: React.ReactNode }) {
  return <h3 className="text-text-secondary mt-6 mb-3">{children}</h3>
}

/** Label + control pair, for bespoke controls sitting next to the generic form. */
export function Field({ label, help, children, className = '' }: {
  label?: string
  help?: React.ReactNode
  children: React.ReactNode
  className?: string
}) {
  return (
    <div className={`max-w-sm ${className}`}>
      {label && <label className="block text-xs text-text-tertiary mb-1">{label}</label>}
      {children}
      {help && <p className="text-xs text-text-tertiary mt-1 leading-relaxed">{help}</p>}
    </div>
  )
}
