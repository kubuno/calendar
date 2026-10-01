/**
 * `HelpBubble` from the shared library, ahead of its publication.
 *
 * The component itself is a core primitive and lives in `@ui`. At RUNTIME that
 * specifier resolves to the host's own instance, which already has it — so
 * nothing here re-implements anything. What is missing is only the TYPE: a
 * module typechecks against the published `@kubuno/ui`, and that package has
 * not been republished since the primitive was added.
 *
 * So the type is stated here and the value is taken as it is. When `@kubuno/ui`
 * is next published and this module's floor is bumped, DELETE this file and
 * import `HelpBubble` from `@ui` like every other primitive.
 */
import * as UI from '@ui'
import type { ComponentType, ReactNode, RefObject } from 'react'

export type HelpBubbleSide = 'top' | 'right' | 'bottom' | 'left'

export interface HelpBubbleProps {
  /** The control the help is about. The arrow points at its centre. */
  anchorRef: RefObject<HTMLElement | null>
  open: boolean
  onClose: () => void
  /** The bold opening line. Optional: a bubble may be one paragraph. */
  title?: ReactNode
  children: ReactNode
  /** Label for the dismiss button. Defaults to "OK". */
  okLabel?: ReactNode
  /** An optional second action, shown to the left of the dismiss button. */
  action?: { label: ReactNode; onClick: () => void }
  width?: number
  /** Where to try first. The order after it is always bottom → top → right → left. */
  prefer?: HelpBubbleSide
}

export const HelpBubble =
  (UI as unknown as { HelpBubble: ComponentType<HelpBubbleProps> }).HelpBubble
