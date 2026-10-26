import { vi } from 'vitest'
import type { DelegationToolHost } from '../../src/mms/run/mcp/appTools/delegation'
import {
  AppToolTurns,
  createAppToolRegistry,
  type AppToolHost,
  type AppToolTurn,
  type McpCallRequest,
  type McpCredentialAuthority,
  type McpTurnBinding
} from '../../src/mms/run/mcp/appTools'
import type { RunEngine } from '../../src/mms/run/RunEngine'
import type { ModeCeiling } from '../../src/mms/run/types'
import { TaskQueue } from '../../src/mms/tasks/TaskQueue'

/** A fake thread owner for the app-tool registry, recording what each tool asked of it. */
export function fakeAppToolHost(overrides: Partial<AppToolHost> = {}) {
  const delegation: DelegationToolHost = {
    delegateTask: vi.fn(async (input) => ({ delegationId: 'd1', input })),
    continueSubagent: vi.fn(async (input) => ({ delegationId: 'd2', input })),
    answerSubagent: vi.fn((input) => ({ answered: true, input })),
    taskStatus: vi.fn(() => ({ status: 'running' })),
    taskCancel: vi.fn(async () => ({ cancelled: [] })),
    listDelegations: vi.fn(() => []),
    listSubagents: vi.fn(() => []),
    integrateDelegation: vi.fn(async () => ({ status: 'queued' })),
    named: { create: vi.fn(), createBatch: vi.fn(), recall: vi.fn(), integrate: vi.fn() }
  }
  const tasks = new TaskQueue()
  const enqueued: Array<{ threadId: string; input: unknown }> = []
  const host: AppToolHost = {
    delegation: vi.fn(() => delegation),
    askUser: vi.fn(async () => ({ q1: 'a' })),
    presentPlan: vi.fn(),
    tasks: () => tasks,
    listQueue: () => [],
    enqueue: (threadId, input) => {
      enqueued.push({ threadId, input })
      return { id: 'item-1' }
    },
    ...overrides
  }
  return { host, delegation, tasks, enqueued }
}

/** A turn as the `turn.start` executor registers it, for an agent-mode main thread. */
export function appTurn(overrides: Partial<AppToolTurn> & Pick<AppToolTurn, 'threadId' | 'runId'>): Omit<AppToolTurn, 'turnToken'> & { turnToken?: string } {
  return {
    mode: 'agent',
    modeFacts: { readOnly: false, agent: true, build: false },
    modeCeiling: 'default',
    subagent: false,
    discovery: false,
    actor: { kind: 'main' },
    enabledSkills: [],
    loadedSkills: [],
    settingsEnabled: () => true,
    ...overrides
  }
}

/**
 * The MCP server's registry over `engine`, with its turns: `turn` registers a turn for a run, and
 * `request` builds a call under a credential bound to a run.
 */
export function appToolRegistry(engine: RunEngine, host: AppToolHost) {
  const turns = new AppToolTurns()
  const { registry, families } = createAppToolRegistry({ host, engine, turns })
  const request = (input: {
    threadId: string
    runId: string
    binding?: McpTurnBinding
    modeCeiling?: ModeCeiling
    provider?: string
    current?: () => boolean
    toolCallId?: string
    signal?: AbortSignal
  }): McpCallRequest => {
    const credential: McpCredentialAuthority = {
      threadId: input.threadId,
      runId: input.runId,
      provider: input.provider ?? 'codex',
      modeCeiling: input.modeCeiling ?? 'default',
      binding: input.binding ?? 'drained_turn',
      current: input.current ?? (() => true)
    }
    return { credential, toolCallId: input.toolCallId ?? `mcp:${Math.random()}`, signal: input.signal ?? new AbortController().signal }
  }
  return { registry, families, turns, request }
}
