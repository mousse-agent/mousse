export interface ImageAttachmentPayload {
  name: string
  mimeType: string
  /** Raw base64 without data: prefix */
  data: string
}

const IMAGE_MIME = /^image\/(png|jpe?g|gif|webp|bmp)$/i

export function isImageMimeType(mimeType: string): boolean {
  return IMAGE_MIME.test(mimeType)
}

export function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') resolve(reader.result)
      else reject(new Error('Failed to read file as data URL'))
    }
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read file'))
    reader.readAsDataURL(file)
  })
}

export async function fileToImagePayload(file: File): Promise<ImageAttachmentPayload | null> {
  if (!isImageMimeType(file.type)) return null
  const dataUrl = await fileToDataUrl(file)
  const comma = dataUrl.indexOf(',')
  if (comma === -1) return null
  const header = dataUrl.slice(0, comma)
  const data = dataUrl.slice(comma + 1)
  const mimeMatch = /data:([^;]+)/.exec(header)
  const mimeType = mimeMatch?.[1] || file.type || 'image/png'
  return {
    name: file.name || `paste-${Date.now()}.png`,
    mimeType,
    data
  }
}

export async function filesToImagePayloads(files: File[]): Promise<ImageAttachmentPayload[]> {
  const payloads: ImageAttachmentPayload[] = []
  for (const file of files) {
    const payload = await fileToImagePayload(file)
    if (payload) payloads.push(payload)
  }
  return payloads
}

/**
 * The files of a paste or drop: every file, not only images. An image or file pasted without a usable name (a
 * screenshot's `image.png`, a `blob`) is named `paste-<time>.<extension>`. Text alone gives none.
 */
export function collectFilesFromDataTransfer(data: DataTransfer | null): File[] {
  if (!data) return []
  const files: File[] = []
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== 'file') continue
    const file = item.getAsFile()
    if (file) files.push(normalizePastedFile(file))
  }
  if (files.length === 0) for (const file of Array.from(data.files ?? [])) files.push(normalizePastedFile(file))
  return files
}

const PASTE_EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'video/quicktime': 'mov',
  'video/x-matroska': 'mkv',
  'audio/mpeg': 'mp3',
  'text/plain': 'txt'
}

function pasteExtension(type: string): string {
  if (!type) return 'bin'
  if (type.startsWith('image/')) return PASTE_EXTENSIONS[type] ?? 'png'
  const subtype = type.split('/')[1]?.split(/[;+]/)[0] ?? ''
  return PASTE_EXTENSIONS[type] ?? (/^[a-z0-9]{1,8}$/i.test(subtype) ? subtype.toLowerCase() : 'bin')
}

function normalizePastedFile(file: File): File {
  if (file.name && file.name !== 'image.png' && file.name !== 'blob') return file
  const type = file.type || (file.name === 'image.png' ? 'image/png' : '')
  return new File([file], `paste-${Date.now()}.${pasteExtension(type)}`, { type })
}

export function imagePayloadToDataUrl(image: ImageAttachmentPayload): string {
  return `data:${image.mimeType};base64,${image.data}`
}

/** Rebuild a paste-able File from a persisted image payload (queue → composer editing). */
export function imagePayloadToFile(image: ImageAttachmentPayload): File {
  const binary = atob(image.data)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return new File([bytes], image.name, { type: image.mimeType })
}
