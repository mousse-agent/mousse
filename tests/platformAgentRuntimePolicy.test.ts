import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@earendil-works/pi-ai'
import { AgentExecutionService } from '../src/mms/agentDefinitions/AgentExecutionService'
import { createNativeAgentRuntime } from '../src/mms/agentDefinitions/nativeRuntime'
import {
  createOutsideSecretLayout,
  createPolicyTempRoot,
  fixtureModel,
  grantTools,
  nativeClient,
  providerResponse,
  removeOwnedPolicyTempRoots,
  resolvedDefinition,
  streamOf
} from './fixtures/agent-platform/agent-runtime-policy/helpers'

afterEach(async () => {
  await removeOwnedPolicyTempRoots()
})

function runNative(
  snapshot: ReturnType<typeof resolvedDefinition>,
  outputs: Parameters<typeof nativeClient>[0],
  extra: {
    captured?: Context[]
    projectPath?: string
    host?: object
    context?: object
    budget?: object
    input?: string
    getModel?: (provider: string, id: string) => object | undefined
    onStream?: (modelId: string, context: Context) => void
    streamSimple?: (model: { id: string }, context: Context) => unknown
    signal?: AbortSignal
  } = {}
) {
  const captured = extra.captured ?? []
  const llm = nativeClient(outputs, captured, {
    getModel: extra.getModel,
    onStream: extra.onStream,
    streamSimple: extra.streamSimple
  })
  const service = new AgentExecutionService({ native: createNativeAgentRuntime(llm) })
  return {
    captured,
    pending: service.run({
      profileId: 'profile-1',
      resolved: snapshot,
      threadId: 'thread-1',
      projectPath: extra.projectPath,
      input: extra.input ?? 'inspect',
      host: extra.host as never,
      context: extra.context as never,
      budget: extra.budget as never,
      signal: extra.signal
    })
  }
}

