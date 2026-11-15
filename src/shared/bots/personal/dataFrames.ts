/** Fixed request frames. Escape the closing marker so outside text cannot end its own frame. */
export function dataFrame(source: string, text: string): string {
  return `[data from ${source}]\n${text.split('[end of data]').join('[end of data (quoted)]')}\n[end of data]`
}

/** Unclosed frames consume the rest, rather than filing their contents as Mousse's words. */
export function splitDataFrames(text: string): { text: string; frames: Array<{ source: string; text: string }> } {
  const frames: Array<{ source: string; text: string }> = []
  const words = text
  // Scan in order: markers inside a frame are its data, not nested frames.
  const opening = /\[output\]|\[data from ([^\]\r\n]+)\]/g
  let result = '', from = 0
  let match: RegExpExecArray | null
  while ((match = opening.exec(words))) {
    const endMarker = match[0] === '[output]' ? '[end of output]' : '[end of data]'
    const end = words.indexOf(endMarker, opening.lastIndex)
    const stop = end < 0 ? words.length : end
    const n = frames.length
    frames.push({ source: match[1] ?? 'command output', text: words.slice(opening.lastIndex, stop).replace(/^\n|\n$/g, '') })
    result += words.slice(from, match.index) + `[outside data ${n + 1}]`
    from = end < 0 ? words.length : end + endMarker.length
    opening.lastIndex = from
  }
  return { text: result + words.slice(from), frames }
}
