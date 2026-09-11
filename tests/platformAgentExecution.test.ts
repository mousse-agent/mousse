import { describe, expect, it, vi } from 'vitest'
import { AgentDefinitionError } from '../src/shared/agents/errors'
import { defaultAgentSettings } from '../src/shared/agents/defaults'
import type { ResolvedAgentDefinition } from '../src/shared/agents/types'
import { AgentExecutionService } from '../src/mms/agentDefinitions/AgentExecutionService'
import { createCliProcessRuntime } from '../src/mms/agentDefinitions/cliRuntime'

function resolved(overrides: Partial<ResolvedAgentDefinition> = {}): ResolvedAgentDefinition {
  const settings = defaultAgentSettings({ name: 'Review', slug: 'review' })
  settings.primaryModel.ref = { providerId: 'fixture-provider', modelId: 'fixture-model' }
  return {
    definitionId: 'def-1',
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
      task: 'Review the changed files.',
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
      skills: [{ id: 'review', source: 'explicit', revision: 'r1' }],
      mcpTools: [{ id: 'docs/read', serverId: 'docs', toolName: 'read', source: 'explicit' }],
      builtinTools: [{ id: 'read', source: 'inherited' }],
      denied: []
    },
    dependencyHashes: {},
    visual: {},
    issues: [],
    ...overrides
  }
}

describe('AgentExecutionService', () => {
  it('keeps definition instructions in the system channel and forwards the immutable execution scope', async () => {
    const run = vi.fn(async (input) => ({ text: 'done', usage: { totalTokens: 7 }, history: [] }))
    const service = new AgentExecutionService({ native: { run } })
    const result = await service.run({
      profileId: 'profile-1',
      resolved: resolved(),
      threadId: 'thread-1',
      projectPath: 'C:/repo',
      input: 'Inspect src/app.ts',
      budget: { maxTurns: 2 }
    })

    expect(result.status).toBe('completed')
    expect(result.text).toBe('done')
    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      profileId: 'profile-1',
      threadId: 'thread-1',
      projectPath: 'C:/repo',
      userMessage: 'Inspect src/app.ts',
      systemPrompt: expect.stringContaining('You are a reviewer.'),
      grants: expect.objectContaining({ mcpTools: [expect.objectContaining({ id: 'docs/read' })] }),
      budget: expect.objectContaining({ maxTurns: 2 })
    }))
    const call = run.mock.calls[0]![0]
    expect(call.systemPrompt).not.toContain('Current task:')
    expect(call.userMessage).not.toContain('You are a reviewer.')
  })

  it('rejects cross-profile snapshots before invoking a runtime', async () => {
    const run = vi.fn()
    const service = new AgentExecutionService({ native: { run } })
    await expect(service.run({
      profileId: 'profile-other', resolved: resolved(), threadId: 'thread-1', input: 'run'
    })).rejects.toMatchObject({ code: 'PROFILE_MISMATCH' })
    expect(run).not.toHaveBeenCalled()
  })

  it('returns cancellation and truthful error state when an adapter is aborted', async () => {
    const controller = new AbortController()
    const run = vi.fn(async (input: { signal: AbortSignal }) => {
      await new Promise<void>((resolve, reject) => {
        input.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
      })
      return { text: 'unreachable' }
    })
    const service = new AgentExecutionService({ native: { run } })
    const pending = service.run({ profileId: 'profile-1', resolved: resolved(), threadId: 't', input: 'wait', signal: controller.signal })
    controller.abort()
    await expect(pending).resolves.toMatchObject({ status: 'cancelled', error: { code: 'ABORTED' } })
  })

  it('uses a real local CLI process with system/config data in the process envelope', async () => {
    const script = "let s=''; process.stdin.on('data',c=>s+=c); process.stdin.on('end',()=>process.stdout.write(JSON.stringify({system:process.env.MOUSSE_AGENT_SYSTEM_PROMPT,profile:process.env.MOUSSE_AGENT_PROFILE_ID,thread:process.env.MOUSSE_AGENT_THREAD_ID,input:s})))"
    const cli = createCliProcessRuntime({
      resolveInvocation: (input) => ({ command: process.execPath, args: ['-e', script], cwd: input.projectPath })
    })
    const service = new AgentExecutionService({ cli: { codex: cli } })
    const result = await service.run({
      profileId: 'profile-1', resolved: resolved({ runtimeKind: 'codex' }), threadId: 'thread-cli', projectPath: process.cwd(), input: 'fixture input'
    })
    expect(result.status).toBe('completed')
    expect(JSON.parse(result.text)).toEqual(expect.objectContaining({
      system: expect.stringContaining('You are a reviewer.'),
      profile: 'profile-1',
      thread: 'thread-cli',
      input: 'fixture input'
    }))
    expect(result.history[0]).toEqual(expect.objectContaining({ role: 'system', content: expect.stringContaining('You are a reviewer.') }))
    expect(result.history[1]).toEqual(expect.objectContaining({ role: 'user', content: 'fixture input' }))
  })
})