describe('native agent runtime policy', () => {
  it('does not reject harmless default display preferences and default disabled features', async () => {
    const snapshot = resolvedDefinition()
    snapshot.settings.output.language = 'English'
    snapshot.settings.output.tone = 'calm'
    snapshot.settings.output.verbosity = 'concise'
    const run = async () => ({ text: 'ok', usage: { totalTokens: 1 }, history: [] })
    const result = await new AgentExecutionService({ native: { run } }).run({
      profileId: 'profile-1',
      resolved: snapshot,
      threadId: 'thread-1',
      input: 'hello'
    })
    expect(result.status).toBe('completed')
    expect(result.error).toBeUndefined()
  })

  it('returns structured SETTINGS_UNSUPPORTED with exact setting paths for unimplemented features', async () => {
    const snapshot = resolvedDefinition()
    snapshot.settings.browser.mode = 'structured'
    snapshot.settings.delegation.maxDepth = 2
    snapshot.settings.script.enabled = true
    snapshot.settings.script.executionMode = 'sandboxed'
    const service = new AgentExecutionService({ native: { run: async () => ({ text: 'nope' }) } })
    await expect(service.run({
      profileId: 'profile-1',
      resolved: snapshot,
      threadId: 'thread-1',
      input: 'run'
    })).rejects.toMatchObject({
      code: 'SETTINGS_UNSUPPORTED',
      details: {
        pointers: expect.arrayContaining([
          '/settings/browser/mode',
          '/settings/delegation/maxDepth',
          '/settings/script/executionMode'
        ])
      }
    })
  })

  it('accepts structured browser mode when a BrowserRuntimePort is injected and still rejects unimplemented neighbors', async () => {
    const snapshot = resolvedDefinition()
    snapshot.settings.browser.mode = 'structured'
    snapshot.settings.delegation.maxDepth = 2
    const port = {
      resolveTarget: () => ({ backend: 'electron-attached' as const, uiTabId: 'tab-1' }),
      dispatch: async () => ({})
    }
    const service = new AgentExecutionService({ native: { run: async () => ({ text: 'nope' }) } })
    await expect(service.run({
      profileId: 'profile-1',
      resolved: snapshot,
      threadId: 'thread-1',
      input: 'run',
      host: { browserRuntime: port } as never
    })).rejects.toMatchObject({
      code: 'SETTINGS_UNSUPPORTED',
      details: {
        pointers: expect.arrayContaining(['/settings/delegation/maxDepth']),
        reasons: expect.not.objectContaining({ '/settings/browser/mode': expect.anything() })
      }
    })
    const nativeOnly = resolvedDefinition()
    nativeOnly.settings.browser.mode = 'native'
    await expect(service.run({
      profileId: 'profile-1',
      resolved: nativeOnly,
      threadId: 'thread-1',
      input: 'run',
      host: { browserRuntime: port } as never
    })).rejects.toMatchObject({
      code: 'SETTINGS_UNSUPPORTED',
      details: { pointers: expect.arrayContaining(['/settings/browser/mode']) }
    })
  })

  it('rejects non-finite and negative requested budgets and honors zero', async () => {
    const service = new AgentExecutionService({ native: { run: async () => ({ text: 'nope' }) } })
    await expect(service.run({
      profileId: 'profile-1',
      resolved: resolvedDefinition(),
      threadId: 'thread-1',
      input: 'run',
      budget: { maxTurns: Number.NaN }
    })).rejects.toMatchObject({ code: 'INVALID_BUNDLE', pointer: '/budget/maxTurns' })
    await expect(service.run({
      profileId: 'profile-1',
      resolved: resolvedDefinition(),
      threadId: 'thread-1',
      input: 'run',
      budget: { maxCostUsd: -1 }
    })).rejects.toMatchObject({ code: 'INVALID_BUNDLE', pointer: '/budget/maxCostUsd' })

    const snapshot = resolvedDefinition()
    grantTools(snapshot, ['read'])
    snapshot.settings.limits.maxToolCalls = 8
    const captured: Context[] = []
    const { pending } = runNative(snapshot, [
      providerResponse([{ type: 'toolCall', id: 'zero-1', name: 'read', arguments: { path: 'x' } }], 'toolUse')
    ], { captured, projectPath: createPolicyTempRoot(), budget: { maxToolCalls: 0 } })
    const result = await pending
    expect(result.status).toBe('failed')
    expect(result.error).toEqual(expect.objectContaining({ code: 'BUDGET_EXCEEDED' }))
    expect(JSON.stringify(result.history)).toContain('budget exhausted')
    expect(captured).toHaveLength(1)
  })

  it('rejects unrelated profile and thread snapshots before dispatch', async () => {
    const service = new AgentExecutionService({ native: { run: async () => ({ text: 'nope' }) } })
    await expect(service.run({
      profileId: 'profile-1',
      resolved: resolvedDefinition(),
      threadId: 'thread-1',
      input: 'run',
      context: { profileId: 'profile-other', threadId: 'thread-1' }
    })).rejects.toMatchObject({ code: 'PROFILE_MISMATCH' })
    await expect(service.run({
      profileId: 'profile-1',
      resolved: resolvedDefinition(),
      threadId: 'thread-1',
      input: 'run',
      context: { profileId: 'profile-1', threadId: 'thread-other' }
    })).rejects.toMatchObject({ code: 'PROFILE_MISMATCH' })
    await expect(service.run({
      profileId: 'profile-1',
      resolved: resolvedDefinition(),
      threadId: 'thread-1',
      input: 'run',
      context: { profileId: 'profile-1', threadId: 'thread-1', definitionId: 'definition-other' }
    })).rejects.toMatchObject({ code: 'PROFILE_MISMATCH' })
  })

  it('injects only configured selected files and excludes oversized thread history', async () => {
    const snapshot = resolvedDefinition()
    snapshot.settings.context.selectedFiles = ['allowed.txt']
    snapshot.settings.context.includeCurrentThread = true
    snapshot.settings.context.maxContextTokens = 64
    const captured: Context[] = []
    const { pending } = runNative(snapshot, [
      providerResponse([{ type: 'text', text: 'bounded' }], 'stop')
    ], {
      captured,
      context: {
        profileId: 'profile-1', threadId: 'thread-1', definitionId: snapshot.definitionId,
        selectedFiles: [
          { path: 'allowed.txt', content: 'allowed-bytes' },
          { path: 'secret.txt', content: 'secret-bytes' }
        ],
        history: [{ role: 'user', content: 'oversized '.repeat(200), at: '2026-01-01T00:00:00.000Z' }]
      }
    })
    await expect(pending).resolves.toMatchObject({ status: 'completed', text: 'bounded' })
    expect(captured[0]!.systemPrompt).toContain('allowed-bytes')
    expect(captured[0]!.systemPrompt).not.toContain('secret-bytes')
    expect(captured[0]!.messages).toEqual([expect.objectContaining({ role: 'user', content: 'inspect' })])
  })

  it('honors a zero turn budget before contacting a provider', async () => {
    const captured: Context[] = []
    const { pending } = runNative(resolvedDefinition(), [
      providerResponse([{ type: 'text', text: 'must-not-run' }], 'stop')
    ], { captured, budget: { maxTurns: 0 } })
    await expect(pending).resolves.toMatchObject({
      status: 'failed', error: { code: 'BUDGET_EXCEEDED', details: { limit: { kind: 'turns', limit: 0 } } }
    })
    expect(captured).toHaveLength(0)
  })

  it('includes host thread history only when includeCurrentThread is enabled', async () => {
    const history = [
      { role: 'user' as const, content: 'earlier question', at: '2026-01-01T00:00:00.000Z' },
      { role: 'assistant' as const, content: 'earlier answer', at: '2026-01-01T00:00:01.000Z' }
    ]
    const withHistory = resolvedDefinition()
    withHistory.settings.context.includeCurrentThread = true
    const capturedOn: Context[] = []
    const on = runNative(withHistory, [
      providerResponse([{ type: 'text', text: 'with-history' }], 'stop')
    ], {
      captured: capturedOn,
      projectPath: createPolicyTempRoot(),
      context: { profileId: 'profile-1', threadId: 'thread-1', history }
    })
    await expect(on.pending).resolves.toMatchObject({ status: 'completed', text: 'with-history' })
    expect(capturedOn[0]!.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'user'])
    expect(capturedOn[0]!.messages[0]).toEqual(expect.objectContaining({ content: 'earlier question' }))

    const withoutHistory = resolvedDefinition()
    withoutHistory.settings.context.includeCurrentThread = false
    const capturedOff: Context[] = []
    const off = runNative(withoutHistory, [
      providerResponse([{ type: 'text', text: 'no-history' }], 'stop')
    ], {
      captured: capturedOff,
      projectPath: createPolicyTempRoot(),
      context: { profileId: 'profile-1', threadId: 'thread-1', history }
    })
    await expect(off.pending).resolves.toMatchObject({ status: 'completed', text: 'no-history' })
    expect(capturedOff[0]!.messages).toEqual([
      expect.objectContaining({ role: 'user', content: 'inspect' })
    ])
  })

  it('blocks writes and shell at dispatch in a read-only workspace', async () => {
    const root = createPolicyTempRoot()
    writeFileSync(join(root, 'keep.txt'), 'safe', 'utf8')
    const snapshot = resolvedDefinition()
    snapshot.settings.workspace.mode = 'read_only'
    snapshot.settings.script.enabled = true
    snapshot.settings.script.executionMode = 'workspace'
    snapshot.settings.script.allowFilesystem = true
    grantTools(snapshot, ['read', 'write', 'bash', 'read_file', 'write_file', 'run_command'])
    const captured: Context[] = []
    const { pending } = runNative(snapshot, [
      providerResponse([
        { type: 'toolCall', id: 'w1', name: 'write', arguments: { path: 'denied.txt', content: 'nope' } }
      ], 'toolUse'),
      providerResponse([
        { type: 'toolCall', id: 'b1', name: 'bash', arguments: { command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify("require('fs').writeFileSync('from-shell.txt','nope')")}` } }
      ], 'toolUse'),
      providerResponse([{ type: 'text', text: 'blocked' }], 'stop')
    ], {
      captured,
      projectPath: root,
      host: { workspaceRoots: [root] }
    })
    const result = await pending
    expect(result.status).toBe('completed')
    expect(result.text).toBe('blocked')
    expect(captured[0]!.tools?.map((tool) => tool.name)).toContain('read')
    expect(captured[0]!.tools?.map((tool) => tool.name)).not.toEqual(expect.arrayContaining(['write', 'bash']))
    expect(JSON.stringify(result.history)).toMatch(/read-only/i)
    expect(existsSync(join(root, 'denied.txt'))).toBe(false)
    expect(existsSync(join(root, 'from-shell.txt'))).toBe(false)
    expect(readFileSync(join(root, 'keep.txt'), 'utf8')).toBe('safe')
  })

  it('rejects path escape and symlink escape before writing outside allowed roots', async () => {
    const root = createPolicyTempRoot()
    const { secretPath, outsideRoot } = createOutsideSecretLayout(root)
    const outsideFile = join(outsideRoot, 'planted.txt')
    const snapshot = resolvedDefinition()
    snapshot.settings.script.enabled = true
    snapshot.settings.script.executionMode = 'workspace'
    snapshot.settings.script.allowFilesystem = true
    grantTools(snapshot, ['read', 'write'])
    const { pending } = runNative(snapshot, [
      providerResponse([
        { type: 'toolCall', id: 'esc-1', name: 'write', arguments: { path: join('..', 'planted.txt'), content: 'escaped' } }
      ], 'toolUse'),
      providerResponse([
        { type: 'toolCall', id: 'esc-2', name: 'read', arguments: { path: join('escape', 'secret.txt') } }
      ], 'toolUse'),
      providerResponse([{ type: 'text', text: 'contained' }], 'stop')
    ], {
      projectPath: root,
      host: { workspaceRoots: [root] }
    })
    const result = await pending
    expect(result.status).toBe('completed')
    expect(JSON.stringify(result.history)).toMatch(/escaped allowed workspace roots/i)
    expect(existsSync(outsideFile)).toBe(false)
    expect(readFileSync(secretPath, 'utf8')).toBe('outside-secret-bytes')
    expect(JSON.stringify(result.history)).not.toContain('outside-secret-bytes')
  })

  it('writes inside allowed roots when workspace and script policy permit it', async () => {
    const root = createPolicyTempRoot()
    const snapshot = resolvedDefinition()
    snapshot.settings.script.enabled = true
    snapshot.settings.script.executionMode = 'workspace'
    snapshot.settings.script.allowFilesystem = true
    grantTools(snapshot, ['write', 'bash'])
    const { pending } = runNative(snapshot, [
      providerResponse([
        { type: 'toolCall', id: 'ok-w', name: 'write', arguments: { path: 'inside.txt', content: 'from-write' } }
      ], 'toolUse'),
      providerResponse([
        {
          type: 'toolCall',
          id: 'ok-b',
          name: 'bash',
          arguments: {
            command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify("require('fs').writeFileSync('from-shell.txt','from-shell')")}`
          }
        }
      ], 'toolUse'),
      providerResponse([{ type: 'text', text: 'wrote' }], 'stop')
    ], {
      projectPath: root,
      host: { workspaceRoots: [root] }
    })
    const result = await pending
    expect(result.status).toBe('completed')
    expect(readFileSync(join(root, 'inside.txt'), 'utf8')).toBe('from-write')
    expect(readFileSync(join(root, 'from-shell.txt'), 'utf8')).toBe('from-shell')
  })

  it('denies, cancels, and rejects stale approvals before dispatch', async () => {
    const root = createPolicyTempRoot()
    const snapshot = resolvedDefinition()
    snapshot.settings.approval.policy = 'always'
    grantTools(snapshot, ['write'])

    const deniedFile = join(root, 'denied-approval.txt')
    const denied = runNative(snapshot, [
      providerResponse([{ type: 'toolCall', id: 'a1', name: 'write', arguments: { path: 'denied-approval.txt', content: 'x' } }], 'toolUse'),
      providerResponse([{ type: 'text', text: 'denied' }], 'stop')
    ], {
      projectPath: root,
      host: {
        workspaceRoots: [root],
        approveToolRequest: async () => ({ status: 'denied', reason: 'user denied' })
      }
    })
    await expect(denied.pending).resolves.toMatchObject({ status: 'completed', text: 'denied' })
    expect(existsSync(deniedFile)).toBe(false)

    const cancelledFile = join(root, 'cancelled-approval.txt')
    const cancelled = runNative(snapshot, [
      providerResponse([{ type: 'toolCall', id: 'a2', name: 'write', arguments: { path: 'cancelled-approval.txt', content: 'x' } }], 'toolUse'),
      providerResponse([{ type: 'text', text: 'cancelled' }], 'stop')
    ], {
      projectPath: root,
      host: {
        workspaceRoots: [root],
        approveToolRequest: async () => ({ status: 'cancelled', reason: 'user cancelled' })
      }
    })
    await expect(cancelled.pending).resolves.toMatchObject({ status: 'completed', text: 'cancelled' })
    expect(existsSync(cancelledFile)).toBe(false)

    const staleFile = join(root, 'stale-approval.txt')
    const stale = runNative(snapshot, [
      providerResponse([{ type: 'toolCall', id: 'a3', name: 'write', arguments: { path: 'stale-approval.txt', content: 'x' } }], 'toolUse'),
      providerResponse([{ type: 'text', text: 'stale' }], 'stop')
    ], {
      projectPath: root,
      host: {
        workspaceRoots: [root],
        approveToolRequest: async () => ({ status: 'approved', digest: 'not-the-request-digest' })
      }
    })
    const staleResult = await stale.pending
    expect(staleResult.status).toBe('completed')
    expect(JSON.stringify(staleResult.history)).toMatch(/stale/i)
    expect(existsSync(staleFile)).toBe(false)
  })

  it('cancels while a synchronous approval callback leaves a pending promise', async () => {
    const root = createPolicyTempRoot()
    const snapshot = resolvedDefinition()
    snapshot.settings.approval.policy = 'always'
    grantTools(snapshot, ['write'])
    const controller = new AbortController()
    const { pending } = runNative(snapshot, [
      providerResponse([{ type: 'toolCall', id: 'pending-approval', name: 'write', arguments: { path: 'never.txt', content: 'x' } }], 'toolUse'),
      providerResponse([{ type: 'text', text: 'cancelled' }], 'stop')
    ], {
      projectPath: root,
      signal: controller.signal,
      host: {
        workspaceRoots: [root],
        approveToolRequest: () => {
          controller.abort()
          return new Promise(() => undefined)
        }
      }
    })
    await expect(pending).resolves.toMatchObject({ status: 'cancelled' })
    expect(existsSync(join(root, 'never.txt'))).toBe(false)
  })

  it('falls back before tool effects and refuses fallback after a tool call', async () => {
    const root = createPolicyTempRoot()
    const before = resolvedDefinition()
    before.settings.primaryModel.ref = { providerId: 'fixture-provider', modelId: 'unavailable-model' }
    before.settings.fallbacks.enabled = true
    before.settings.fallbacks.allowHigherCost = true
    before.settings.fallbacks.models = [{ providerId: 'fixture-provider', modelId: 'fixture-model' }]
    before.settings.fallbacks.retryOn = ['unavailable']
    before.model.primary.ref = before.settings.primaryModel.ref
    before.model.fallbacks = [{
      ref: { providerId: 'fixture-provider', modelId: 'fixture-model' },
      available: true,
      efforts: [],
      speeds: [],
      contexts: [],
      capabilities: ['tools'],
      unavailableReasons: []
    }]
    grantTools(before, ['read'])
    const streamed: string[] = []
    const { pending } = runNative(before, [
      providerResponse([{ type: 'text', text: 'fallback-ok' }], 'stop')
    ], {
      projectPath: root,
      host: { workspaceRoots: [root] },
      getModel: (provider, id) => id === 'unavailable-model' ? undefined : fixtureModel(provider, id),
      onStream: (modelId) => streamed.push(modelId)
    })
    await expect(pending).resolves.toMatchObject({ status: 'completed', text: 'fallback-ok' })
    expect(streamed).toEqual(['fixture-model'])

    const after = resolvedDefinition()
    after.settings.fallbacks.enabled = true
    after.settings.fallbacks.allowHigherCost = true
    after.settings.fallbacks.models = [{ providerId: 'fixture-provider', modelId: 'fixture-fallback' }]
    after.settings.fallbacks.retryOn = ['unavailable']
    after.model.fallbacks = [{
      ref: { providerId: 'fixture-provider', modelId: 'fixture-fallback' },
      available: true, efforts: [], speeds: [], contexts: [], capabilities: ['tools'], unavailableReasons: []
    }]
    grantTools(after, ['write'])
    const afterModels: string[] = []
    let calls = 0
    const result = await runNative(after, [], {
      projectPath: root,
      host: { workspaceRoots: [root] },
      input: 'write then fail',
      onStream: (id) => afterModels.push(id),
      streamSimple: (model) => {
        calls += 1
        if (calls === 1) {
          return streamOf(providerResponse(
            [{ type: 'toolCall', id: 'fx-1', name: 'write', arguments: { path: 'effect.txt', content: 'effected' } }],
            'toolUse'
          ))
        }
        throw new Error('socket hang up')
      }
    }).pending
    expect(result.status).toBe('failed')
    expect(result.error?.code).toBe('RUNTIME_ERROR')
    expect(result.error?.message).toMatch(/socket hang up/)
    expect(afterModels.every((id) => id === 'fixture-model')).toBe(true)
    expect(afterModels).not.toContain('fixture-fallback')
    expect(calls).toBe(2)
    expect(readFileSync(join(root, 'effect.txt'), 'utf8')).toBe('effected')
  })

  it('keeps aggregate cost limits across a pre-effect fallback attempt', async () => {
    const root = createPolicyTempRoot()
    const snapshot = resolvedDefinition()
    snapshot.settings.limits.maxCostUsd = 0.05
    snapshot.settings.fallbacks.enabled = true
    snapshot.settings.fallbacks.allowHigherCost = true
    snapshot.settings.fallbacks.retryOn = ['unavailable']
    snapshot.settings.fallbacks.models = [{ providerId: 'fixture-provider', modelId: 'fixture-fallback' }]
    snapshot.model.fallbacks = [{
      ref: { providerId: 'fixture-provider', modelId: 'fixture-fallback' },
      available: true, efforts: [], speeds: [], contexts: [], capabilities: ['tools'], unavailableReasons: []
    }]
    grantTools(snapshot, ['read'])
    const modelsSeen: string[] = []
    const outputs = [
      providerResponse([{ type: 'text', text: '' }], 'stop', 4, 0.04, {
        errorMessage: 'Provider unavailable',
        stopReason: 'error'
      } as never),
      providerResponse([{ type: 'text', text: 'too expensive' }], 'stop', 4, 0.02)
    ]
    const llm = nativeClient(outputs, [], {
      onStream: (id) => modelsSeen.push(id),
      getModel: (provider, id) => fixtureModel(provider, id)
    })
    const result = await new AgentExecutionService({ native: createNativeAgentRuntime(llm) }).run({
      profileId: 'profile-1',
      resolved: snapshot,
      threadId: 'thread-1',
      projectPath: root,
      input: 'cost',
      host: { workspaceRoots: [root] }
    })
    expect(modelsSeen).toEqual(['fixture-model', 'fixture-fallback'])
    expect(result.status).toBe('failed')
    expect(result.error?.code).toBe('BUDGET_EXCEEDED')
    expect(result.usage.costUsd).toBeGreaterThan(0.05)
  })

  it('cancels fallback backoff and never dispatches the next provider', async () => {
    const snapshot = resolvedDefinition()
    snapshot.settings.fallbacks.enabled = true
    snapshot.settings.fallbacks.allowHigherCost = true
    snapshot.settings.fallbacks.retryOn = ['unavailable']
    snapshot.settings.fallbacks.models = [{ providerId: 'fixture-provider', modelId: 'fixture-fallback' }]
    snapshot.settings.recovery.backoffMs = 60_000
    snapshot.model.fallbacks = [{
      ref: { providerId: 'fixture-provider', modelId: 'fixture-fallback' },
      available: true, efforts: [], speeds: [], contexts: [], capabilities: [], unavailableReasons: []
    }]
    const controller = new AbortController()
    const modelsSeen: string[] = []
    const { pending } = runNative(snapshot, [], {
      signal: controller.signal,
      onStream: (modelId) => {
        modelsSeen.push(modelId)
        setTimeout(() => controller.abort(), 5)
      },
      streamSimple: () => {
        throw new Error('Provider unavailable')
      }
    })
    await expect(pending).resolves.toMatchObject({ status: 'cancelled' })
    expect(modelsSeen).toEqual(['fixture-model'])
  })
})

