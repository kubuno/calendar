/**
 * Reading rich text as text.
 *
 * A description is stored as HTML — it can carry emphasis, a link, a mention of
 * someone. Everywhere else that description is consumed as WORDS: a clipboard,
 * a mail body, a search. Those places need the sentence, not the markup around
 * it, and a plain box handed the raw value shows its own source instead of what
 * was written.
 */

/**
 * The words inside rich text, with the markup dropped.
 *
 * Parsed rather than stripped with a pattern: `<` is a character people type,
 * and a description saying "a < b" is not a tag. Line breaks and paragraphs
 * survive as newlines, which is what a plain-text body wants.
 */
export function plainText(html: string): string {
  if (!html) return ''
  const doc = new DOMParser().parseFromString(
    html.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li)>/gi, '\n'), 'text/html')
  return (doc.body.textContent ?? '').replace(/\n{3,}/g, '\n\n').trim()
}
