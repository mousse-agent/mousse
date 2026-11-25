import { vi } from 'vitest'
import type { TurnSink } from '../../src/mms/harness/adapter'
import { TranscriptAssembler, type TranscriptStreamState } from '../../src/mms/run/transcript/TranscriptAssembler'
import type { ChatMessage } from '../../src/shared/types'

/** A saved transcript row, as the thread keeps it: a reply's text, a thought's text, or a tool call. */
export interface SavedRow {
  kind: 'text' | 'thinking' | 'tool'
  content: string
}

/**
 * A turn sink whose text, thinking and tool events go through the run's transcript assembler, as a real turn's do:
 * `rows()` is what the thread saves (and shows again when reopened), in order. Every other sink call is a stub.
 */
export function transcriptSink(): { sink: TurnSink; messages: ChatMessage[]; rows: () => SavedRow[] } {
  const messages: ChatMessage[] = []
  const state: TranscriptStreamState = {
    activeAssistantMessageId: null,
    activeThinkingMessageId: null,
    activeToolCallMessageIds: new Map(),
    callToMessage: new Map(),
    lastCompletedAssistantMessageId: null,
    lastCompletedAssistantContent: ''
  }
  const assembler = new TranscriptAssembler({
    getMessage: (id) => messages.find((message) => message.id === id),
    addMessage: (message) => void messages.push(message),
    updateMessage: (message) => {
      const index = messages.findIndex((entry) => entry.id === message.id)
      if (index !== -1) messages[index] = message
    },
    removeMessage: (id) => {
      const index = messages.findIndex((entry) => entry.id === id)
      if (index !== -1) messages.splice(index, 1)
    },
    emitAdded: () => {},
    emitUpdated: () => {},
    persist: () => {},
    currentRunId: () => 'run-1',
    setPhase: () => {}
  }, state)
  const sink = {
    text: (event) => assembler.text(event),
    thinking: (event) => assembler.thinking(event),
    tool: (event) => assembler.tool(event),
    providerRef: vi.fn(),
    progress: vi.fn(),
    usage: vi.fn(),
    providerMetrics: vi.fn(),
    steerAccepted: vi.fn(),
    status: vi.fn(),
    retry: vi.fn(),
    compaction: vi.fn(),
    nativeMessages: vi.fn(),
    lineEdits: vi.fn()
  } as Partial<TurnSink> as TurnSink
  const rows = (): SavedRow[] => messages.map((message) =>
    message.kind === 'thinking'
      ? { kind: 'thinking', content: message.thinking?.content ?? '' }
      : message.role === 'assistant'
        ? { kind: 'text', content: message.content }
        : { kind: 'tool', content: message.toolCall?.title ?? '' })
  return { sink, messages, rows }
}
