/** Streaming applet fences are placeholders, never executable content. Ordinary code fences remain text. */
export function streamingAppletPresentation(
  content: string
): Array<{ type: 'text'; text: string } | { type: 'data-applet-pending'; data: {} }> {
  const parts: Array<{ type: 'text'; text: string } | { type: 'data-applet-pending'; data: {} }> =
    []
  let text = ''
  let fence: { character: string; length: number; applet: boolean } | null = null
  const flush = () => {
    if (text) {
      parts.push({ type: 'text', text })
      text = ''
    }
  }
  for (const line of content.split(/(?<=\n)/)) {
    const marker = /^( {0,3})(`{3,}|~{3,})([^\r\n]*)(?:\r?\n)?$/.exec(line)
    if (fence) {
      if (!fence.applet) text += line
      if (
        marker &&
        marker[2][0] === fence.character &&
        marker[2].length >= fence.length &&
        !marker[3].trim()
      )
        fence = null
      continue
    }
    if (marker) {
      const applet = marker[3].trim() === 'mousse-applet'
      fence = { character: marker[2][0], length: marker[2].length, applet }
      if (applet) {
        flush()
        parts.push({ type: 'data-applet-pending', data: {} })
        continue
      }
    }
    text += line
  }
  flush()
  return parts
}
