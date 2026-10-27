import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { DefinitionAuthority } from '../../src/mms/agentDefinitions/definitionGate'
import { RunCounters, TurnBudget } from '../../src/mms/harness/budget'
import type { AgentRuntimePolicy, AgentRuntimeToolApprovalRequest } from '../../src/shared/agents/execution'
import type { EffectiveAgentGrants } from '../../src/shared/agents/types'
import { harness, script, setup } from './piRpcEngineFixture'

// PR 4 4b2: a definition's authority over Pi's built-in tools, at the gate (`/pi/gate`), on the real
// pinned Pi child. Every refusal is proven by the file system (a write that never happened, a read
// whose content never reached the model's tool result). Fake key, local mock only.

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function policy(project: string, overrides: { workspace?: Partial<AgentRuntimePolicy['workspace']>; script?: Partial<AgentRuntimePolicy['script']>; approval?: Partial<AgentRuntimePolicy['approval']>; source?: AgentRuntimePolicy['source'] } = {}): AgentRuntimePolicy {
  return {
    profileId: 'default', threadId: 't1', runId: 'r1', definitionId: 'def-1', definitionRevision: 'rev-1',
    source: overrides.source ?? 'editor',
    workspace: { mode: 'thread_worktree', canonicalRoots: [project], ...overrides.workspace },
    script: { enabled: false, allowFilesystem: false, allowNetwork: false, executionMode: 'workspace', interpreters: [], ...overrides.script },
    approval: { askUser: true, policy: 'inherit', unattendedBehavior: 'pause', ...overrides.approval },
    memoryScope: 'off', includeCurrentThread: false, includeProjectInstructions: false, attachmentPolicy: 'none',
    fallbacks: { enabled: false, retryOn: [], allowHigherCost: false, retryCount: 0, backoffMs: 0 },
    fallbackModels: []
  }
}

function grants(...tools: string[]): EffectiveAgentGrants {
  return { skills: [], mcpTools: [], builtinTools: tools.map((id) => ({ id, source: 'definition' as never })), denied: [] }
}

const ALL = ['read', 'write', 'edit', 'bash', 'ls', 'grep', 'find']

/** One turn whose model calls `calls` in order, under `definition`; returns the tool results. */
async function run(definition: (project: string) => DefinitionAuthority, calls: Array<{ name: string; args: Record<string, unknown> }>) {
  const { engine, recorder, project } = await setup(cleanups)
  recorder.respond(script([...calls.map((tool) => ({ tool })), { text: 'done' }]))
  const turn = harness(project, {}, { definition: definition(project) })
  const result = await engine.startTurn(turn.input, turn.sink, turn.ctl, turn.host)
  expect(result.text).toBe('done')
  const results = turn.events.filter((event) => event.kind === 'tool' && event.phase === 'complete')
  const starts = turn.events.filter((event) => event.kind === 'tool' && event.phase === 'start')
  return { project, results, starts }
}

const refused = (event: { summary?: unknown }) => event.summary === 'The tool returned an error.'

