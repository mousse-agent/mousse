import type { Message } from '@earendil-works/pi-ai'
import type {
  LlmChatResult,
  StreamingLlmTextEvent,
  StreamingLlmThinkingEvent,
  StreamingLlmToolEvent
} from '../../orchestrator/LlmClient'
import type { PiChatClient } from '../adapters/pi/PiLoopAdapter'
import { ReplayMismatchError, type ReplayTransport } from './ReplayTransport'

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

function project(message: Message): { role: string; content: unknown } {
  return { role: message.role, content: message.content }
}

function hydrate(messages: Array<Partial<Message>> | undefined): Message[] {
  return (messages ?? []).map((message) => ({ timestamp: Date.now(), ...message }) as Message)
}

export function replayPiChat(transport: ReplayTransport): PiChatClient {
  return {
    chat: async (messages, onToolEvent, options = {}, onThinkingEvent, onTextEvent) => {
      transport.send({
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
          default:
            throw new ReplayMismatchError(`Unknown inbound frame ${JSON.stringify(frame)}`)
        }
      }
    }
  }
}
