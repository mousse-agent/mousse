import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { browserNavigationUrl } from '../../shared/browser/validation'
import type { BrowserArtifactPort, BrowserJournalPort, BrowserPolicyPort } from './ports'

function assertInside(root: string, candidate: string): string {
  const base = resolve(root)
  const path = resolve(candidate)
  const prefix = process.platform === 'win32' ? base.toLowerCase() : base
  const value = process.platform === 'win32' ? path.toLowerCase() : path
  if (value !== prefix && !value.startsWith(prefix.endsWith('\\') || prefix.endsWith('/') ? prefix : prefix + (process.platform === 'win32' ? '\\' : '/'))) {
    throw new Error('Path escapes injected root')
  }
  return path
}

export function createAllowHttpPolicy(): BrowserPolicyPort {
  return {
    authorize(input) {
      const url = input.url ?? (input.action && 'url' in input.action ? input.action.url : undefined)
      if (url !== undefined) {
        try {
          browserNavigationUrl(url)
        } catch (error) {
          return { allowed: false, code: 'policy_denied', message: error instanceof Error ? error.message : String(error) }
        }
      }
      return { allowed: true }
    }
  }
}

export function createFilesystemArtifactPort(artifactRoot: string): BrowserArtifactPort {
  if (!isAbsolute(artifactRoot)) throw new Error('artifactRoot must be absolute')
  return {
    async write(input) {
      const dir = assertInside(artifactRoot, join(artifactRoot, input.profileId, input.sessionId))
      mkdirSync(dir, { recursive: true })
      const artifactId = 'art_' + randomUUID()
      const file = join(dir, artifactId)
      writeFileSync(file, input.bytes)
      return {
        artifactId,
        byteLength: input.bytes.byteLength,
        sha256: createHash('sha256').update(input.bytes).digest('hex')
      }
    }
  }
}

export function createFilesystemJournalPort(browserRoot: string): BrowserJournalPort {
  if (!isAbsolute(browserRoot)) throw new Error('browserRoot must be absolute')
  return {
    append(record) {
      const file = assertInside(browserRoot, join(browserRoot, 'journals', record.profileId, `${record.sessionId}.broker.jsonl`))
      mkdirSync(dirname(file), { recursive: true })
      appendFileSync(file, JSON.stringify(record) + '\n')
    }
  }
}
