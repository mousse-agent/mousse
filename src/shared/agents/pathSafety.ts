import { AgentDefinitionError } from './errors'
import { AGENT_BUNDLE_MAX_BYTES, AGENT_PROMPT_MAX_BYTES } from './defaults'

const WINDOWS_DRIVE = /^[a-zA-Z]:[\\/]/

export function assertSafeBundlePath(relativePath: string, pointer = '/files'): string {
  if (typeof relativePath !== 'string' || relativePath.length === 0) {
    throw new AgentDefinitionError('PATH_ESCAPE', 'Bundle path is empty.', { pointer })
  }
  if (relativePath.includes('\0')) {
    throw new AgentDefinitionError('PATH_ESCAPE', 'Bundle path contains a NUL byte.', {
      pointer,
      details: { path: relativePath }
    })
  }
  const normalized = relativePath.replace(/\\/g, '/')
  if (normalized.startsWith('/') || WINDOWS_DRIVE.test(normalized)) {
    throw new AgentDefinitionError('PATH_ESCAPE', 'Bundle path must be relative.', {
      pointer,
      details: { path: relativePath }
    })
  }
  const parts = normalized.split('/')
  for (const part of parts) {
    if (part === '' || part === '.' || part === '..') {
      throw new AgentDefinitionError('PATH_ESCAPE', 'Bundle path must not contain "." or "..".', {
        pointer,
        details: { path: relativePath }
      })
    }
  }
  return normalized
}

export function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

export function assertPromptSize(prompt: string, pointer = '/files/system.md'): void {
  const bytes = utf8ByteLength(prompt)
  if (bytes > AGENT_PROMPT_MAX_BYTES) {
    throw new AgentDefinitionError(
      'PROMPT_TOO_LARGE',
      `System prompt is ${bytes} bytes; maximum is ${AGENT_PROMPT_MAX_BYTES}.`,
      { pointer, details: { bytes, maxBytes: AGENT_PROMPT_MAX_BYTES } }
    )
  }
}

export function assertBundleSize(files: Record<string, string>): void {
  let total = 0
  for (const [path, content] of Object.entries(files)) {
    assertSafeBundlePath(path, `/files/${path}`)
    total += utf8ByteLength(content)
    if (total > AGENT_BUNDLE_MAX_BYTES) {
      throw new AgentDefinitionError(
        'IMPORT_LIMIT',
        `Bundle exceeds ${AGENT_BUNDLE_MAX_BYTES} bytes.`,
        { details: { bytes: total, maxBytes: AGENT_BUNDLE_MAX_BYTES } }
      )
    }
  }
}

export function isSafeRelativeRoot(root: string, candidate: string): boolean {
  const normalizedRoot = root.replace(/\\/g, '/').replace(/\/+$/, '')
  const normalizedCandidate = candidate.replace(/\\/g, '/').replace(/\/+$/, '')
  return (
    normalizedCandidate === normalizedRoot ||
    normalizedCandidate.startsWith(`${normalizedRoot}/`)
  )
}
