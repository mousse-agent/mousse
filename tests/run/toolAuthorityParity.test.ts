/**
 * What every kind of turn holds of every Mousse tool, pinned to a snapshot first taken before the authority compiler
 * (docs/plans/tool-api.md §4, PR 2a) and changed since only where §1.3 or §2.4 changes who holds a tool (PR 2b): the thread's list (`tools/list`), Pi's per-turn list and its user MCP tools, the
 * "usable now" line of the turn preamble, and what a call does before its handler (runs, asks first, or is refused with
 * which code and words). Each turn is registered as the daemon registers that kind of turn; every handler is a stub, so
 * only the gate is read. A change to this snapshot is a change to who holds a tool.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { DefinitionAuthority } from '../../src/mms/agentDefinitions/definitionGate'
import { createAgentToolAccess } from '../../src/mms/agents/WorkspaceAccessPolicy'
import { createBotAuthority } from '../../src/mms/bots/authority/botAuthority'
import { botManifestDigest, compileBotThread, type CompileInput } from '../../src/mms/bots/grants/compile'
import { OrchestratorService } from '../../src/mms/orchestrator/OrchestratorService'
import { AppToolTurns, createAppToolRegistry, type AppToolHost, type AppToolTurn, type BotAppToolDeps, type McpCallRequest, type McpTurnBinding, type UserMcpProxy } from '../../src/mms/run/mcp/appTools'
import type { McpToolDescriptor } from '../../src/shared/integrations'
import type { AgentRuntimePolicy } from '../../src/shared/agents/execution'
import type { PermissionMode } from '../../src/shared/permissionMode'
import { BOT_THREADS_PERMISSION, botStarterManifest } from '../../src/shared/bots/personal/manifest'
import type { ModeCeiling } from '../../src/mms/run/types'
import { appTurn, fakeAppToolHost, refusalOf } from './appToolsFixture'
import { delegationFixture } from './delegationFixture'

const THREAD = 'thread-a'
/** The threads the owner knows: the caller's, another shared one and a private one. */
const THREADS: Record<string, { localOnly?: boolean }> = { [THREAD]: {}, 'thread-b': {}, 'thread-private': { localOnly: true } }
const base = mkdtempSync(join(tmpdir(), 'mousse-authority-parity-'))
afterAll(() => rmSync(base, { recursive: true, force: true }))

/** A bot turn's authority, compiled as the bot engine compiles each lane. */
function botAuthority(role: 'activation' | 'subagent', botTools: CompileInput['botTools']) {
  const scratch = join(base, 'bots', 'scratch', `${role}-${Math.random().toString(36).slice(2)}`)
  const files = join(base, 'bots', 'files', 'alpha')
  mkdirSync(scratch, { recursive: true })
  mkdirSync(files, { recursive: true })
  const starter = botStarterManifest()
  const grant = {
    ...starter,
    tools: [...starter.tools, 'shell' as const],
    appTools: [...starter.appTools, BOT_THREADS_PERMISSION]
  }
  const compiled = compileBotThread({
    grant, digest: botManifestDigest(grant), thread: {}, scratch, profileHome: base, filesFolder: files,
    nativeNames: (tools) => ({ ok: true, names: [...tools] }), remaining: { deadlineMs: 600_000 }, botTools
  })
  if (!compiled.ok) throw new Error(compiled.error.message)
  return createBotAuthority({
    activationId: 'act-1', role, permissions: compiled.permissions, waiting: () => false,
    counters: { charge: () => ({ ok: true, count: 1 }) }, time: { deadline: () => 0, signal: new AbortController().signal }, spend: null
  })
}

const definitionPolicy: AgentRuntimePolicy = {
  profileId: 'default', threadId: THREAD, runId: 'r', definitionId: 'def-1', definitionRevision: 'rev-1', source: 'editor',
  workspace: { mode: 'thread_worktree', canonicalRoots: [process.cwd()] },
  script: { enabled: false, allowFilesystem: false, allowNetwork: false, executionMode: 'workspace', interpreters: [] },
  approval: { askUser: true, policy: 'inherit', unattendedBehavior: 'pause' },
  memoryScope: 'off', includeCurrentThread: false, includeProjectInstructions: false, attachmentPolicy: 'none',
  fallbacks: { enabled: false, retryOn: [], allowHigherCost: false, retryCount: 0, backoffMs: 0 },
  fallbackModels: []
}

