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
    name: file.name || 'image.png',
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

/** What a message already holds, so pasted images are numbered after it: its images, and its attachments' names. */
export interface HeldAttachments {
  /** How many images the message holds. */
  images: number
  /** Every attachment's name, so a pasted image never takes one already there. */
  names: readonly string[]
}

const NUMBERED_IMAGE = /^image-(\d{1,6})\.[a-z0-9]+$/i

/**
 * The files of a paste or drop: every file, not only images. An image pasted without a usable name (a screenshot's
 * `image.png`, a `blob`) is named by its place among the message's images, `image-<n>.<extension>`, after the images
 * `held` and never a number a held name has. Another file pasted without a name is named `paste-<time>.<extension>`.
 * Text alone gives none.
 */
export function collectFilesFromDataTransfer(data: DataTransfer | null, held: HeldAttachments = { images: 0, names: [] }): File[] {
  if (!data) return []
  const raw: File[] = []
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== 'file') continue
    const file = item.getAsFile()
    if (file) raw.push(file)
  }
  if (raw.length === 0) raw.push(...Array.from(data.files ?? []))
  let images = held.images
  let last = Math.max(0, ...held.names.map((name) => Number(NUMBERED_IMAGE.exec(name)?.[1] ?? 0)))
  return raw.map((file) => {
    const type = pastedType(file)
    if (type.startsWith('image/')) images += 1
    if (!unnamed(file)) return file
    if (!type.startsWith('image/')) return new File([file], `paste-${Date.now()}.${pasteExtension(type)}`, { type })
    last = Math.max(images, last + 1)
    return new File([file], `image-${last}.${pasteExtension(type)}`, { type })
  })
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

/** A clipboard's own name for a file it has no name for. */
const unnamed = (file: File): boolean => !file.name || file.name === 'image.png' || file.name === 'blob'

const pastedType = (file: File): string => file.type || (file.name === 'image.png' ? 'image/png' : '')

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
