import type { Message } from '@earendil-works/pi-ai'
import { join } from 'path'
import { homedir } from 'os'

export {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition
} from '../../../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/index.js'
export { readStoredCredential } from '../../../node_modules/@earendil-works/pi-coding-agent/dist/core/auth-storage.js'

export const CONFIG_DIR_NAME = '.pi'

export function convertToLlm(messages: Message[]): Message[] {
  return messages.filter(
    (message) =>
      message.role === 'user' || message.role === 'assistant' || message.role === 'toolResult'
  )
}

export function getAgentDir(): string {
  return join(homedir(), '.pi', 'agent')
}

export function getLanguageFromPath(_path: string): string | undefined {
  return undefined
}

export function highlightCode(code: string): string {
  return code
}

export function keyHint(_keys: string): string {
  return ''
}

export type ParsedArgs = {
  projectTrustOverride?: boolean
}

/**
 * Minimal CLI parser used by pi-cursor-sdk while this package is bundled for
 * Electron. Keep this limited to the trust flags consumed by the SDK so the
 * shim does not pull the full pi-coding-agent runtime into the main process.
 */
export function parseArgs(args: string[]): ParsedArgs {
  let projectTrustOverride: boolean | undefined

  for (const arg of args) {
    if (arg === '--approve' || arg === '-a') {
      projectTrustOverride = true
    } else if (arg === '--no-approve' || arg === '-na') {
      projectTrustOverride = false
    }
  }

  return { projectTrustOverride }
}

export class AuthStorage {
  static create(): AuthStorage {
    return new AuthStorage()
  }

  async getApiKey(_providerId: string, _options?: { includeFallback?: boolean }): Promise<string | undefined> {
    return undefined
  }
}

export type ProviderModelConfig = {
  id: string
  name: string
  reasoning: boolean
  input: readonly ('text' | 'image')[]
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number }
  contextWindow: number
  maxTokens: number
  thinkingLevelMap?: Partial<Record<'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh', string | null>>
}

export type ExtensionAPI = Record<string, unknown>
export type ExtensionContext = Record<string, unknown>
export type ExtensionHandler<T = unknown> = (event: T, ctx: ExtensionContext) => unknown
export type SessionStartEvent = Record<string, unknown>
export type ToolDefinition = Record<string, unknown>