const userMcpTool = (name: string): McpToolDescriptor => ({
  id: `srv:${name}`, serverId: 'srv', installationId: 'srv', serverName: 'Server', toolName: name, providerName: `srv__${name}`, description: name, inputSchema: { type: 'object' }
}) as McpToolDescriptor

/** One kind of turn as the daemon registers it, and what the thread's owner says about the thread. */
interface TurnKind {
  turn: Partial<AppToolTurn>
  /** The owner says a person started the run (`personHeld`); the registry adds that a subagent never holds `person`. */
  person?: boolean
  /** `subagent`: its lineage says it is a Mousse subagent; `liveCeiling`: what its ancestors' running turns narrow it to. */
  thread?: { readOnly?: boolean; ceiling?: ModeCeiling; botRole?: 'activation' | 'subagent'; subagent?: boolean; liveCeiling?: ModeCeiling }
  permissionMode?: PermissionMode
  credential?: { modeCeiling?: ModeCeiling; binding?: McpTurnBinding; provider?: string }
}

/** A turn's browser binding that allows the read tools and opening a page, on a model without vision. */
const BROWSER = { mode: 'structured', vision: false, execution: { threadId: THREAD }, policy: { allowedTools: ['browser_open', 'browser_observe', 'browser_screenshot', 'browser_tabs'] } } as unknown as AppToolTurn['browser']

const CHAT_BOT_TOOLS: CompileInput['botTools'] = {
  workWaiting: false, escalate: true, consult: false, memory: true, scheduled: false, frontDesk: true, watcherStart: true, threads: 'all', profiler: true,
  themes: true, owner: true, tasks: true, images: false, applets: true, subagents: false, questions: true, cards: true, bots: true
}
const JOB_BOT_TOOLS: CompileInput['botTools'] = {
  workWaiting: false, escalate: true, consult: false, memory: true, scheduled: true, frontDesk: false, watcherStart: false, threads: 'all', profiler: true,
  themes: true, owner: true, tasks: true, images: false, applets: true, subagents: true, questions: false, cards: true, bots: false
}
const SUBAGENT_BOT_TOOLS: CompileInput['botTools'] = { escalate: false, consult: false, subagent: true, threads: 'all', profiler: true, tasks: true }

