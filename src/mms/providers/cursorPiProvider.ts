import {
  createProvider,
  envApiKeyAuth,
  type CredentialStore,
  type Model,
  type MutableModels,
  type ThinkingLevelMap
} from '@earendil-works/pi-ai'
import { __testUtils as cursorModelDiscovery } from 'pi-cursor-sdk/src/model-discovery'
import { fingerprintApiKey, loadAnyCachedModelCatalog, loadFreshCachedModels, saveModelListCache } from 'pi-cursor-sdk/src/model-list-cache'
import {
  CURSOR_API_KEY_ENV_VAR,
  resolveCursorApiKey
} from 'pi-cursor-sdk/src/cursor-api-key'
import { streamCursorLazy } from 'pi-cursor-sdk/src/cursor-provider-lazy'
import { resetSessionCursorAgent } from 'pi-cursor-sdk/src/cursor-session-agent'
import { __testUtils as cursorSessionScope } from 'pi-cursor-sdk/src/cursor-session-scope'
import { resolveProjectWorkingDirectory } from '../data/projectWorkingDirectory'
import { getCursorSdkStoreDir } from '../data/paths'

export const CURSOR_PROVIDER_ID = 'cursor'

let cursorSdkConfigured = false
let lastCursorSessionCwd: string | undefined
let lastCursorSessionKey: string | undefined

// The Cursor SDK keeps session scope in process-global state. Serialize a complete
// request (including its tool loop), rather than only the scope assignment.
let cursorRequestTail: Promise<void> = Promise.resolve()

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

export async function withCursorRequestScope<T>(
  cwd: string,
  sessionKey: string | undefined,
  signal: AbortSignal | undefined,
  request: () => Promise<T>
): Promise<T> {
  if (signal?.aborted) throw new Error('Cursor request aborted before it started.')

  let release!: () => void
  const previous = cursorRequestTail
  cursorRequestTail = new Promise<void>((resolve) => { release = resolve })

  try {
    await waitForCursorTurn(previous, signal)
    if (signal?.aborted) throw new Error('Cursor request aborted before it started.')
    await setCursorSessionProjectScope(cwd, sessionKey)
    return await request()
  } finally {
    release()
  }
}

function waitForCursorTurn(previous: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return previous
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new Error('Cursor request aborted while waiting for its turn.'))
    signal.addEventListener('abort', onAbort, { once: true })
    previous.then(
      () => { signal.removeEventListener('abort', onAbort); resolve() },
      () => { signal.removeEventListener('abort', onAbort); resolve() }
    )
  })
}

export async function setCursorSessionProjectScope(cwd: string, sessionKey?: string): Promise<void> {
  // Resolve only — never process.chdir (unsafe with concurrent thread turns).
  const resolvedCwd = resolveProjectWorkingDirectory(cwd)
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
  forceRefresh?: boolean,
  signal?: AbortSignal
): Promise<CursorModelConfig[]> {
  const apiKey = await readCursorApiKey(credentials)
  signal?.throwIfAborted()
  if (!apiKey) return restoreCursorModels(undefined, signal)
  const fingerprint = fingerprintApiKey(apiKey)
  const fresh = !forceRefresh ? loadFreshCachedModels(fingerprint) : undefined
  if (fresh?.length) return cursorModelDiscovery.registerModelItems(fresh)

  let items: import('@cursor/sdk').ModelListItem[]
  try {
    const { Cursor } = await import('@cursor/sdk')
    signal?.throwIfAborted()
    items = await Cursor.models.list({ apiKey })
  } catch {
    signal?.throwIfAborted()
    return restoreCursorModels(apiKey, signal)
  }
  // The SDK transport cannot be cancelled. Fence both its raw cache and the
  // process-wide selection metadata before accepting a late network response.
  signal?.throwIfAborted()
  if (items.length === 0) return restoreCursorModels(apiKey, signal)
  saveModelListCache(fingerprint, items)
  return cursorModelDiscovery.registerModelItems(items)
}

async function restoreCursorModels(apiKey?: string, signal?: AbortSignal): Promise<CursorModelConfig[]> {
  const cached = apiKey ? loadAnyCachedModelCatalog(fingerprintApiKey(apiKey)) : undefined
  const items = cached?.models.length
    ? cached.models
    : (await import('pi-cursor-sdk/src/cursor-fallback-models.generated')).FALLBACK_MODEL_ITEMS
  signal?.throwIfAborted()
  return cursorModelDiscovery.registerModelItems(items)
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
    fetchModels: async (context) => toCursorPiModels(await discoverCursorModels(credentials, true, context.signal)),
    api: {
      stream: streamCursorLazy,
      streamSimple: streamCursorLazy
    }
  })
}

export async function registerCursorPiProvider(
  models: MutableModels,
  credentials: CredentialStore,
  options: { allowNetwork?: boolean } = {}
): Promise<void> {
  await ensureCursorSdkConfigured()
  if (options.allowNetwork === false) {
    // Startup: Models.refresh({ allowNetwork: false }) restores the persisted
    // catalog. Restore raw SDK selection metadata for cached aliases/variants,
    // using only a cache that matches the current key; no discovery is needed.
    const apiKey = await readCursorApiKey(credentials)
    const configs = await restoreCursorModels(apiKey)
    models.setProvider(createCursorPiProvider(credentials, configs))
    return
  }
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
