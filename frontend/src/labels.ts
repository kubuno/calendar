/**
 * The instance's labels, on an event.
 *
 * ## Labels belong to the core, not to this module
 *
 * They are the same labels a file, a note or a task carries: owned by the
 * person, shared with whoever they choose, and browsable across modules from
 * one place. So nothing is stored here — the core holds both the labels and the
 * links, and this module only says which event is being labelled.
 *
 * ## An event that does not exist yet
 *
 * A link needs something to point at. While an event is being written it has no
 * id, so the labels chosen are held in the form and attached the moment the
 * event is saved — the same order the video room follows, and for the same
 * reason: nothing may be left pointing at something that was never created.
 */
import { useQuery } from '@tanstack/react-query'
import { labelsApi, resourceKeyOf } from '@kubuno/sdk'
import type { ComponentType } from 'react'
import * as UI from '@ui'
import type { EventInstance } from './api'
import { eventEnvelope } from './kubunoData'

/** What the core calls an event when it stores a link to one. */
export const LABEL_RESOURCE_TYPE = 'event'

export interface LabelOption { id: string; name: string; color: string }

export interface LabelFieldProps {
  options: LabelOption[]
  value: string[]
  onChange: (ids: string[]) => void
  disabled?: boolean
  placeholder?: string
  emptyHint?: string
  searchPlaceholder?: string
}

/**
 * `LabelField` from the shared library, ahead of its publication.
 *
 * The component is a core primitive and lives in `@ui`; at RUNTIME that
 * specifier resolves to the host's own instance, which already has it. Only the
 * TYPE is missing, because a module typechecks against the published
 * `@kubuno/ui`. Delete this block and import from `@ui` once that package is
 * republished and this module's floor bumped.
 */
export const LabelField =
  (UI as unknown as { LabelField: ComponentType<LabelFieldProps> }).LabelField

/** Every label this person may put on something. Shared by all the forms. */
export function useLabelOptions() {
  return useQuery({
    queryKey: ['core-labels'],
    queryFn: () => labelsApi.list(),
    staleTime: 60_000,
    // An instance whose labels are unreachable shows an empty picker rather
    // than an error in the middle of an event form.
    retry: false,
  })
}

/**
 * The identity the core files this event under.
 *
 * Taken from the core's own function rather than restated here: the context
 * menu has been attaching labels under that key since before this field
 * existed, and a second definition would quietly split one event's labels into
 * two piles. (It resolves to the occurrence, not the series — so a recurring
 * event is labelled one occurrence at a time, which is what it already did.)
 */
export function eventLabelKey(event: EventInstance): string {
  return resourceKeyOf(eventEnvelope(event))
}

/** The labels already on this event. Idle while the event does not exist. */
export function useEventLabels(event?: EventInstance | null) {
  const key = event ? eventLabelKey(event) : null
  return useQuery({
    queryKey: ['event-labels', key],
    queryFn: () => labelsApi.forResource(LABEL_RESOURCE_TYPE, key as string),
    enabled: Boolean(key),
    retry: false,
  })
}

/**
 * Write the label set of an event.
 *
 * Replaces it wholesale, which is what the picker means: what is on screen IS
 * the set. The envelope travels with it so the core can show the event in its
 * own label browser — title, link, and enough of the event to draw a card —
 * without having to ask this module anything.
 */
export async function saveEventLabels(event: EventInstance, labelIds: string[]): Promise<void> {
  const envelope = eventEnvelope(event)
  await labelsApi.setForResource({
    module:        'calendar',
    resource_type: LABEL_RESOURCE_TYPE,
    resource_id:   eventLabelKey(event),
    title:         event.title,
    href:          envelope.href,
    envelope,
    label_ids:     labelIds,
  })
}
