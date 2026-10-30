/**
 * The MCP relay's handler (SPEC §15.5, plan §3 and §4.8): what a thread lists, the refusals before
 * anything runs, the call-time check, who asks before a relayed tool runs, the ledger, the timeout
 * and how results and errors come back.
 */
import { describe, expect, it, vi } from 'vitest'
import { APPROVALS_REFUSED_MESSAGE } from '../../src/shared/harness/types'
import type { PermissionMode } from '../../src/shared/permissionMode'
import { RELAY_CALL_TIMEOUT_MS } from '../../src/mms/run/mcp/attachment'
import type { McpCallRequest } from '../../src/mms/run/mcp/appTools/registry'
import { McpToolError, type AppToolTurn } from '../../src/mms/run/mcp/appTools/types'
import type { CredentialRecord, RelayGrant } from '../../src/mms/run/mcp/McpCredentials'
import type { RelayCatalog } from '../../src/mms/run/mcp/relay/catalog'
import { RelayHandler, type RelayHost } from '../../src/mms/run/mcp/relay/handler'
import { RELAY_MAX_RESULT_CHARS, type RelayTool } from '../../src/mms/run/mcp/relay/names'
import { appTurn } from './appToolsFixture'

const say: RelayTool = {
  name: 'echo__say',
  description: '[MCP server "echo"] Says it',
  inputSchema: { type: 'object' },
  installationId: 'inst-echo',
  serverName: 'echo',
  toolName: 'say',
  providerName: 'mcp__echo__say__abcd1234',
  configRevision: 'rev1'
}

function setup(options: {
  relay?: RelayGrant | null
  turn?: Partial<AppToolTurn>
  readOnly?: boolean
  mode?: PermissionMode
  answer?: 'allow' | 'reject'
  callTool?: RelayHost['manager']['callTool']
  allowed?: { allowed: boolean; reason?: string }
} = {}) {
  const turn = { ...appTurn({ threadId: 't1', runId: 'r1', projectPath: '/p' }), turnToken: 'tt', ...options.turn } as AppToolTurn
  const ledger = { start: vi.fn(() => 'l1'), commit: vi.fn(), failed: vi.fn() }
  const catalog = {
    listing: vi.fn((projectPath?: string) => (projectPath === '/p' ? [say] : [])),
    resolve: vi.fn((projectPath: string | undefined, name: string) => (projectPath === '/p' && name === say.name ? say : undefined))
  }
  const manager = {
    isToolCallAllowed: vi.fn(async () => options.allowed ?? { allowed: true }),
    callTool: vi.fn(options.callTool ?? (async () => ({ content: [{ type: 'text' as const, text: 'said' }], isError: false }) as never))
  }
  const askApproval = vi.fn(async () => ({ permission: options.answer ?? 'allow' }))
  const admit = vi.fn(async (rawArgs: Record<string, unknown>) => {
    const { _mousse_turn: _token, ...args } = rawArgs
    return { threadId: 't1', active: 'r1', turn, args, caller: { threadId: 't1', runId: 'r1', provider: 'codex', modeCeiling: turn.modeCeiling, accessLevel: 'lineage' as const }, boundToken: 'tt' }
  })
  const handler = new RelayHandler({
    catalog: catalog as unknown as RelayCatalog,
    manager: manager as unknown as RelayHost['manager'],
    registry: { admit },
    projectPathFor: (threadId) => (threadId === 't1' ? '/p' : undefined),
    readOnlyThread: () => options.readOnly === true,
    permissionModeFor: () => options.mode ?? 'accept_edits',
    askApproval: askApproval as unknown as RelayHost['askApproval'],
    toolLedger: () => ledger as never
  })
  const relay = options.relay === null ? undefined : options.relay ?? { approvals: 'runtime' as const }
  const request: McpCallRequest = {
    credential: { threadId: 't1', runId: 'r1', provider: 'codex', modeCeiling: 'default', accessLevel: 'lineage', binding: 'per_call', ...(relay ? { relay } : {}), current: () => true },
    toolCallId: 'mcp:c1',
    signal: new AbortController().signal
  }
  const credential = { threadId: 't1', ...(relay ? { relay } : {}) } as CredentialRecord
  const call = (name = say.name, args: Record<string, unknown> = { text: 'hi', _mousse_turn: 'tt' }) => handler.call(name, args, request)
  return { handler, catalog, manager, askApproval, admit, ledger, request, credential, call }
}

