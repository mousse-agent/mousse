import { describe, expect, it } from 'vitest'
import type { DefinitionAuthority } from '../../src/mms/agentDefinitions/definitionGate'
import { createDefinitionBrowserBinding, snapshotBrowserExecutionBinding } from '../../src/mms/orchestrator/browser/binding'
import { browserTools } from '../../src/mms/run/mcp/appTools/browser'
import type { AppToolHost } from '../../src/mms/run/mcp/appTools/host'
import { ToolRegistry } from '../../src/mms/run/mcp/appTools/registry'
import { AppToolTurns } from '../../src/mms/run/mcp/appTools/turns'
import type { ToolLedger } from '../../src/mms/run/mcp/appTools/types'
import type { AgentRuntimePolicy, AgentRuntimeToolApprovalRequest } from '../../src/shared/agents/execution'
import type { BrowserRuntimePort } from '../../src/shared/browser/runtime'
import { appTurn } from './appToolsFixture'

// PR 4 4d: a definition's browser on a runtime with its own loop (Pi RPC) is Mousse's browser app
// tools over its MCP server. A definition's turn is sent them as the definition loop sends them (the
// turn's binding decides the schema and what is offered), and each call is held to the definition's
// grants and approvals, re-checks its run after the approval, and is in the run's tool ledger. The
// browser is a local stand-in: nothing loads a page.

const policy = (overrides: Partial<AgentRuntimePolicy['approval']> = {}): AgentRuntimePolicy => ({
  profileId: 'default', threadId: 't1', runId: 'definition-run', definitionId: 'def-1', definitionRevision: 'rev-1', source: 'editor',
  workspace: { mode: 'thread_worktree', canonicalRoots: [process.cwd()] },
  script: { enabled: false, allowFilesystem: false, allowNetwork: false, executionMode: 'workspace', interpreters: [] },
  approval: { askUser: true, policy: 'inherit', unattendedBehavior: 'pause', ...overrides },
  memoryScope: 'off', includeCurrentThread: false, includeProjectInstructions: false, attachmentPolicy: 'none',
  fallbacks: { enabled: false, retryOn: [], allowHigherCost: false, retryCount: 0, backoffMs: 0 },
  fallbackModels: []
})

const grants = (...tools: string[]) => ({ skills: [], mcpTools: [], builtinTools: tools.map((id) => ({ id, source: 'definition' as never })), denied: [] })

/** The binding `OrchestratorService.runAgentDefinition` creates for a definition run, with the model's vision. */
function binding(granted: string[], vision: boolean) {
  const created = createDefinitionBrowserBinding({
    request: { profileId: 'default', threadId: 't1', source: 'editor' } as never,
    runId: 'definition-run',
    resolved: { definitionId: 'def-1', revision: 'rev-1', settings: { browser: { mode: 'structured' }, limits: { maxToolCalls: 10, maxElapsedMs: 60_000 } }, grants: grants(...granted) } as never
  })!
  return snapshotBrowserExecutionBinding({ ...created, vision })
}

function world(options: { granted: string[]; vision?: boolean; approval?: Partial<AgentRuntimePolicy['approval']>; onApproval?: (state: { active: string | null }) => void }) {
  const state = { active: 'r1' as string | null }
  const dispatched: Array<{ name: string; args: unknown }> = []
  const runtime: BrowserRuntimePort = {
    resolveTarget: () => ({ backend: 'managed-chromium' }),
    dispatch: async (_context, name, args) => (dispatched.push({ name, args }), { observationId: 'obs-1' })
  }
  const asked: AgentRuntimeToolApprovalRequest[] = []
  const definition: DefinitionAuthority = {
    policy: policy(options.approval),
    grants: grants(...options.granted),
    approve: async (request) => {
      asked.push(request)
      options.onApproval?.(state)
      return { status: 'approved', digest: request.argumentDigest }
    }
  }
  const rows: Array<[string, string]> = []
  const ledger: ToolLedger = {
    start: (call) => (rows.push([call.name, 'started']), call.name),
    commit: (id) => { rows.push([id, 'committed']) },
    failed: (id) => { rows.push([id, 'failed']) }
  }
  const turns = new AppToolTurns()
  turns.register(appTurn({ threadId: 't1', runId: 'r1', turnToken: 'tt', definition, browser: binding(options.granted, options.vision ?? false) }))
  turns.register(appTurn({ threadId: 't2', runId: 'chat', turnToken: 'tc', browser: binding(options.granted, options.vision ?? false) }))
  const registry = new ToolRegistry({ activeRunId: (threadId) => (threadId === 't1' ? state.active : 'chat'), turns, toolLedger: () => ledger })
  for (const tool of browserTools({ browserRuntime: () => runtime } as unknown as AppToolHost)) registry.register(tool)
  const call = (name: string, args: Record<string, unknown>) => registry.call(name, args, {
    credential: { threadId: 't1', runId: 'r1', provider: 'pi', modeCeiling: 'default', accessLevel: 'lineage', binding: 'rotate', current: () => true },
    toolCallId: `call-${name}`,
    signal: new AbortController().signal
  })
  return { registry, call, dispatched, asked, rows, state }
}

