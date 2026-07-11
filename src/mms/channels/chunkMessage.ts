export const DEFAULT_MAX_CHUNK = 4000

export function chunkMessage(text: string, maxLength = DEFAULT_MAX_CHUNK): string[] {
  if (text.length <= maxLength) return [text]

  const chunks: string[] = []
  let remaining = text

  while (remaining.length > maxLength) {
    let splitAt = remaining.lastIndexOf('\n', maxLength)
    if (splitAt < maxLength * 0.5) {
      splitAt = remaining.lastIndexOf(' ', maxLength)
    }
    if (splitAt < maxLength * 0.25) {
      splitAt = maxLength
    }
    chunks.push(remaining.slice(0, splitAt).trimEnd())
    remaining = remaining.slice(splitAt).trimStart()
  }

  if (remaining.length > 0) {
    chunks.push(remaining)
  }

  return chunks
}
