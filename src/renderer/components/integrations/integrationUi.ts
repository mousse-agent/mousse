import { zipSync, strToU8 } from 'fflate'
import type { IntegrationPlatformSnapshot } from '../../../shared/integrationPlatform'

export const MAX_ZIP_BYTES = 360 * 1024
export const MAX_BASE64_BYTES = 480 * 1024
export const MAX_PACKAGE_FILES = 128

export function asError(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error) return String((error as { message: unknown }).message)
  return String(error)
}

export function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

export function isManagedSource(source: string | undefined): boolean {
  return source === 'mousse-profile' || source === 'mousse-project' || source === 'mousse'
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
    const bytes = new Uint8Array(await file.arrayBuffer())
    validateZipBytes(bytes)
    return { bytes, name: file.name }
  }
  const text = await file.text()
  const bytes = zipSync({ 'SKILL.md': strToU8(text) }, { level: 0 })
  validateZipBytes(bytes)
  return { bytes, name: file.name.replace(/\.[^.]+$/, '') + '.zip' }
}

export async function filesToPackage(files: FileList | File[]): Promise<{ bytes: Uint8Array; name: string }> {
  const entries: Record<string, Uint8Array> = {}
  const list = Array.from(files)
  if (list.length === 0) throw new Error('Choose a folder containing SKILL.md.')
  if (list.length > MAX_PACKAGE_FILES) throw new Error(`Folders may contain at most ${MAX_PACKAGE_FILES} files.`)
  for (const file of list) {
    const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name
    const path = relative.split('/').slice(1).join('/') || file.name
    if (!path || path.startsWith('/') || path.includes('..')) throw new Error('Package contains an unsafe path.')
    entries[path] = new Uint8Array(await file.arrayBuffer())
  }
  if (!Object.keys(entries).some((path) => path.toLowerCase() === 'skill.md')) throw new Error('Folder must contain SKILL.md.')
  const bytes = zipSync(entries, { level: 0 })
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
  const parsed = JSON.parse(value) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Expected a JSON object.')
  return Object.fromEntries(Object.entries(parsed).map(([key, item]) => [key, String(item)]))
}

export function formatMap(value: Record<string, string> | undefined): string {
  return value ? JSON.stringify(value, null, 2) : '{}'
}