const refusal = (code: string) => expect.objectContaining({ code }) as unknown as McpToolError

describe('RelayHandler.list', () => {
  it('lists the catalogue of the thread\'s project, names, descriptions and schemas only', () => {
    const { handler, credential } = setup()
    expect(handler.list(credential)).toEqual([{ name: say.name, description: say.description, inputSchema: say.inputSchema }])
  })

  it('lists nothing to a read-only child or a credential without a relay grant', () => {
    expect(setup({ readOnly: true }).handler.list(setup().credential)).toEqual([])
    const bare = setup({ relay: null })
    expect(bare.handler.list(bare.credential)).toEqual([])
  })
})

describe('RelayHandler.call', () => {
  it('runs an allowed tool under runtime approvals: admitted, re-checked, ledgered, with the relay timeout', async () => {
    const { call, manager, ledger, askApproval, admit } = setup()
    const outcome = await call(say.name, { text: 'hi', clientRequestId: 'keep-me', _mousse_turn: 'tt' })
    expect(outcome).toEqual({ text: 'said' })
    expect(admit).toHaveBeenCalledTimes(1)
    expect(manager.isToolCallAllowed).toHaveBeenCalledWith(say.providerName, '/p', { kind: 'main' })
    // The server's own `clientRequestId` argument reaches it; the turn token does not.
    expect(manager.callTool).toHaveBeenCalledWith(say.providerName, { text: 'hi', clientRequestId: 'keep-me' }, '/p', expect.any(AbortSignal), { kind: 'main' }, undefined, { timeoutMs: RELAY_CALL_TIMEOUT_MS })
    expect(ledger.start).toHaveBeenCalledWith(expect.objectContaining({ id: 'mcp:c1', name: say.name }))
    expect(ledger.commit).toHaveBeenCalledWith('l1')
    expect(askApproval).not.toHaveBeenCalled()
  })

  it('a bot turn or a credential without a relay grant knows no relayed tool', async () => {
    await expect(setup({ turn: { bot: {} as never } }).call()).rejects.toEqual(refusal('mousse_unknown_tool'))
    await expect(setup({ relay: null }).call()).rejects.toEqual(refusal('mousse_unknown_tool'))
  })

  it('refuses a definition run, a read-only child and a plan ceiling before anything runs or asks', async () => {
    for (const [options, code] of [
      [{ turn: { definition: {} as never } }, 'mousse_scope_denied'],
      [{ readOnly: true }, 'mousse_read_only'],
      [{ turn: { modeCeiling: 'plan' as const }, relay: { approvals: 'mousse' as const } }, 'mousse_ceiling_exceeded']
    ] as const) {
      const fx = setup(options)
      await expect(fx.call()).rejects.toEqual(refusal(code))
      expect(fx.manager.callTool).not.toHaveBeenCalled()
      expect(fx.askApproval).not.toHaveBeenCalled()
      expect(fx.ledger.start).not.toHaveBeenCalled()
    }
  })

  it('a name the catalogue cannot resolve is unknown', async () => {
    await expect(setup().call('echo__nope')).rejects.toEqual(refusal('mousse_unknown_tool'))
  })

  it('a tool the manager no longer allows is an error result, run nowhere', async () => {
    const { call, manager, ledger } = setup({ allowed: { allowed: false, reason: 'MCP tool is not enabled for this actor.' } })
    expect(await call()).toEqual({ text: 'MCP tool is not enabled for this actor.', isError: true })
    expect(manager.callTool).not.toHaveBeenCalled()
    expect(ledger.start).not.toHaveBeenCalled()
  })

  it('under mousse approvals asks with the server\'s permission key, and runs once allowed', async () => {
    const { call, askApproval, manager } = setup({ relay: { approvals: 'mousse' } })
    expect(await call()).toEqual({ text: 'said' })
    expect(askApproval).toHaveBeenCalledTimes(1)
    const [threadId, questions, { approval }] = askApproval.mock.calls[0] as unknown as [string, Array<{ prompt: string }>, { approval: Record<string, unknown> }]
    expect(threadId).toBe('t1')
    expect(questions[0]!.prompt).toMatch(/^Allow echo \/ say \(MCP server relayed by Mousse\)\?/)
    expect(questions[0]!.prompt).toContain('"text": "hi"')
    expect(approval).toEqual({
      action: 'tool',
      permissionKey: 'relay:inst-echo',
      options: [{ id: 'allow', decision: 'allow', scope: 'once' }, { id: 'reject', decision: 'reject' }],
      tool: { name: 'echo/say', input: { text: 'hi' }, cwd: '/p' }
    })
    expect(manager.callTool).toHaveBeenCalledTimes(1)
  })

  it('a rejection runs nothing and writes no ledger row', async () => {
    const { call, manager, ledger } = setup({ relay: { approvals: 'mousse' }, answer: 'reject' })
    expect(await call()).toEqual({ text: 'The user did not approve echo/say, so it did not run. Do not retry it unless they ask.', isError: true })
    expect(manager.callTool).not.toHaveBeenCalled()
    expect(ledger.start).not.toHaveBeenCalled()
  })

  it('Full access runs unasked; a run nobody answers refuses instead of asking', async () => {
    const full = setup({ relay: { approvals: 'mousse' }, mode: 'full' })
    expect(await full.call()).toEqual({ text: 'said' })
    expect(full.askApproval).not.toHaveBeenCalled()
    const never = setup({ relay: { approvals: 'mousse' }, turn: { approvals: 'never' } })
    expect(await never.call()).toEqual({ text: APPROVALS_REFUSED_MESSAGE, isError: true })
    expect(never.askApproval).not.toHaveBeenCalled()
    expect(never.manager.callTool).not.toHaveBeenCalled()
    // Runtime approvals: the runtime asked already, so a run nobody answers is not refused here.
    const runtime = setup({ turn: { approvals: 'never' } })
    expect(await runtime.call()).toEqual({ text: 'said' })
  })

  it('an error comes back redacted and cut, and fails the ledger row', async () => {
    const { call, ledger } = setup({ callTool: async () => { throw new Error(`failed with token=sk-ant-api03-abcdefghijklmnopqrstuvwxyz ${'x'.repeat(5_000)}`) } })
    const outcome = await call()
    expect(outcome.isError).toBe(true)
    expect(outcome.text).not.toContain('sk-ant-api03-abcdefghijklmnopqrstuvwxyz')
    expect(outcome.text.length).toBeLessThanOrEqual(2_000)
    expect(ledger.failed).toHaveBeenCalledWith('l1')
  })

  it('a long result is cut to the relay\'s limit', async () => {
    const { call } = setup({ callTool: async () => ({ content: [{ type: 'text', text: 'y'.repeat(RELAY_MAX_RESULT_CHARS + 10) }], isError: false }) as never })
    const outcome = await call()
    expect(outcome.text.startsWith('y'.repeat(RELAY_MAX_RESULT_CHARS))).toBe(true)
    expect(outcome.text).toMatch(/\[10 more characters were cut\]$/)
  })

  it('a call the registry does not admit reaches nothing', async () => {
    const { handler, request, manager, admit } = setup()
    admit.mockRejectedValueOnce(new McpToolError('mousse_caller_not_live', 'closed'))
    await expect(handler.call(say.name, {}, request)).rejects.toEqual(refusal('mousse_caller_not_live'))
    expect(manager.isToolCallAllowed).not.toHaveBeenCalled()
  })
})
