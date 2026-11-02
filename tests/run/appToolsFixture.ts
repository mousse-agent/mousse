import { vi } from 'vitest'
import type { AgentAccessLevel } from '../../src/shared/settings'
import type { DelegationToolHost } from '../../src/mms/run/mcp/appTools/delegation'
import {
  AppToolTurns,
  createAppToolRegistry,
  type AgentQueueCommand,
  type AppToolHost,
  type AppToolTurn,
  type McpCallRequest,
  type McpCredentialAuthority,
  type McpTurnBinding
} from '../../src/mms/run/mcp/appTools'
import type { RunEngine } from '../../src/mms/run/RunEngine'
import type { AgentActor, ModeCeiling } from '../../src/mms/run/types'
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
    reportResult: vi.fn(() => ({ merged: false })),
    named: { create: vi.fn(), createBatch: vi.fn(), recall: vi.fn() }
  }
  const tasks = new TaskQueue()
  const enqueued: Array<{ threadId: string; input: unknown }> = []
  /** Every queue command the tools asked for, with who asked and under which request key. */
  const queueCommands: Array<{ threadId: string; command: AgentQueueCommand; options: { clientRequestId: string; actor: AgentActor; level: AgentAccessLevel } }> = []
  const host: AppToolHost = {
    delegation: vi.fn(() => delegation),
    askUser: vi.fn(async () => ({ q1: 'a' })),
    presentPlan: vi.fn(),
    tasks: () => tasks,
    queueSnapshot: () => ({ items: [], claimed: [], revision: 'rev-0', open: true }),
    queueCommand: (threadId, command, options) => {
      queueCommands.push({ threadId, command, options })
      if (command.op === 'enqueue') enqueued.push({ threadId, input: { content: command.content, mode: command.mode } })
      const itemId = 'itemId' in command ? command.itemId : 'item-1'
      return {
        outcome: command.op === 'enqueue' ? 'enqueued' : command.op === 'edit' ? 'edited' : command.op === 'remove' ? 'removed' : command.op === 'reorder' ? 'reordered' : 'promoted',
        itemId,
        revision: 'rev-1',
        replayed: false,
        effectsSettled: true,
        ...(command.op === 'enqueue' ? { item: { id: 'item-1', threadId, content: command.content, enqueuedAt: '2026-10-27T00:00:00.000Z', order: 0, intent: 'normal' as const, state: 'pending' as const } } : {})
      }
    },
    ...overrides
  }
  return { host, delegation, tasks, enqueued, queueCommands }
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
    /** The level the credential was granted; default `lineage`. */
    accessLevel?: AgentAccessLevel
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
      accessLevel: input.accessLevel ?? 'lineage',
      binding: input.binding ?? 'drained_turn',
      current: input.current ?? (() => true)
    }
    return { credential, toolCallId: input.toolCallId ?? `mcp:${Math.random()}`, signal: input.signal ?? new AbortController().signal }
  }
  return { registry, families, turns, request }
}