const actTargets = (schema: unknown): string[] => [...new Set([...JSON.stringify(schema).matchAll(/"kind":\{[^}]*"const":"([a-z-]+)"/g)].map((match) => match[1]!))]

describe('the browser of a definition on a runtime with its own loop', () => {
  it('a definition turn is sent the browser tools its binding offers, with the schema the loop sends; a chat turn gets the stable listing', () => {
    const { registry } = world({ granted: ['browser_open', 'browser_act', 'browser_observe', 'browser_screenshot'] })
    const sent = registry.listForTurn('t1', 'r1')
    // Granted only, and no screenshot or image-point action for a model without vision.
    expect(sent.map((tool) => tool.name)).toEqual(['browser_open', 'browser_observe', 'browser_act'])
    expect(actTargets(sent.find((tool) => tool.name === 'browser_act')!.inputSchema)).toEqual(['ref'])
    expect(sent.find((tool) => tool.name === 'browser_observe')!.description).toContain('Do not request screenshots')
    // Another thread's chat turn, and a run that is no definition's, get the thread's listing.
    const listed = registry.listForThread('t2').map((tool) => tool.name)
    expect(registry.listForTurn('t2', 'chat').map((tool) => tool.name)).toEqual(listed)
    expect(listed).toContain('browser_screenshot')
    expect(registry.listForTurn('t1', undefined).map((tool) => tool.name)).toEqual(listed)
    // A definition's run id given for another thread is not its turn.
    expect(registry.listForTurn('t2', 'r1').map((tool) => tool.name)).toEqual(listed)
  })

  it('with a vision model the screenshot and image-point actions are sent, as on the loop', () => {
    const { registry } = world({ granted: ['browser_act', 'browser_screenshot'], vision: true })
    const sent = registry.listForTurn('t1', 'r1')
    expect(sent.map((tool) => tool.name)).toEqual(['browser_act', 'browser_screenshot'])
    expect(actTargets(sent[0]!.inputSchema)).toEqual(expect.arrayContaining(['ref', 'image-point']))
  })

  it('a granted call runs on the browser with the arguments approved, once, with a ledger row; an ungranted one never reaches it', async () => {
    const { call, dispatched, asked, rows } = world({ granted: ['browser_open'], approval: { policy: 'always' } })
    expect(await call('browser_open', { url: 'http://127.0.0.1:9/local' })).toMatchObject({ isError: false })
    expect(asked.map((request) => [request.toolName, request.arguments])).toEqual([['browser_open', { url: 'http://127.0.0.1:9/local' }]])
    expect(await call('browser_observe', { sessionId: 's' })).toMatchObject({ isError: true, text: expect.stringContaining('not granted') })
    expect(dispatched).toEqual([{ name: 'browser_open', args: { url: 'http://127.0.0.1:9/local' } }])
    expect(rows).toEqual([['browser_open', 'started'], ['browser_open', 'committed']])
  })

  it.each([
    ['the run ended', (state: { active: string | null }) => { state.active = null }],
    ['another run became active', (state: { active: string | null }) => { state.active = 'r2' }]
  ] as const)('a call whose run is no longer live after its approval (%s) never reaches the browser and leaves no ledger row', async (_what, change) => {
    const { call, dispatched, rows } = world({ granted: ['browser_open'], approval: { policy: 'always' }, onApproval: change })
    await expect(call('browser_open', { url: 'http://127.0.0.1:9/local' })).rejects.toMatchObject({ code: 'mousse_caller_not_live' })
    expect(dispatched).toEqual([])
    expect(rows).toEqual([])
  })
})
