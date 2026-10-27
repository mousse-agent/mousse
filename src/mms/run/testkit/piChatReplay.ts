import type { Message, ToolCall } from '@earendil-works/pi-ai'
import type { LlmChatResult } from '../../orchestrator/LlmClient'
import type { StreamingLlmTextEvent, StreamingLlmThinkingEvent, StreamingLlmToolEvent } from '../../harness/turnEvents'
import { dispatchDelegationTool } from '../mcp/appTools/delegation'
import type { PiChatClient } from '../adapters/pi/PiLoopAdapter'
import { DEFAULT_VOLATILE_KEYS, dropKeys, ReplayMismatchError, type ReplayTransport } from './ReplayTransport'

/**
 * Pi-loop boundary: one `LlmClient.chat` call (SPEC §13.6). The loop's provider streams sit below
 * this call, so the transcript records the call and the callbacks it made instead:
 *
 * - out `{ kind: 'chat', messages, options }`: the transcript sent (role and content only) and the
 *   options that select the model and shape the prompt.
 * - in `{ kind: 'text' | 'thinking' | 'tool', event }`: a streaming callback.
 * - in `{ kind: 'progress' }`: `onProviderProgress`.
 * - in `{ kind: 'drainSteer' }`: the loop drains steer; the replay sends out
 *   `{ kind: 'steer', text }` with what it got (null for none).
 * - in `{ kind: 'nativeMessages', append }`: the loop appended to its transcript and checkpointed.
 * - in `{ kind: 'result', result, append? }`: the chat result; `nativeMessages` is the live
 *   transcript plus `append` (usually the assistant reply).
 * - in `{ kind: 'error', error: { message, code? } }`: the call throws.
 * - in `{ kind: 'hostTool', name, toolCallId, arguments }`: the loop calls a Mousse delegation tool
 *   on the turn's `ToolHost` (SPEC §14.2); the replay sends out `{ kind: 'hostToolResult', name,
 *   result }` with the result minus ids minted at run time (`VOLATILE_RESULT_KEYS`). A string
 *   argument `$delegationId` stands for the last delegation id a tool returned in this replay.
 */
export const PI_CHAT_BOUNDARY = 'LlmClient.chat call: request projection out; callbacks and result in'

type PiInbound =
  | { kind: 'text'; event: StreamingLlmTextEvent }
  | { kind: 'thinking'; event: StreamingLlmThinkingEvent }
  | { kind: 'tool'; event: StreamingLlmToolEvent }
  | { kind: 'progress' }
  | { kind: 'drainSteer' }
  | { kind: 'nativeMessages'; append: Array<Partial<Message>> }
  | { kind: 'result'; result: Omit<LlmChatResult, 'nativeMessages'>; append?: Array<Partial<Message>> }
  | { kind: 'error'; error: { message: string; code?: string } }
  | { kind: 'hostTool'; name: string; toolCallId: string; arguments: Record<string, unknown> }

/** Result fields minted per run (random thread and delegation ids, timestamps). */
export const VOLATILE_RESULT_KEYS = ['delegationId', 'childThreadId', 'childRunId', 'createdAt', 'integrationRunId']

function project(message: Message): { role: string; content: unknown } {
  return { role: message.role, content: message.content }
}

function hydrate(messages: Array<Partial<Message>> | undefined): Message[] {
  return (messages ?? []).map((message) => ({ timestamp: Date.now(), ...message }) as Message)
}

function delegationToolCall(name: string, toolCallId: string, args: Record<string, unknown>): ToolCall {
  return { type: 'toolCall', id: toolCallId, name, arguments: args }
}

export function replayPiChat(transport: ReplayTransport): PiChatClient {
  let lastDelegationId: string | undefined
  const bind = (args: Record<string, unknown>): Record<string, unknown> =>
    Object.fromEntries(Object.entries(args).map(([key, value]) => [key, value === '$delegationId' ? lastDelegationId : value]))
  const volatile = dropKeys([...VOLATILE_RESULT_KEYS, ...DEFAULT_VOLATILE_KEYS])
  return {
    chat: async (messages, onToolEvent, options = {}, onThinkingEvent, onTextEvent) => {
      // Turns of different threads (a parent and its delegated child) may call concurrently.
      await transport.sendInOrder({
        kind: 'chat',
        messages: messages.map(project),
        options: {
          mode: options.mode,
          llmProvider: options.llmProvider,
          model: options.model,
          contextSummary: options.contextSummary,
          appletInstructions: options.appletInstructions
        }
      })
      let live = [...messages]
      for (;;) {
        const frame = (await transport.receive()) as PiInbound | undefined
        if (!frame) throw new ReplayMismatchError('Transcript ended before the chat result')
        switch (frame.kind) {
          case 'text':
            onTextEvent?.(frame.event)
            break
          case 'thinking':
            onThinkingEvent?.(frame.event)
            break
          case 'tool':
            onToolEvent?.(frame.event)
            break
          case 'progress':
            options.onProviderProgress?.()
            break
          case 'drainSteer':
            transport.send({ kind: 'steer', text: options.drainSteer?.() ?? null })
            break
          case 'nativeMessages':
            live = [...live, ...hydrate(frame.append)]
            options.onNativeMessages?.(live)
            break
          case 'result':
            return { ...frame.result, nativeMessages: [...live, ...hydrate(frame.append)] }
          case 'error':
            throw Object.assign(new Error(frame.error.message), frame.error.code ? { code: frame.error.code } : {})
          case 'hostTool': {
            if (!options.delegation) throw new ReplayMismatchError(`The turn has no delegation host for ${frame.name}`)
            const result = await dispatchDelegationTool(options.delegation, delegationToolCall(frame.name, frame.toolCallId, bind(frame.arguments)))
            const id = (result as { delegationId?: unknown } | null)?.delegationId
            if (typeof id === 'string') lastDelegationId = id
            transport.send({ kind: 'hostToolResult', name: frame.name, result: volatile(result) })
            break
          }
          default:
            throw new ReplayMismatchError(`Unknown inbound frame ${JSON.stringify(frame)}`)
        }
      }
    }
  }
}
