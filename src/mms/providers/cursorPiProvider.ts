import {
  createProvider,
  envApiKeyAuth,
  type CredentialStore,
  type Model,
  type MutableModels,
  type ThinkingLevelMap
} from '@earendil-works/pi-ai'
import { discoverModels } from 'pi-cursor-sdk/src/model-discovery'
import {
  CURSOR_API_KEY_ENV_VAR,
  resolveCursorApiKey
} from 'pi-cursor-sdk/src/cursor-api-key'
import { streamCursorLazy } from 'pi-cursor-sdk/src/cursor-provider-lazy'
import { resetSessionCursorAgent } from 'pi-cursor-sdk/src/cursor-session-agent'
import { __testUtils as cursorSessionScope } from 'pi-cursor-sdk/src/cursor-session-scope'
import { applyProjectWorkingDirectory } from '../data/projectWorkingDirectory'
import { getCursorSdkStoreDir } from '../data/paths'

export const CURSOR_PROVIDER_ID = 'cursor'

let cursorSdkConfigured = false
let lastCursorSessionCwd: string | undefined
let lastCursorSessionKey: string | undefined

const CURSOR_BASE_URL = 'https://cursor.com'

interface CursorModelConfig {
  id: string
  name: string
  reasoning: boolean
  thinkingLevelMap?: ThinkingLevelMap
  input: readonly ('text' | 'image')[]
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number }
  contextWindow: number
  maxTokens: number
}

export function toCursorPiModels(configs: CursorModelConfig[]): Model<'cursor-sdk'>[] {
  return configs.map((config) => ({
    ...config,
    input: [...config.input],
    api: 'cursor-sdk',
    provider: CURSOR_PROVIDER_ID,
    baseUrl: CURSOR_BASE_URL
  }))
}

export async function setCursorSessionProjectScope(cwd: string, sessionKey?: string): Promise<void> {
  const resolvedCwd = applyProjectWorkingDirectory(cwd)
  if (lastCursorSessionCwd === resolvedCwd && lastCursorSessionKey === sessionKey) {
    return
  }

  if (lastCursorSessionCwd && lastCursorSessionCwd !== resolvedCwd) {
    await resetSessionCursorAgent()
  }

  lastCursorSessionCwd = resolvedCwd
  lastCursorSessionKey = sessionKey
  cursorSessionScope.set(resolvedCwd, undefined, sessionKey)
}

export async function ensureCursorSdkConfigured(): Promise<void> {
  if (cursorSdkConfigured) return

  const { Cursor, JsonlLocalAgentStore } = await import('@cursor/sdk')
  Cursor.configure({
    local: {
      store: new JsonlLocalAgentStore(getCursorSdkStoreDir())
    }
  })
  cursorSdkConfigured = true
}

async function readCursorApiKey(credentials: CredentialStore): Promise<string | undefined> {
  const stored = await credentials.read(CURSOR_PROVIDER_ID)
  if (stored?.type === 'api_key' && stored.key) {
    return resolveCursorApiKey(stored.key)
  }
  return resolveCursorApiKey(process.env[CURSOR_API_KEY_ENV_VAR])
}

async function discoverCursorModels(
  credentials: CredentialStore,
  forceRefresh?: boolean
): Promise<CursorModelConfig[]> {
  const apiKey = await readCursorApiKey(credentials)
  const previous = process.env[CURSOR_API_KEY_ENV_VAR]

  if (apiKey) {
    process.env[CURSOR_API_KEY_ENV_VAR] = apiKey
  }

  try {
    return await discoverModels({ forceRefresh })
  } finally {
    if (previous === undefined) {
      delete process.env[CURSOR_API_KEY_ENV_VAR]
    } else {
      process.env[CURSOR_API_KEY_ENV_VAR] = previous
    }
  }
}

export function createCursorPiProvider(
  credentials: CredentialStore,
  initialModels: CursorModelConfig[] = []
) {
  return createProvider({
    id: CURSOR_PROVIDER_ID,
    name: 'Cursor',
    baseUrl: CURSOR_BASE_URL,
    auth: {
      apiKey: envApiKeyAuth('Cursor SDK API key', [CURSOR_API_KEY_ENV_VAR])
    },
    models: toCursorPiModels(initialModels),
    fetchModels: async () => toCursorPiModels(await discoverCursorModels(credentials, true)),
    api: {
      stream: streamCursorLazy,
      streamSimple: streamCursorLazy
    }
  })
}

export async function registerCursorPiProvider(
  models: MutableModels,
  credentials: CredentialStore
): Promise<void> {
  await ensureCursorSdkConfigured()
  // Always force-refresh on register so newly published models (e.g. Opus 5)
  // are not hidden behind a stale 24h local model-list cache / old fallback snapshot.
  const configs = await discoverCursorModels(credentials, true)
  models.setProvider(createCursorPiProvider(credentials, configs))
}

export async function refreshCursorPiProvider(
  models: MutableModels,
  credentials: CredentialStore,
  forceRefresh = true
): Promise<void> {
  await ensureCursorSdkConfigured()
  const configs = await discoverCursorModels(credentials, forceRefresh)
  models.setProvider(createCursorPiProvider(credentials, configs))
}