const KINDS: Record<string, () => TurnKind> = {
  'person, Ask': () => ({ turn: {}, person: true, permissionMode: 'ask' }),
  'person, Full access': () => ({ turn: {}, person: true, permissionMode: 'full' }),
  'person, browser bound without vision': () => ({ turn: { browser: BROWSER }, person: true, permissionMode: 'ask' }),
  'plan turn': () => ({ turn: { mode: 'plan', modeFacts: { readOnly: true, agent: false, build: false }, modeCeiling: 'plan' }, person: true, permissionMode: 'ask', credential: { modeCeiling: 'plan' } }),
  'build-mode turn': () => ({ turn: { mode: 'build', modeFacts: { readOnly: false, agent: false, build: true } }, person: true, permissionMode: 'edit' }),
  // A subagent of a person's turn: the owner reads its run as the person's, and the registry still never lets `person` pass down.
  'delegated subagent': () => ({ turn: { subagent: true }, person: true, permissionMode: 'edit', thread: { ceiling: 'default', subagent: true } }),
  'subagent while its parent plans': () => ({ turn: { subagent: true }, person: true, permissionMode: 'edit', thread: { ceiling: 'default', subagent: true, liveCeiling: 'plan' } }),
  'read-only subagent': () => ({
    turn: { subagent: true, mode: 'plan', modeFacts: { readOnly: true, agent: false, build: false }, modeCeiling: 'plan', toolAccess: createAgentToolAccess({ version: 1, workspace: 'shared', access: 'read-only' }, process.cwd()) },
    permissionMode: 'ask', thread: { readOnly: true, ceiling: 'plan', subagent: true }, credential: { modeCeiling: 'plan' }
  }),
  'bot chat': () => ({ turn: { bot: botAuthority('activation', CHAT_BOT_TOOLS), approvals: 'never' }, permissionMode: 'ask', thread: { botRole: 'activation' } }),
  'bot chat, catalogue': () => ({ turn: { bot: botAuthority('activation', { ...CHAT_BOT_TOOLS, catalogue: 'use_tool' }), approvals: 'never' }, permissionMode: 'ask', thread: { botRole: 'activation' } }),
  'bot job or wake': () => ({ turn: { bot: botAuthority('activation', JOB_BOT_TOOLS), approvals: 'never' }, permissionMode: 'ask', thread: { botRole: 'activation' } }),
  'bot subagent': () => ({ turn: { bot: botAuthority('subagent', SUBAGENT_BOT_TOOLS), approvals: 'never' }, permissionMode: 'ask', thread: { botRole: 'subagent' } }),
  'definition run': () => ({
    turn: {
      definition: {
        policy: definitionPolicy,
        grants: { skills: [], mcpTools: [{ id: 'srv__read', source: 'definition' as never }], builtinTools: ['task_create', 'task_list', 'question_ask', 'thread_fork', 'thread_read', 'browser_open', 'theme_set'].map((id) => ({ id, source: 'definition' as never })), denied: [] },
        mcpTools: [userMcpTool('read')],
        approve: async () => ({ status: 'denied', reason: 'definition approval asked' })
      } as unknown as DefinitionAuthority,
      browser: BROWSER
    },
    permissionMode: 'ask'
  }),
  'scheduled or automation turn': () => ({ turn: { approvals: 'never' }, permissionMode: 'edit' }),
  'remote-started turn': () => ({ turn: {}, permissionMode: 'ask' }),
  'Pi turn': () => ({ turn: { attemptToken: 'attempt-1' }, person: true, permissionMode: 'ask', credential: { binding: 'per_call', provider: 'pi' } })
}

