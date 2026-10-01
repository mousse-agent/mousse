import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { AssistantMessage, Message, ToolResultMessage } from '@earendil-works/pi-ai'
import { ProjectManager } from '../src/mms/data/ProjectManager'
import { ThreadDataStore } from '../src/mms/data/ThreadDataStore'
import {
  appendNativeMessage,
  compactMessagesAtSafeBoundary,
  compactNativeContext,
  commitNativeMessages,
  createNativeContext,
  estimateActiveContextTokens,
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
  it('compacts for output headroom or the exact 95% audited context threshold', () => {
    // Output headroom wins before the 95% watermark on large contexts.
    expect(shouldCompactNativeContext(111_615, 128_000)).toBe(false)
    expect(shouldCompactNativeContext(111_616, 128_000)).toBe(true)
    expect(shouldCompactNativeContext(94, 100)).toBe(false)
    expect(shouldCompactNativeContext(95, 100)).toBe(true)
  })

  it('does not reuse pre-compaction provider usage for the retained transcript', () => {
    const summary: Message = {
      role: 'user',
      content: '[Compacted conversation summary]\nShort summary',
      timestamp: 100
    }
    const retainedAssistant: AssistantMessage = {
      ...assistant('stop'),
      content: [{ type: 'text', text: 'retained answer' }],
      usage: { ...usage, input: 95_000, totalTokens: 95_005 },
      timestamp: 50
    }
    const messages = [summary, retainedAssistant]

    expect(estimateActiveContextTokens(messages)).toBe(estimateMessagesTokens(messages))
    expect(shouldCompactNativeContext(estimateActiveContextTokens(messages), 100_000)).toBe(false)
  })

  it('keeps provider usage out of transcript-only estimates', () => {
    const messages: Message[] = [
      { role: 'user', content: '[Compacted conversation summary]\nShort summary', timestamp: 100 },
      { ...assistant('stop'), usage: { ...usage, input: 1_000, totalTokens: 1_005 }, timestamp: 101 },
      { role: 'user', content: 'next', timestamp: 102 }
    ]

    expect(estimateActiveContextTokens(messages)).toBe(estimateMessagesTokens(messages))
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
      userMessage('keep the exact migration objective'),
      { ...assistant('stop'), content: [{ type: 'text', text: 'old log '.repeat(4_000) }] },
      userMessage('recent '.repeat(400)),
      { ...assistant('stop'), content: [{ type: 'text', text: 'final '.repeat(400) }], timestamp: 5 }
    ]
    const original = createNativeContext(messages)
    const compacted = compactNativeContext(original, 500)

    expect(compacted.messages).toEqual(messages)
    expect(compacted.activeStartIndex).toBeGreaterThan(0)
    expect(compacted.messages[compacted.activeStartIndex]?.role).not.toBe('toolResult')
    expect(getActiveMessages(compacted)[0]).toMatchObject({ role: 'user' })
    expect(compacted.compaction?.summary).toContain('keep the exact migration objective')
    expect(compacted.compaction?.summary).not.toContain('Goal:')
    expect(estimateMessagesTokens(getActiveMessages(compacted)) + Math.ceil((compacted.compaction?.summary.length ?? 0) / 4)).toBeLessThan(estimateMessagesTokens(messages))
  })

  it('compacts flat mid-turn transcripts without mutating input or orphaning tool results', () => {
    const messages: Message[] = [
      userMessage('preserve the original objective'),
      { ...assistant(), content: [{ type: 'text', text: 'old output '.repeat(2_000) }] },
      toolResult,
      userMessage('recent '.repeat(400)),
      { ...assistant('stop'), content: [{ type: 'text', text: 'final '.repeat(400) }], timestamp: 5 }
    ]
    const before = structuredClone(messages)
    const compacted = compactMessagesAtSafeBoundary(messages, 500)

    expect(messages).toEqual(before)
    expect(compacted.changed).toBe(true)
    expect(compacted.checkpoint?.summary).toContain('old ')
    expect(compacted.messages.some((message, index) => index > 0 && message.role === 'toolResult' && compacted.messages[index - 1]?.role !== 'assistant')).toBe(false)
    expect(compacted.checkpoint!.tokensAfter).toBeLessThan(compacted.checkpoint!.tokensBefore)
  })

  it('commits the exact retained suffix when native messages repeat', () => {
    const repeated = userMessage('same prompt')
    const messages: Message[] = [
      repeated,
      { ...assistant('stop'), content: [{ type: 'text', text: 'old output '.repeat(2_000) }] },
      structuredClone(repeated),
      assistant('stop')
    ]
    const context = createNativeContext(messages)
    const candidate = compactMessagesAtSafeBoundary(messages, 10)
    expect(candidate.changed).toBe(true)
    const committed = commitNativeMessages(context, candidate.messages, candidate.checkpoint)

    expect(committed.messages).toEqual(messages)
    expect(committed.activeStartIndex).toBe(candidate.checkpoint?.retainedFromIndex)
    expect(getActiveMessages(committed)).toEqual(candidate.messages)
  })

  it('reports an unchanged durable context by identity when no safe reduction exists', () => {
    const context = createNativeContext([userMessage('only current request')])
    expect(compactNativeContext(context, 20_000)).toBe(context)
  })

  it('preserves user intent while excluding tool output from directives', () => {
    const messages: Message[] = [
      userMessage('make it a single app and keep a status report'),
      { ...assistant('stop'), content: [{ type: 'text', text: 'working '.repeat(3_000) }] },
      {
        ...toolResult,
        details: { preserved: true, mousseUserSteer: 'keep the migration status report current' },
        isError: true,
        content: [{ type: 'text', text: '404 /imgs/calur_image_1.png '.repeat(300) }]
      },
      userMessage('remove the nested app'),
      { ...assistant('stop'), content: [{ type: 'text', text: 'recent '.repeat(500) }] }
    ]
    const result = compactMessagesAtSafeBoundary(messages, 500)
    expect(result.changed).toBe(true)
    expect(result.checkpoint?.directives.map((entry) => entry.text)).toEqual([
      'make it a single app and keep a status report',
      'keep the migration status report current'
    ])
    expect(result.checkpoint?.summary).toContain('make it a single app')
    expect(result.checkpoint?.summary).not.toMatch(/\[user[^\n]*404 \/imgs/)
  })

  it('rejects a stale compaction checkpoint instead of duplicating history', () => {
    const messages: Message[] = [
      userMessage('keep this objective'),
      { ...assistant('stop'), content: [{ type: 'text', text: 'old log '.repeat(2_000) }] },
      userMessage('recent')
    ]
    const context = createNativeContext(messages)
    const candidate = compactMessagesAtSafeBoundary(messages, 5)
    const advanced = commitNativeMessages(context, [...messages, userMessage('new')])
    expect(() => commitNativeMessages(advanced, candidate.messages, candidate.checkpoint)).toThrow(/STALE_CONTEXT_COMPACTION/)
  })

  it('preserves the root objective and lossless archive across 50 compactions', () => {
    let context = createNativeContext([
      userMessage('ROOT OBJECTIVE: deliver the complete migration and audit'),
      { ...assistant('stop'), content: [{ type: 'text', text: 'initial output '.repeat(1_000) }] },
      userMessage('follow-up 0')
    ])
    context = compactNativeContext(context, 10)
    for (let index = 1; index <= 50; index += 1) {
      context = appendNativeMessage(context, {
        ...assistant('stop'),
        content: [{ type: 'text', text: `iteration ${index} `.repeat(1_000) }],
        timestamp: 100 + index
      })
      context = appendNativeMessage(context, userMessage(`follow-up ${index}`))
      context = compactNativeContext(context, 10)
    }

    expect(context.messages).toHaveLength(103)
    expect(context.compaction?.generation).toBeGreaterThanOrEqual(50)
    expect(context.compaction?.summary).toContain('ROOT OBJECTIVE: deliver the complete migration and audit')
    expect(context.compaction?.summary).toContain('follow-up 48')
    expect(JSON.stringify(getActiveMessages(context))).toContain('follow-up 50')
    expect(context.compaction?.summary).not.toContain('Goal:')
  })

  it('returns an unchanged result when no safe cut is available', () => {
    const messages: Message[] = [userMessage('short'), assistant()]
    const result = compactMessagesAtSafeBoundary(messages, 50_000)
    expect(result.changed).toBe(false)
    expect(result.messages).toEqual(messages)
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
