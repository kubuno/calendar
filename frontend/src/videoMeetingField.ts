/**
 * The extension point for "the video call of this event".
 *
 * ## Why an extension point and not a button
 *
 * Calendar knows an event may carry a link to a call; it has no business
 * knowing who hosts calls. A text field that takes any URL is a correct — if
 * plain — way to attach one, and it is what calendar ships, because it works
 * on an instance where nothing hosts meetings and for a call held anywhere.
 *
 * A module that hosts meetings can do far better — create the room, show it as
 * a card, copy its link, take it back — and this key is how it says so.
 * Calendar never names that module: it asks the registry whether *someone*
 * active has claimed the key, and falls back to its own field otherwise. The
 * same bargain as the map behind a building's coordinates: the host owns the
 * hole, the module owns the filling.
 *
 * ## The contract
 *
 * The link travels as a STRING, the one the event stores in its `url`. A
 * provider writes its own link there (a path into this instance or an absolute
 * URL — both are links), and writes `''` to take the call away. An event holds
 * one call at a time; a provider is not asked to manage several.
 *
 * The provider is rendered TWICE: once as the field, once as the row's icon
 * (`part`). A row whose field says "Kubuno video call" while its icon is a
 * generic camera would name the host in one place and deny it in the other;
 * the module that owns the call owns its mark as well.
 *
 * ## The form is a draft until it is saved
 *
 * A link has to point somewhere before it can be saved, so a provider that
 * creates a room creates it while the event is still being written — and that
 * room may never be wanted: the call is taken back off, the form is closed, the
 * page is reloaded. Calendar is the only one who knows which of those happened,
 * so it says so, through `onDraft`.
 *
 * Calendar makes no assumption about what is being held: it does not know
 * whether anything was created, where, or what undoing it costs. It reports two
 * facts it alone owns — this form was saved, this form was abandoned — and the
 * provider decides what they mean.
 */
export const VIDEO_MEETING_FIELD = 'video-meeting-field'

/**
 * What a provider hands back when it is holding something that exists only for
 * the form currently open.
 *
 * Exactly one of the two is called, once. `commit` is awaited just before the
 * event is written, so anything the saved link depends on is settled first;
 * `discard` is called as the form closes, so it must not need to outlive it.
 */
export interface VideoMeetingDraft {
  /** The event is about to be saved: whatever backs the link becomes permanent. */
  commit: () => Promise<void>
  /** The form was abandoned, and whatever was made for it goes with it. */
  discard: () => void
}

export interface VideoMeetingFieldProps {
  /** Which part of the row is being drawn. Absent means the field. The icon
   *  part must fit a 20 px gutter and take the row's current colour. */
  part?: 'field' | 'icon'
  /** The event's link as it stands, or `''` when it has none. */
  url: string
  /** The event's title so far — the natural name for a room. May be empty. */
  title: string
  disabled?: boolean
  /** The new link, or `''` when the call is removed. */
  onChange: (url: string) => void
  /**
   * Called with a handle as soon as the provider is holding something that
   * belongs to this unsaved form, and with `null` when it stops. Only the
   * field part is given it; the icon has nothing to hold.
   *
   * The reference passed here is stable, so a provider may depend on it.
   */
  onDraft?: (draft: VideoMeetingDraft | null) => void
}
