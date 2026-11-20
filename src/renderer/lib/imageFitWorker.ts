/**
 * Decodes and encodes the composer's images off the window's thread (`imageFit.ts`). `decode` keeps the decoded image
 * under the request's id until `close`; `encode` draws it at a size and writes it as a type.
 */

const decoded = new Map<number, ImageBitmap>()
const reply = (message: unknown): void => (self as unknown as Worker).postMessage(message)
/** The long edge the see-through check samples at: enough to find a transparent area, cheap to read back. */
const ALPHA_SAMPLE_EDGE = 256

function hasAlpha(bitmap: ImageBitmap): boolean {
  const scale = Math.min(1, ALPHA_SAMPLE_EDGE / Math.max(bitmap.width, bitmap.height))
  const width = Math.max(1, Math.round(bitmap.width * scale))
  const height = Math.max(1, Math.round(bitmap.height * scale))
  const context = new OffscreenCanvas(width, height).getContext('2d', { willReadFrequently: true })
  if (!context) return true
  context.drawImage(bitmap, 0, 0, width, height)
  const pixels = context.getImageData(0, 0, width, height).data
  for (let index = 3; index < pixels.length; index += 4) if (pixels[index] < 255) return true
  return false
}

self.addEventListener('message', async (event: MessageEvent) => {
  const message = event.data as { op: string; id?: number; key?: number; blob?: Blob; width?: number; height?: number; type?: string; quality?: number }
  if (message.op === 'close') {
    decoded.get(message.key!)?.close()
    decoded.delete(message.key!)
    return
  }
  const id = message.id!
  try {
    if (message.op === 'decode') {
      const bitmap = await createImageBitmap(message.blob!)
      decoded.set(id, bitmap)
      reply({ id, ok: true, width: bitmap.width, height: bitmap.height, hasAlpha: hasAlpha(bitmap) })
      return
    }
    if (message.op === 'encode') {
      const bitmap = decoded.get(message.key!)
      if (!bitmap) throw new Error('No such image')
      const canvas = new OffscreenCanvas(message.width!, message.height!)
      const context = canvas.getContext('2d')
      if (!context) throw new Error('No canvas')
      context.imageSmoothingEnabled = true
      context.imageSmoothingQuality = 'high'
      // JPEG has no see-through pixels: any there would turn black.
      if (message.type === 'image/jpeg') {
        context.fillStyle = '#fff'
        context.fillRect(0, 0, message.width!, message.height!)
      }
      context.drawImage(bitmap, 0, 0, message.width!, message.height!)
      const blob = await canvas.convertToBlob({ type: message.type, quality: message.quality })
      reply({ id, ok: true, blob })
      return
    }
    throw new Error('Unknown operation')
  } catch {
    reply({ id, ok: false })
  }
})
