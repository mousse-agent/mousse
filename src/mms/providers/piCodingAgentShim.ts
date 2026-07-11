import type { Message } from '@earendil-works/pi-ai'
import { join } from 'path'
import { homedir } from 'os'

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
