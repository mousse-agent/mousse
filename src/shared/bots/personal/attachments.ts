import { MAX_BOT_CHAT_ATTACHMENT_BYTES } from './methods'

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i

/** A file name that is safe in any folder: no folders, no characters a file system refuses. */
export function attachmentFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? ''
  const clean = base.replace(/[\u0000-\u001f<>:"|?*]/g, '_').replace(/^[\s.]+|[\s.]+$/g, '').slice(0, 200)
  if (!clean) return 'file'
  const dot = clean.lastIndexOf('.')
  const stem = dot > 0 ? clean.slice(0, dot) : clean
  return WINDOWS_RESERVED.test(stem) ? `_${clean}` : clean
}

/**
 * What the owner reads when a file is over `limit`: `MAX_BOT_CHAT_ATTACHMENT_BYTES`, or `REMOTE_BOT_FILE_BYTES` for a
 * bot of another computer.
 */
export function attachmentTooLargeText(name: string, limit = MAX_BOT_CHAT_ATTACHMENT_BYTES): string {
  return `${name} is larger than ${limit / 1024 / 1024} MB.`
}
