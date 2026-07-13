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

/** Collect image File objects from a paste/drop ClipboardEvent or DataTransfer. */
export function collectImageFilesFromDataTransfer(data: DataTransfer | null): File[] {
  if (!data) return []
  const files: File[] = []

  if (data.items) {
    for (const item of Array.from(data.items)) {
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const file = item.getAsFile()
        if (file) files.push(normalizePasteImageFile(file))
      }
    }
  }

  if (files.length === 0 && data.files?.length) {
    for (const file of Array.from(data.files)) {
      if (file.type.startsWith('image/')) {
        files.push(normalizePasteImageFile(file))
      }
    }
  }

  return files
}

function normalizePasteImageFile(file: File): File {
  if (file.name && file.name !== 'image.png' && file.name !== 'blob') return file
  const ext =
    file.type === 'image/jpeg' || file.type === 'image/jpg'
      ? 'jpg'
      : file.type === 'image/gif'
        ? 'gif'
        : file.type === 'image/webp'
          ? 'webp'
          : 'png'
  return new File([file], `paste-${Date.now()}.${ext}`, { type: file.type || 'image/png' })
}

export function imagePayloadToDataUrl(image: ImageAttachmentPayload): string {
  return `data:${image.mimeType};base64,${image.data}`
}
