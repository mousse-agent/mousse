import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { rm } from 'node:fs/promises'
import type { AssistantMessage, Context } from '@earendil-works/pi-ai'
import { getDefaultSettings } from '../../../../src/shared/settings'
import { defaultAgentSettings } from '../../../../src/shared/agents/defaults'
import type { ResolvedAgentDefinition } from '../../../../src/shared/agents/types'
import { LlmClient } from '../../../../src/mms/orchestrator/LlmClient'

export const POLICY_TEMP_PREFIX = 'mousse-agent-runtime-policy-'

const ownedRoots: string[] = []

export function assertOwnedPolicyTempRoot(root: string): string {
  const resolvedRoot = resolve(root)
  const tmp = resolve(tmpdir())
  const rel = relative(tmp, resolvedRoot)
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`Refusing to mutate a path outside the process temp directory: ${resolvedRoot}`)
  }
  if (!basename(resolvedRoot).startsWith(POLICY_TEMP_PREFIX)) {
    throw new Error(`Refusing to mutate a temp path without the owned prefix: ${resolvedRoot}`)
  }
  return resolvedRoot
}

export function createPolicyTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), POLICY_TEMP_PREFIX))
  const owned = assertOwnedPolicyTempRoot(root)
  ownedRoots.push(owned)
  return owned
}

export async function removeOwnedPolicyTempRoots(): Promise<void> {
  while (ownedRoots.length) {
    const root = assertOwnedPolicyTempRoot(ownedRoots.pop()!)
    if (existsSync(root)) await rm(root, { recursive: true, force: true })
  }
}

export function resolvedDefinition(overrides: Partial<ResolvedAgentDefinition> = {}): ResolvedAgentDefinition {
  const settings = defaultAgentSettings({ name: 'Policy', slug: 'policy' })
  settings.primaryModel.ref = { providerId: 'fixture-provider', modelId: 'fixture-model' }
  settings.recovery.backoffMs = 0
  settings.recovery.retryCount = 0
  return {
    definitionId: 'def-policy',
    profileId: 'profile-1',
    revision: 'a'.repeat(64),
    visualRevision: 'b'.repeat(64),
    runtimeKind: 'mousse',
    settings,
    instructions: {
      applicationRules: 'Never disclose credentials.',
      profileProjectContext: 'Project context',
      definitionInstructions: 'You are a reviewer.',
      workflowNodeInstructions: 'Use the requested repository only.',
      task: 'Inspect the workspace.',
      compiled: 'unused'
    },
    model: {
      primary: {
        ref: settings.primaryModel.ref,
        available: true,
        efforts: [],
        speeds: [],
        contexts: [],
        capabilities: ['tools'],
        unavailableReasons: []
      },
      fallbacks: [],
      capabilityOverrides: {}
    },
    grants: {
      skills: [],
      mcpTools: [],
      builtinTools: [{ id: 'read', source: 'explicit' }],
      denied: []
    },
    dependencyHashes: {},
    visual: {},
    issues: [],
    ...overrides
  }
}

const emptyCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }

export function providerResponse(
  content: AssistantMessage['content'],
  stopReason: AssistantMessage['stopReason'],
  totalTokens = 4,
  costTotal = 0,
  extra: Partial<AssistantMessage> = {}
): AssistantMessage {
  return {
    role: 'assistant',
    api: 'anthropic-messages',
    provider: 'fixture-provider',
    model: 'fixture-model',
    content,
    stopReason,
    timestamp: Date.now(),
    usage: {
      input: totalTokens - 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens,
      cost: { ...emptyCost, total: costTotal }
    },
    ...extra
  } as AssistantMessage
}

export function streamOf(message: AssistantMessage) {
  return { async *[Symbol.asyncIterator]() {}, result: async () => message }
}

export function fixtureModel(provider: string, id: string) {
  return {
    id,
    name: id,
    api: 'anthropic-messages' as const,
    provider,
    baseUrl: '',
    reasoning: false,
    input: ['text'] as string[],
    cost: emptyCost,
    contextWindow: 128_000,
    maxTokens: 8_000
  }
}

export function nativeClient(outputs: AssistantMessage[], captured: Context[], options?: {
  getModel?: (provider: string, id: string) => object | undefined
  onStream?: (modelId: string, context: Context) => void
  streamSimple?: (model: { id: string }, context: Context) => unknown
}) {
  const settings = getDefaultSettings()
  settings.provider = { llmProvider: 'fixture-provider', model: 'fixture-model' }
  settings.integrations.skills.enabled = false
  const models = {
    getModel: (provider: string, id: string) => {
      if (options?.getModel) return options.getModel(provider, id) as never
      return fixtureModel(provider, id)
    },
    getAuth: async () => ({ apiKey: 'fixture' }),
    streamSimple: (model: { id: string }, context: Context) => {
      options?.onStream?.(model.id, context)
      captured.push(structuredClone(context))
      if (options?.streamSimple) return options.streamSimple(model, context)
      const next = outputs.shift()
      if (!next) throw new Error('fixture stream exhausted')
      return streamOf(next)
    }
  }
  return new LlmClient(
    { get: () => settings } as never,
    { has: () => true, credentials: { listProviderIds: () => ['fixture-provider'] }, models } as never
  )
}

export function grantTools(snapshot: ResolvedAgentDefinition, ids: string[]): void {
  snapshot.grants.builtinTools = ids.map((id) => ({ id, source: 'explicit' as const }))
}

export function createOutsideSecretLayout(insideRoot: string): { outsideRoot: string; secretPath: string; linkPath: string } {
  const ownedInside = assertOwnedPolicyTempRoot(insideRoot)
  const outsideRoot = mkdtempSync(join(tmpdir(), `${POLICY_TEMP_PREFIX}outside-`))
  ownedRoots.push(assertOwnedPolicyTempRoot(outsideRoot))
  const secretPath = join(outsideRoot, 'secret.txt')
  writeFileSync(secretPath, 'outside-secret-bytes', 'utf8')
  const linkPath = join(ownedInside, 'escape')
  mkdirSync(dirname(linkPath), { recursive: true })
  symlinkSync(outsideRoot, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
  if (!lstatSync(linkPath).isSymbolicLink() && process.platform === 'win32') {
    // Junctions report as directories; verify realpath escapes the inside root.
    const canonical = realpathSync(join(linkPath, 'secret.txt'))
    if (canonical.toLowerCase().startsWith(ownedInside.toLowerCase())) {
      throw new Error('Failed to create an escaping workspace link for the policy fixture.')
    }
  }
  return { outsideRoot, secretPath, linkPath }
}