describe('a definition’s authority over Pi’s built-in tools (Pi RPC engine, real child)', () => {
  it('read-only denies write; scripts off deny bash; a tool outside the grants is refused', async () => {
    const readOnly = await run((project) => ({ policy: policy(project, { workspace: { mode: 'read_only' } }), grants: grants(...ALL) }), [
      { name: 'write', args: { path: 'blocked.txt', content: 'x' } }
    ])
    expect(existsSync(join(readOnly.project, 'blocked.txt'))).toBe(false)
    expect(readOnly.results.map(refused)).toEqual([true])
    expect(String(readOnly.results[0].response)).toContain('read-only')

    const noScripts = await run((project) => ({ policy: policy(project), grants: grants(...ALL) }), [
      { name: 'bash', args: { command: 'echo ran > ran.txt' } }
    ])
    expect(existsSync(join(noScripts.project, 'ran.txt'))).toBe(false)
    expect(String(noScripts.results[0].response)).toContain('Script execution is disabled')

    const notGranted = await run((project) => ({ policy: policy(project), grants: grants('read') }), [
      { name: 'write', args: { path: 'ungranted.txt', content: 'x' } }
    ])
    expect(existsSync(join(notGranted.project, 'ungranted.txt'))).toBe(false)
    expect(String(notGranted.results[0].response)).toContain('not granted')
  }, 120_000)

  it('a path outside the roots is denied in every form Pi would open, and a path inside runs', async () => {
    const { project, results } = await run((root) => {
      writeFileSync(join(root, '..', 'outside.txt'), 'outside-secret')
      writeFileSync(join(root, 'inside.txt'), 'inside-content')
      return { policy: policy(root), grants: grants(...ALL) }
    }, [
      { name: 'read', args: { path: '../outside.txt' } },
      { name: 'read', args: { path: '@../outside.txt' } },
      { name: 'write', args: { path: '../escaped.txt', content: 'x' } },
      { name: 'read', args: { path: '@inside.txt' } }
    ])
    expect(results.slice(0, 3).map(refused)).toEqual([true, true, true])
    for (const event of results) expect(String(event.response)).not.toContain('outside-secret')
    expect(existsSync(join(project, '..', 'escaped.txt'))).toBe(false)
    expect(refused(results[3])).toBe(false)
    expect(String(results[3].response)).toContain('inside-content')
  }, 90_000)

  it('unattended runs: deny, skip and fail refuse a write; pause asks the host', async () => {
    for (const approval of [{ policy: 'unattended_deny' as const }, { unattendedBehavior: 'skip' as const }, { unattendedBehavior: 'fail' as const }]) {
      const { project, results } = await run((root) => ({ policy: policy(root, { source: 'schedule', approval }), grants: grants(...ALL) }), [
        { name: 'write', args: { path: 'unattended.txt', content: 'x' } }
      ])
      expect(existsSync(join(project, 'unattended.txt')), JSON.stringify(approval)).toBe(false)
      expect(results.map(refused)).toEqual([true])
    }
    const asked: AgentRuntimeToolApprovalRequest[] = []
    const { project } = await run((root) => ({
      policy: policy(root, { source: 'schedule', approval: { unattendedBehavior: 'pause' } }),
      grants: grants(...ALL),
      approve: async (request) => (asked.push(request), { status: 'denied', reason: 'not now' })
    }), [{ name: 'write', args: { path: 'paused.txt', content: 'x' } }])
    expect(asked.map((request) => request.canonicalToolName)).toEqual(['write'])
    expect(existsSync(join(project, 'paused.txt'))).toBe(false)
  }, 180_000)

  it('approval: a stale digest is refused; an approved call runs exactly the approved arguments', async () => {
    const stale = await run((root) => ({
      policy: policy(root, { approval: { policy: 'always' } }),
      grants: grants(...ALL),
      approve: async () => ({ status: 'approved', digest: 'not-the-digest' })
    }), [{ name: 'write', args: { path: 'stale.txt', content: 'x' } }])
    expect(existsSync(join(stale.project, 'stale.txt'))).toBe(false)
    expect(String(stale.results[0].response)).toContain('stale')

    const approved: AgentRuntimeToolApprovalRequest[] = []
    const { project, starts } = await run((root) => ({
      policy: policy(root, { approval: { policy: 'always' } }),
      grants: grants(...ALL),
      approve: async (request) => (approved.push(request), { status: 'approved', digest: request.argumentDigest })
    }), [{ name: 'write', args: { path: '@approved.txt', content: 'exact content' } }])
    expect(approved).toHaveLength(1)
    // Approved on the path Pi opens, and run there with the approved content.
    expect(approved[0].arguments).toEqual({ path: join(project, 'approved.txt'), content: 'exact content' })
    expect(readFileSync(join(project, 'approved.txt'), 'utf8')).toBe('exact content')
    // Nothing else was written: the call ran once, on the approved path.
    expect(readdirSync(project)).toEqual(['approved.txt'])
    expect(starts).toHaveLength(1)
  }, 120_000)

  it('an app tool the definition refuses is refused at the gate and costs no tool call, as a refused built-in does', async () => {
    const { engine, recorder, project } = await setup(cleanups, {
      mousseTools: () => [{ name: 'create_task', description: 'Create a task', inputSchema: { type: 'object', properties: { description: { type: 'string' } } }, class: 'mutation' }]
    })
    recorder.respond(script([
      { tool: { name: 'create_task', args: { description: 'not granted' } } },
      { tool: { name: 'write', args: { path: 'granted.txt', content: 'ok' } } },
      { text: 'done' }
    ]))
    const counters = new RunCounters()
    const turn = harness(project, {}, {
      definition: { policy: policy(project), grants: grants('write') },
      budget: new TurnBudget({ maxToolCalls: 1 }, counters),
      // Nothing listens here: a refused call never reaches the Mousse MCP server.
      bridge: { mcp: { url: 'http://127.0.0.1:9/mcp', token: 'unused' }, turnToken: 'tt', sessionInstructions: '', turnPreamble: '', userMcp: 'proxy' }
    })
    const result = await engine.startTurn(turn.input, turn.sink, turn.ctl, turn.host)
    expect(result.text).toBe('done')
    const results = turn.events.filter((event) => event.kind === 'tool' && event.phase === 'complete')
    expect(String(results[0].response)).toContain('not granted')
    // The refused app tool cost nothing: the one allowed call was the granted write.
    expect(readFileSync(join(project, 'granted.txt'), 'utf8')).toBe('ok')
    expect(counters.toolCalls).toBe(1)
  }, 90_000)
})
