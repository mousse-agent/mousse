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
import type { AgentActor } from '../../src/mms/run/types'
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
  const queueCommands: Array<{ threadId: string; command: AgentQueueCommand; options: { clientRequestId: string; actor: AgentActor } }> = []
  const host: AppToolHost = {
    delegation: vi.fn(() => delegation),
    askUser: vi.fn(async () => ({ q1: 'a' })),
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
    subagent: false,
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
export function appToolRegistry(engine: RunEngine, host: AppToolHost, extra: Pick<Parameters<typeof createAppToolRegistry>[0], 'bots' | 'botMemory' | 'options'> = {}) {
  const turns = new AppToolTurns()
  const { registry, families } = createAppToolRegistry({ host, engine, turns, ...extra })
  const request = (input: {
    threadId: string
    runId: string
    binding?: McpTurnBinding
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
      accessLevel: input.accessLevel ?? 'manage',
      binding: input.binding ?? 'drained_turn',
      current: input.current ?? (() => true)
    }
    return { credential, toolCallId: input.toolCallId ?? `mcp:${Math.random()}`, signal: input.signal ?? new AbortController().signal }
  }
  return { registry, families, turns, request }
}

/**
 * A refused call as tests read it (`refusal.ts`): `code` is the older code the refusal was thrown as (`data.reason`,
 * such as `mousse_conflict`) or else its code, `details` the fields kept beside it (`data`), `message` its words.
 * Undefined for a call that was not refused.
 */
export interface ReadRefusal {
  code: string
  message: string
  details: Record<string, unknown>
  refused: { code: string; message: string; retry: string; retryAfterSeconds?: number }
}

export function refusalOf(outcome: unknown): ReadRefusal | undefined {
  const { text, isError } = (outcome ?? {}) as { text?: unknown; isError?: unknown }
  if (isError !== true || typeof text !== 'string' || !text.startsWith('{"refused":')) return undefined
  const { refused, data = {} } = JSON.parse(text) as { refused: ReadRefusal['refused']; data?: Record<string, unknown> }
  return { code: typeof data.reason === 'string' ? data.reason : refused.code, message: refused.message, details: data, refused }
}

/** The refusal in a `tools/call` JSON-RPC response read over HTTP, or undefined when the call was not refused. */
export function refusalOfResponse(response: { result?: { content?: Array<{ text?: string }>; isError?: boolean } }): ReadRefusal | undefined {
  return refusalOf({ isError: response.result?.isError, text: response.result?.content?.[0]?.text })
}

/** The refusal a call came back with, or undefined when it was not refused. A thrown fault still rejects. */
export function denied(promise: Promise<unknown>): Promise<ReadRefusal | undefined> {
  return promise.then(refusalOf)
}
