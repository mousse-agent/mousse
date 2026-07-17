import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { AssistantMessage, Message, ToolResultMessage } from '@earendil-works/pi-ai'
import { ProjectManager } from '../src/mms/data/ProjectManager'
import { ThreadDataStore } from '../src/mms/data/ThreadDataStore'
import {
  compactNativeContext,
  createNativeContext,
  estimateMessagesTokens,
  getActiveMessages,
  migrateLegacyContext,
  shouldCompactNativeContext,
  userMessage
} from '../src/mms/orchestrator/nativeContext'

const usage = {
  input: 10, output: 5, cacheRead: 2, cacheWrite: 0, totalTokens: 17,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
}

function assistant(stopReason: AssistantMessage['stopReason'] = 'toolUse'): AssistantMessage {
  return {
    role: 'assistant', api: 'anthropic-messages', provider: 'anthropic', model: 'claude-test',
    content: [
      { type: 'thinking', thinking: 'native reasoning', thinkingSignature: 'signed-reasoning' },
      { type: 'toolCall', id: 'call-1', name: 'read_file', arguments: { path: 'a.ts' }, thoughtSignature: 'signed-call' }
    ], usage, stopReason, timestamp: 2
  }
}

const toolResult: ToolResultMessage = {
  role: 'toolResult', toolCallId: 'call-1', toolName: 'read_file',
  content: [{ type: 'text', text: 'file contents' }], details: { preserved: true },
  isError: false, timestamp: 3
}

describe('Pi-native thread context', () => {
  it('uses the Pi-recommended contextWindow minus 16,384 proactive threshold', () => {
    expect(shouldCompactNativeContext(111_616, 128_000)).toBe(false)
    expect(shouldCompactNativeContext(111_617, 128_000)).toBe(true)
  })
  it('retains native thinking, tool calls, tool results, provider identity, and aborted partials', () => {
    const aborted = { ...assistant('aborted'), content: [{ type: 'text' as const, text: 'partial' }] }
    const context = createNativeContext([userMessage('inspect'), assistant(), toolResult, aborted])
    const restored = JSON.parse(JSON.stringify(context)) as typeof context

    expect(restored.messages).toEqual(context.messages)
    expect((restored.messages[1] as AssistantMessage).content[0]).toMatchObject({
      type: 'thinking', thinkingSignature: 'signed-reasoning'
    })
    expect(restored.messages[2]).toEqual(toolResult)
    expect((restored.messages[3] as AssistantMessage).stopReason).toBe('aborted')
  })

  it('migrates only recoverable user/assistant text and images', () => {
    const migrated = migrateLegacyContext([
      { id: 'u', role: 'user', content: 'look', timestamp: new Date(1).toISOString(), images: [{ name: 'x', mimeType: 'image/png', data: 'BASE64' }] },
      { id: 't', role: 'assistant', kind: 'thinking', content: 'ui-only thought', timestamp: new Date(2).toISOString() },
      { id: 'tool', role: 'system', kind: 'build_tool_result', content: 'decorative card', timestamp: new Date(3).toISOString() },
      { id: 'a', role: 'assistant', content: 'answer', timestamp: new Date(4).toISOString() }
    ])

    expect(migrated.fidelity).toBe('legacy-estimated')
    expect(migrated.messages.map((message) => message.role)).toEqual(['user', 'assistant'])
    expect(migrated.messages.some((message) => message.role === 'toolResult')).toBe(false)
    expect(JSON.stringify(migrated)).not.toContain('ui-only thought')
    expect(JSON.stringify(migrated)).not.toContain('decorative card')
  })

  it('compacts active context without deleting the archive or splitting tool batches', () => {
    const messages: Message[] = [
      userMessage('old '.repeat(400)), assistant(), toolResult,
      userMessage('recent '.repeat(400)),
      { ...assistant('stop'), content: [{ type: 'text', text: 'final '.repeat(400) }], timestamp: 5 }
    ]
    const original = createNativeContext(messages)
    const compacted = compactNativeContext(original, 500)

    expect(compacted.messages).toEqual(messages)
    expect(compacted.activeStartIndex).toBeGreaterThan(0)
    expect(compacted.messages[compacted.activeStartIndex]?.role).not.toBe('toolResult')
    expect(getActiveMessages(compacted)[0]).toMatchObject({ role: 'user' })
    expect(compacted.compaction?.summary).toContain('Goal:')
    expect(estimateMessagesTokens(getActiveMessages(compacted))).toBeLessThan(estimateMessagesTokens(messages))
  })

  it('round-trips isolated native contexts through thread persistence', () => {
    const previousHome = process.env.MOUSSE_HOME
    const root = mkdtempSync(join(tmpdir(), 'mousse-native-context-'))
    process.env.MOUSSE_HOME = join(root, 'home')
    try {
      const projects = new ProjectManager()
      const store = new ThreadDataStore(projects)
      projects.setThreadStore(store)
      const one = store.createThread('one')
      const two = store.createThread('two')
      const firstContext = createNativeContext([userMessage('thread one'), assistant(), toolResult])
      const secondContext = createNativeContext([userMessage('thread two')])
      store.saveThreadData(one.id, { messages: [], agents: [], tasks: [], llmContext: firstContext })
      store.saveThreadData(two.id, { messages: [], agents: [], tasks: [], llmContext: secondContext })

      expect(store.loadThreadData(one.id).llmContext).toEqual(firstContext)
      expect(store.loadThreadData(two.id).llmContext).toEqual(secondContext)
    } finally {
      if (previousHome === undefined) delete process.env.MOUSSE_HOME
      else process.env.MOUSSE_HOME = previousHome
      rmSync(root, { recursive: true, force: true })
    }
  })
})
