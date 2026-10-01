import { zipSync } from 'fflate'
import type { IntegrationPlatformSnapshot } from '../../../shared/integrationPlatform'

export const MAX_ZIP_BYTES = 360 * 1024
export const MAX_BASE64_BYTES = 480 * 1024
export const MAX_PACKAGE_FILES = 128
export const MAX_PACKAGE_FILE_BYTES = 2 * 1024 * 1024
export const MAX_PACKAGE_EXPANDED_BYTES = 16 * 1024 * 1024

export function asError(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error) return String((error as { message: unknown }).message)
  return String(error)
}

export function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

export function isManagedSource(source: string | undefined, managed?: boolean): boolean {
  if (managed !== undefined) return managed
  return source === 'mousse-profile' || source === 'mousse-project' || source === 'generated-agent' || source === 'mousse'
}

export function scopeLabel(scope: string, projectName?: string): string {
  return scope === 'project' ? `Project${projectName ? ` · ${projectName}` : ''}` : 'Profile'
}

export function snapshotItems(snapshot: IntegrationPlatformSnapshot | null) {
  return { skills: snapshot?.skills.skills ?? [], servers: snapshot?.mcp.servers ?? [] }
}

export function validateZipBytes(bytes: Uint8Array): void {
  if (bytes.byteLength > MAX_ZIP_BYTES) throw new Error(`Package is larger than ${Math.round(MAX_ZIP_BYTES / 1024)} KiB compressed.`)
  const encoded = Math.ceil(bytes.byteLength / 3) * 4
  if (encoded > MAX_BASE64_BYTES) throw new Error(`Package exceeds the ${Math.round(MAX_BASE64_BYTES / 1024)} KiB bridge limit.`)
}

export function toBase64(bytes: Uint8Array): string {
  let result = ''
  const chunk = 0x8000
  for (let index = 0; index < bytes.length; index += chunk) {
    result += String.fromCharCode(...bytes.subarray(index, Math.min(index + chunk, bytes.length)))
  }
  return btoa(result)
}

export async function fileToPackage(file: File): Promise<{ bytes: Uint8Array; name: string }> {
  const lower = file.name.toLowerCase()
  if (lower.endsWith('.zip')) {
    if (file.size > MAX_ZIP_BYTES) throw new Error('Package is larger than 360 KiB compressed.')
    const bytes = new Uint8Array(await file.arrayBuffer())
    validateZipBytes(bytes)
    return { bytes, name: file.name }
  }
  if (!lower.endsWith('.md')) throw new Error('Choose a Markdown file or ZIP package.')
  if (file.size > MAX_PACKAGE_FILE_BYTES) throw new Error('A package file cannot exceed 2 MiB.')
  const source = new Uint8Array(await file.arrayBuffer())
  const bytes = zipSync({ 'SKILL.md': source }, { level: 6 })
  validateZipBytes(bytes)
  return { bytes, name: file.name.replace(/\.[^.]+$/, '') + '.zip' }
}

export async function filesToPackage(files: FileList | File[]): Promise<{ bytes: Uint8Array; name: string }> {
  const entries: Record<string, Uint8Array> = Object.create(null)
  const list = Array.from(files)
  if (list.length === 0) throw new Error('Choose a folder containing SKILL.md.')
  if (list.length > MAX_PACKAGE_FILES) throw new Error(`Folders may contain at most ${MAX_PACKAGE_FILES} files.`)
  if (list.some((file) => file.size > MAX_PACKAGE_FILE_BYTES)) throw new Error('A package file cannot exceed 2 MiB.')
  if (list.reduce((total, file) => total + file.size, 0) > MAX_PACKAGE_EXPANDED_BYTES) throw new Error('Folder exceeds the 16 MiB expanded limit.')
  const seen = new Set<string>()
  let folderRoot: string | undefined
  // Validate all names and sizes before allocating any file contents.
  const paths = list.map((file) => {
    const relative = file.webkitRelativePath || file.name
    const segments = relative.split('/')
    if (segments.some((part) => !part || part === '.' || part === '..' || /[\\\x00-\x1f:]/.test(part) || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new Error('Package contains an unsafe path.')
    if (file.webkitRelativePath) {
      if (folderRoot && folderRoot !== segments[0]) throw new Error('Select one skill folder at a time.')
      folderRoot = segments.shift()
    }
    const path = segments.join('/')
    if (!path || seen.has(path.toLowerCase())) throw new Error('Package contains empty or duplicate paths.')
    seen.add(path.toLowerCase())
    return path
  })
  if (!paths.includes('SKILL.md')) throw new Error('Folder must contain SKILL.md at its root.')
  for (let index = 0; index < list.length; index += 1) entries[paths[index]] = new Uint8Array(await list[index].arrayBuffer())
  const bytes = zipSync(entries, { level: 6 })
  validateZipBytes(bytes)
  return { bytes, name: 'skill-package.zip' }
}

export function downloadPackage(fileName: string, base64: string, contentType: string): void {
  const raw = atob(base64)
  const bytes = new Uint8Array(raw.length)
  for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index)
  const url = URL.createObjectURL(new Blob([bytes], { type: contentType }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  anchor.click()
  queueMicrotask(() => URL.revokeObjectURL(url))
}

export function parseLines(value: string): string[] {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
}

export function parseMap(value: string): Record<string, string> {
  if (value.length > 128 * 1024) throw new Error('JSON object is too large.')
  const parsed = JSON.parse(value) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Expected a JSON object.')
  const entries = Object.entries(parsed)
  if (entries.length > 256) throw new Error('JSON object has too many entries.')
  for (const [key, item] of entries) {
    if (!key || ['__proto__', 'constructor', 'prototype'].includes(key) || /[\x00-\x1f]/.test(key)) throw new Error('JSON object contains an invalid key.')
    if (typeof item !== 'string' || item.includes('\0')) throw new Error('JSON object values must be strings without null characters.')
    if (item === '[redacted]') throw new Error('Enter a replacement value; masked secrets cannot be saved.')
  }
  return Object.fromEntries(entries) as Record<string, string>
}

export function formatMap(value: Record<string, string> | undefined): string {
  return value ? JSON.stringify(value, null, 2) : '{}'
}