describe('runtime policy helpers', () => {
  it('canonicalizes built-in aliases and fails closed without host roots for filesystem tools', async () => {
    const { canonicalizeBuiltinToolName, prepareTrustedToolDispatch, compileRuntimePolicy } = await import(
      '../src/mms/agentDefinitions/runtimePolicy'
    )
    expect(canonicalizeBuiltinToolName('read_file')).toBe('read')
    expect(canonicalizeBuiltinToolName('write_file')).toBe('write')
    expect(canonicalizeBuiltinToolName('run_command')).toBe('bash')
    const snapshot = resolvedDefinition()
    const policy = compileRuntimePolicy({
      resolved: snapshot,
      runId: 'run',
      threadId: 'thread-1',
      source: 'editor'
    })
    expect(policy.workspace.canonicalRoots).toEqual([])
    expect(Object.isFrozen(policy)).toBe(true)
    expect(Object.isFrozen(policy.workspace)).toBe(true)
    expect(Object.isFrozen(policy.fallbacks.retryOn)).toBe(true)
    const denied = prepareTrustedToolDispatch({
      policy,
      grants: snapshot.grants,
      toolName: 'read_file',
      args: { path: 'x' },
      isMcp: false,
      projectPath: resolve('.')
    })
    expect(denied.allowed).toBe(false)
    expect(denied.message).toMatch(/canonical workspace roots/i)
  })

  it('fails closed when fallback cost ordering cannot be proven', async () => {
    const snapshot = resolvedDefinition()
    snapshot.settings.fallbacks.enabled = true
    snapshot.settings.fallbacks.models = [{ providerId: 'fixture-provider', modelId: 'fixture-fallback' }]
    snapshot.model.fallbacks = [{
      ref: { providerId: 'fixture-provider', modelId: 'fixture-fallback' },
      available: true, efforts: [], speeds: [], contexts: [], capabilities: [], unavailableReasons: []
    }]
    await expect(new AgentExecutionService({ native: { run: async () => ({ text: 'nope' }) } }).run({
      profileId: 'profile-1', resolved: snapshot, threadId: 'thread-1', input: 'run'
    })).rejects.toMatchObject({
      code: 'SETTINGS_UNSUPPORTED',
      details: { pointers: expect.arrayContaining(['/settings/fallbacks/allowHigherCost']) }
    })
  })
})
