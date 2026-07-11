import { existsSync } from 'fs'
import { readdir, readFile } from 'fs/promises'
import { join } from 'path'
import type { OAuthClientInformationMixed } from '@modelcontextprotocol/sdk/shared/auth.js'
import { getCursorGlobalStorageDir } from '../../data/paths'

interface CursorMcpOAuthAttempt {
  serverUrl?: string
  transportServerUrl?: string
  clientInformation?: OAuthClientInformationMixed
}

function normalizeMcpUrl(url: string | undefined): string | undefined {
  if (!url) return undefined
  try {
    const parsed = new URL(url)
    parsed.hash = ''
    return parsed.toString()
  } catch {
    return url.trim()
  }
}

async function readAttemptsFromDir(dir: string): Promise<CursorMcpOAuthAttempt[]> {
  if (!existsSync(dir)) return []

  const attempts: CursorMcpOAuthAttempt[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    try {
      const parsed = JSON.parse(await readFile(join(dir, entry.name), 'utf-8')) as CursorMcpOAuthAttempt
      attempts.push(parsed)
    } catch {
      // Ignore malformed attempt records.
    }
  }
  return attempts
}

export async function loadCursorMcpClientInformation(
  serverUrl: string
): Promise<OAuthClientInformationMixed | undefined> {
  const targetUrl = normalizeMcpUrl(serverUrl)
  if (!targetUrl) return undefined

  const storageDir = getCursorGlobalStorageDir()
  const attempts = [
    ...(await readAttemptsFromDir(join(storageDir, 'mcp-oauth-attempts'))),
    ...(await readAttemptsFromDir(join(storageDir, 'anysphere.cursor-mcp', 'mcp-oauth-attempts')))
  ]

  for (const attempt of attempts) {
    const attemptUrl = normalizeMcpUrl(attempt.transportServerUrl ?? attempt.serverUrl)
    if (attemptUrl !== targetUrl) continue
    if (attempt.clientInformation?.client_id) {
      return { ...attempt.clientInformation }
    }
  }

  return undefined
}
