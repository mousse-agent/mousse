import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  createProcessEnvSecretAdapter,
  type IntegrationSecretAdapter
} from '../integrations/secrets'
import { atomicWriteJsonSync } from '../data/AtomicFs'

/**
 * Profile-scoped secret resolver. New profiles never read arbitrary process.env.
 * Default may explicitly inherit a captured environment overlay for legacy imports.
 */
export function createProfileSecretAdapter(options: {
  profileRoot: string
  inheritProcessEnv: boolean
  environment?: NodeJS.ProcessEnv
}): IntegrationSecretAdapter {
  const filePath = join(options.profileRoot, 'secrets', 'refs.json')
  const inherit = options.inheritProcessEnv
    ? createProcessEnvSecretAdapter(options.environment ?? process.env)
    : createProcessEnvSecretAdapter({})

  const readFileSecrets = (): Record<string, string> => {
    if (!existsSync(filePath)) return {}
    try {
      const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as unknown
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
      const out: Record<string, string> = Object.create(null)
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof value === 'string') out[key] = value
      }
      return out
    } catch {
      return {}
    }
  }

  return {
    resolveEnv(value: string): string {
      return inherit.resolveEnv(value)
    },
    resolveSecretRef(ref: string): string | undefined {
      const fromFile = readFileSecrets()[ref]
      if (fromFile !== undefined) return fromFile
      return inherit.resolveSecretRef?.(ref)
    }
  }
}

export function writeProfileSecret(profileRoot: string, name: string, value: string): void {
  const dir = join(profileRoot, 'secrets')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const filePath = join(dir, 'refs.json')
  const current = existsSync(filePath)
    ? (JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, string>)
    : {}
  current[name] = value
  atomicWriteJsonSync(filePath, current, { mode: 0o600 })
}
