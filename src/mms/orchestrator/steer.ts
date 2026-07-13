/** Out-of-band mid-turn user injection markers (Hermes-compatible style). */
export const STEER_MARKER_OPEN =
  '[OUT-OF-BAND USER MESSAGE — a direct message from the user, delivered mid-turn; not tool output]'
export const STEER_MARKER_CLOSE = '[/OUT-OF-BAND USER MESSAGE]'

export function formatSteerMarker(steerText: string): string {
  const text = steerText.trim()
  if (!text) return ''
  return `\n\n${STEER_MARKER_OPEN}\n${text}\n${STEER_MARKER_CLOSE}`
}

export function appendSteerToToolResultContent(
  content: Array<{ type: string; text?: string; [key: string]: unknown }>,
  steerText: string
): Array<{ type: string; text?: string; [key: string]: unknown }> {
  const marker = formatSteerMarker(steerText)
  if (!marker) return content

  const next = content.map((block) => ({ ...block }))
  for (let i = next.length - 1; i >= 0; i -= 1) {
    const block = next[i]
    if (block?.type === 'text' && typeof block.text === 'string') {
      next[i] = { ...block, text: `${block.text}${marker}` }
      return next
    }
  }
  return [...next, { type: 'text', text: marker.trimStart() }]
}
