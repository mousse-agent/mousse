import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { AssistantMessage, Message, ToolResultMessage } from '@earendil-works/pi-ai'
import { ProjectManager } from '../src/mms/data/ProjectManager'
import { ThreadDataStore } from '../src/mms/data/ThreadDataStore'
import {
  appendNativeMessage,
  clearNativeContext,
  compactMessagesAtSafeBoundary,
  compactNativeContext,
  commitNativeMessages,
  createNativeContext,
  estimateActiveContextTokens,
  estimateMessagesTokens,
  getActiveMessages,
  migrateLegacyContext,
  nextPromptCache,
  promptCacheOf,
  shouldCompactNativeContext,
  userMessage
} from '../src/mms/orchestrator/nativeContext'
import { ThreadSession } from '../src/mms/orchestrator/ThreadSession'
import { STEER_MARKER_CLOSE, STEER_MARKER_OPEN } from '../src/mms/orchestrator/steer'
import { nativeAgentHistory } from '../src/mms/providers/nativeAgentHistory'

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
    expect(committed.compaction?.generation).toBe(1)

    // Reloading the persisted context does not stack another summary generation.
    const restored = commitNativeMessages(JSON.parse(JSON.stringify(committed)), getActiveMessages(committed))
    expect(restored.compaction?.generation).toBe(1)
    expect(getActiveMessages(restored)).toEqual(candidate.messages)
  })

  it('reports an unchanged durable context by identity when no safe reduction exists', () => {
    const context = createNativeContext([userMessage('only current request')])
    expect(compactNativeContext(context, 20_000)).toBe(context)
  })

  it('/clear leaves nothing provider-visible and keeps the archive and compaction generation', () => {
    const messages: Message[] = [
      userMessage('the secret plan is blue'),
      { ...assistant('stop'), content: [{ type: 'text', text: 'old log '.repeat(4_000) }] },
      userMessage('recent '.repeat(400)),
      { ...assistant('stop'), content: [{ type: 'text', text: 'final '.repeat(400) }], timestamp: 5 }
    ]
    const compacted = compactNativeContext(createNativeContext(messages), 500)
    expect(nativeAgentHistory(compacted)).not.toBe('')
    const cleared = clearNativeContext(compacted)

    expect(cleared.messages).toEqual(messages)
    expect(getActiveMessages(cleared)).toEqual([])
    expect(cleared.clearedAtIndex).toBe(messages.length)
    expect(cleared.compaction?.generation).toBe(compacted.compaction?.generation)
    expect(cleared.compaction?.summary).toBe('')
    expect(cleared.revision).toBe((compacted.revision ?? 0) + 1)
    // The history every runtime fingerprints is empty: none resumes its old session.
    expect(nativeAgentHistory(cleared)).toBe('')
    expect(nativeAgentHistory(clearNativeContext(createNativeContext(messages)))).toBe('')
  })

  it('never brings cleared messages back into a later compaction', () => {
    const before: Message[] = [
      userMessage('the secret plan is blue'),
      { ...assistant('stop'), content: [{ type: 'text', text: 'old '.repeat(400) }] }
    ]
    const after: Message[] = [
      userMessage('write the release notes'),
      { ...assistant('stop'), content: [{ type: 'text', text: 'working '.repeat(4_000) }] },
      userMessage('recent '.repeat(400)),
      { ...assistant('stop'), content: [{ type: 'text', text: 'final '.repeat(400) }], timestamp: 5 }
    ]
    let context = clearNativeContext(createNativeContext(before))
    for (const message of after) context = appendNativeMessage(context, message)
    const compacted = compactNativeContext(context, 500)

    expect(compacted.activeStartIndex).toBeGreaterThan(before.length)
    expect(compacted.compaction?.summary).toContain('write the release notes')
    expect(compacted.compaction?.summary).not.toContain('secret plan')
  })

  it('adds a /compact focus to the generated memory', () => {
    const messages: Message[] = [
      userMessage('ship the login fix'),
      { ...assistant('stop'), content: [{ type: 'text', text: 'old log '.repeat(4_000) }] },
      userMessage('recent '.repeat(400)),
      { ...assistant('stop'), content: [{ type: 'text', text: 'final '.repeat(400) }], timestamp: 5 }
    ]
    const compacted = compactNativeContext(createNativeContext(messages), 500, '  keep the failing test names ')
    expect(compacted.compaction?.summary).toContain('keep the failing test names')
    expect(compactNativeContext(createNativeContext(messages), 500).compaction?.summary).not.toContain('Focus')
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

  it('reads a steer back out of the out-of-band marker that saved history carries', () => {
    const messages: Message[] = [
      userMessage(`tool output\n\n${STEER_MARKER_OPEN}\nuse tabs, not spaces\n${STEER_MARKER_CLOSE}`),
      { ...assistant('stop'), content: [{ type: 'text', text: 'working '.repeat(3_000) }] },
      userMessage('now run the tests'),
      { ...assistant('stop'), content: [{ type: 'text', text: 'recent '.repeat(500) }] }
    ]
    const result = compactMessagesAtSafeBoundary(messages, 500)
    expect(result.changed).toBe(true)
    const steer = result.checkpoint?.directives.find((entry) => entry.source === 'user-steer')
    expect(steer?.text).toBe('use tabs, not spaces')
    expect(result.checkpoint?.directives.some((entry) => entry.text.includes('tool output'))).toBe(false)
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

describe('the prompt cache record', () => {
  const hour = 60 * 60_000
  const withTurn = () => appendNativeMessage(appendNativeMessage(createNativeContext(), userMessage('hello')), assistant('stop'))

  it('holds while the history is the one the turn left, and is cold after any change to it', () => {
    let context = withTurn()
    context = { ...context, promptCache: nextPromptCache(context, { at: 1_000, ttlMs: hour, modelKey: 'claude-subscription:opus' }) }
    expect(promptCacheOf(context)).toEqual({ lastRequestAt: 1_000, ttlMs: hour, revision: context.revision, modelKey: 'claude-subscription:opus' })
    // A message, a compaction, a /clear: each starts a fresh runtime session, so nothing of it is cached.
    expect(promptCacheOf(appendNativeMessage(context, userMessage('later')))).toBeUndefined()
    expect(promptCacheOf(clearNativeContext(context))).toBeUndefined()
    expect(promptCacheOf(commitNativeMessages(context, [userMessage('replaced')]))).toBeUndefined()
  })

  it('keeps the earlier lifetime for a turn that only read the cache, on the same model', () => {
    const first = withTurn()
    const cached = { ...first, promptCache: nextPromptCache(first, { at: 1_000, ttlMs: hour, modelKey: 'm' }) }
    const next = appendNativeMessage(appendNativeMessage(cached, userMessage('again')), assistant('stop'))
    expect(nextPromptCache(next, { at: 2_000, modelKey: 'm' })).toEqual({ lastRequestAt: 2_000, ttlMs: hour, revision: next.revision, modelKey: 'm' })
    // A write says its own lifetime; another model has its own cache.
    expect(nextPromptCache(next, { at: 2_000, ttlMs: 5 * 60_000, modelKey: 'm' }).ttlMs).toBe(5 * 60_000)
    expect(nextPromptCache(next, { at: 2_000, modelKey: 'other' }).ttlMs).toBeUndefined()
  })

  it('drops an unreadable record when a session loads, and keeps a good one', () => {
    const context = withTurn()
    const session = new ThreadSession('t')
    session.load([], { ...context, promptCache: { lastRequestAt: 'yesterday', revision: -1 } as never })
    expect(session.nativeContext.promptCache).toBeUndefined()
    const good = { lastRequestAt: 1_000, revision: context.revision ?? 0 }
    session.load([], { ...context, promptCache: good })
    expect(promptCacheOf(session.nativeContext)).toEqual(good)
  })
})