/** What one kind of turn holds of every tool. */
async function snapshotOf(kind: TurnKind) {
  const fx = delegationFixture({ profileHome: mkdtempSync(join(base, 'profile-')) })
  try {
    const run = await fx.runningRun(THREAD)
    const asked: string[] = []
    const fake = fakeAppToolHost({
      readOnlyThread: () => kind.thread?.readOnly === true,
      threadCeiling: () => kind.thread?.ceiling ?? 'default',
      botRole: () => kind.thread?.botRole,
      subagentThread: () => kind.thread?.subagent === true,
      liveCeiling: () => kind.thread?.liveCeiling,
      personHeld: () => kind.person === true,
      permissionModeFor: () => kind.permissionMode,
      askApproval: async (_threadId, _questions, { approval }) => {
        asked.push(`${approval.permissionKey}${approval.reason ? ' (Full access only)' : ''}`)
        return { permission: 'reject' }
      },
      threadMeta: (id) => (THREADS[id] ? ({ id, name: id, createdAt: '', updatedAt: '', ...THREADS[id] } as never) : undefined),
      listThreads: () => [],
      listProjects: () => [],
      browserRuntime: () => ({ resolveTarget: () => ({ backend: 'managed-chromium' }), dispatch: async () => ({}) }) as never,
      skills: () => ({}) as never,
      web: {} as never,
      quickActions: {} as never,
      monitors: () => ({}) as never,
      threadWakes: () => ({}) as never,
      secrets: () => ({}) as never,
      terminals: () => ({ list: () => [], output: () => undefined, mask: (text: string) => text }) as never,
      appearance: () => ({}) as never,
      goals: { working: () => true } as never
    } as Partial<AppToolHost>)
    const turns = new AppToolTurns()
    const deps = { host: { activationOf: () => ({ botId: 'b1', activationId: 'act-1', lane: 'run' }) }, activity: { onAppResult: vi.fn(), onAllowed: vi.fn(), drain: () => [] } } as unknown as BotAppToolDeps
    const userMcp: UserMcpProxy = {
      list: async () => [userMcpTool('read'), userMcpTool('write')],
      allowed: async () => ({ allowed: true }),
      call: async () => ({ content: [], text: 'ran' }) as never
    }
    const { registry } = createAppToolRegistry({
      host: fake.host, engine: fx.engine, turns, bots: () => deps, botMemory: () => undefined,
      options: { userMcp, botMcp: { call: async () => ({ text: 'ran' }) as never } }
    })
    const ran = new Set<string>()
    for (const tool of registry.list()) {
      ;(tool as { handler: unknown }).handler = async () => {
        ran.add(tool.name)
        return { text: 'ran' }
      }
    }
    const turn = turns.register(appTurn({ threadId: THREAD, runId: run.runId, turnToken: 'turn-1', ...kind.turn }) as AppToolTurn).turn
    const binding = kind.credential?.binding ?? 'drained_turn'
    const request = (): McpCallRequest => ({
      credential: {
        threadId: THREAD, runId: run.runId, provider: kind.credential?.provider ?? 'codex', modeCeiling: kind.credential?.modeCeiling ?? turn.modeCeiling,
        accessLevel: 'manage', binding, current: () => true
      },
      toolCallId: `mcp:call-${Math.random()}`,
      signal: new AbortController().signal
    })
    const tokens = binding === 'per_call' ? (turn.attemptToken ? { _mousse_attempt: turn.attemptToken } : { _mousse_turn: turn.turnToken }) : {}
    const words = (text: string) => text.split(run.runId).join('<run>')
    const dispatch: Record<string, string> = {}
    /**
     * Each tool called with no arguments, each of a tool's kinds (`thread_create subagent`), and each that takes
     * `threadId` with another thread and a private one.
     */
    const calls = registry.list().flatMap((tool) => [
      { key: tool.name, name: tool.name, args: {} },
      ...Object.keys(tool.kinds?.declarations ?? {}).map((kind) => ({ key: `${tool.name} ${kind}`, name: tool.name, args: { kind } })),
      ...(JSON.stringify(tool.inputSchema).includes('"threadId"')
        ? ['thread-b', 'thread-private'].map((threadId) => ({ key: `${tool.name} ${threadId}`, name: tool.name, args: { threadId } }))
        : [])
    ])
    for (const { key, name, args } of calls) {
      asked.length = 0
      ran.delete(name)
      let result: string
      try {
        const outcome = await registry.call(name, { ...args, ...tokens }, request())
        const refusal = refusalOf(outcome)
        if (asked.length) result = `ask_first: ${asked.join(', ')} -> ${refusal ? refusal.refused.code : 'ran'}`
        else if (ran.has(name)) result = 'held'
        else if (refusal) result = `lacks ${refusal.refused.code}${refusal.code !== refusal.refused.code ? ` (${refusal.code})` : ''}: ${words(refusal.message)}`
        else result = `other: ${words(outcome.text)}`
      } catch (error) {
        result = `fault: ${words(error instanceof Error ? error.message : String(error))}`
      }
      dispatch[key] = result
    }
    const usable = (OrchestratorService.prototype as unknown as { usableAppTools(this: unknown, turn: AppToolTurn): string[] }).usableAppTools
      .call({ mcpToolRegistry: () => registry }, turns.get(run.runId)!)
    return {
      listed: registry.listForThread(THREAD, 'default', run.runId).map((tool) => tool.name),
      pi: registry.listForTurn(THREAD, run.runId).map((tool) => `${tool.name}:${tool.class}`),
      userMcp: (await registry.userMcpForTurn(THREAD, run.runId)).map((tool) => tool.providerName),
      usable,
      dispatch
    }
  } finally {
    fx.dispose()
  }
}

describe('who holds each Mousse tool, by kind of turn', () => {
  it('matches the pinned table', async () => {
    const table: Record<string, Awaited<ReturnType<typeof snapshotOf>>> = {}
    for (const [name, kind] of Object.entries(KINDS)) table[name] = await snapshotOf(kind())
    await expect(`${JSON.stringify(table, null, 1)}\n`).toMatchFileSnapshot('./__snapshots__/toolAuthorityParity.json')
  }, 120_000)
})
