/**
 * The context gauge of a thread with no session reads only what it measures, in the read worker (`readGaugeData`).
 * Its figures must equal what the same thread gives once loaded whole.
 */
import { randomBytes } from 'node:crypto'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProjectManager } from '../src/mms/data/ProjectManager'
import { ThreadDataStore } from '../src/mms/data/ThreadDataStore'
import { BLOBS_DIR } from '../src/mms/data/threadDb/threadBlobs'
import { GAUGE_TOKEN_LOOKBACK, ThreadDbEngine } from '../src/mms/data/threadDb/threadDbEngine'
import { estimateMessage } from '../src/mms/orchestrator/contextEstimate'
import { computeContextUsage } from '../src/mms/orchestrator/contextUsage'
import { getActiveMessages } from '../src/mms/orchestrator/nativeContext'
import type { Message } from '../src/shared/transcript'
import type { ChatMessage, NativeLlmContext } from '../src/shared/types'
import { createOrchestrator } from './run/phase6Fixture'

vi.setConfig({ testTimeout: 60_000 })

let home: string
const previous = { home: process.env.MOUSSE_HOME, sqlite: process.env.MOUSSE_SQLITE_THREAD_STORE }

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'mousse-gauge-read-')))
  process.env.MOUSSE_HOME = home
  process.env.MOUSSE_SQLITE_THREAD_STORE = '1'
})

afterEach(() => {
  try { rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }) } catch { /* left for the OS */ }
  if (previous.home === undefined) delete process.env.MOUSSE_HOME
  else process.env.MOUSSE_HOME = previous.home
  if (previous.sqlite === undefined) delete process.env.MOUSSE_SQLITE_THREAD_STORE
  else process.env.MOUSSE_SQLITE_THREAD_STORE = previous.sqlite
})

const at = '2026-01-01T00:00:00.000Z'

function chat(id: string, role: 'user' | 'assistant', content: string, tokensUsed?: number): ChatMessage {
  return { id, role, content, timestamp: at, ...(tokensUsed !== undefined ? { responseMetadata: { tokensUsed } } : {}) } as ChatMessage
}

function assistant(content: Extract<Message, { role: 'assistant' }>['content']): Message {
  return { role: 'assistant', content, api: 'openai-completions', provider: 'openai', model: 'm', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: 1 } as Message
}

/** A model context with every kind of message the gauge splits into categories, images included. */
function mixedContext(image: string): Message[] {
  return [
    { role: 'user', content: '[Compacted conversation summary]\nearlier work '.padEnd(900, 's'), timestamp: 1 },
    { role: 'user', content: [{ type: 'text', text: 'look at this '.padEnd(300, 'q') }, { type: 'image', data: image, mimeType: 'image/png' }], timestamp: 1 },
    assistant([{ type: 'thinking', thinking: 'thinking '.padEnd(1_200, 't') }, { type: 'text', text: 'reply '.padEnd(700, 'r') }, { type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: '/a/b', lines: [1, 2, 3] } }]),
    { role: 'toolResult', toolCallId: 'call-1', toolName: 'read', content: [{ type: 'text', text: 'file '.padEnd(2_000, 'f') }, { type: 'image', data: image, mimeType: 'image/png' }], isError: false, timestamp: 1 } as Message,
    assistant([{ type: 'text', text: 'done '.padEnd(400, 'd') }])
  ]
}

/** A started thread with `messages` and a model context of `context`, written and closed. */
function seed(messages: ChatMessage[], context: Message[], extra: Record<string, unknown> = {}): string {
  const writer = new ThreadDataStore(new ProjectManager())
  const thread = writer.createThread('Gauge', undefined, undefined, { started: true })
  const llmContext = { version: 2, messages: context, fidelity: 'native', activeStartIndex: 0, revision: 0, ...extra }
  writer.mutateThreadData(thread.id, () => ({ messages, llmContext: llmContext as never }))
  writer.closeThreadStorage()
  return thread.id
}

/** The gauge measured without a session, then with the thread loaded whole. */
async function measuredAndLoaded(id: string): Promise<[unknown, unknown]> {
  const store = new ThreadDataStore(new ProjectManager())
  const orch = createOrchestrator(home, store)
  try {
    const measured = await orch.getContextUsage({ draftInput: 'draft', mode: 'agent' }, id)
    expect(orch.hasSession(id)).toBe(false)
    orch.getOrCreateSession(id)
    const loaded = await orch.getContextUsage({ draftInput: 'draft', mode: 'agent' }, id)
    return [measured, loaded]
  } finally {
    store.closeThreadStorage()
  }
}

describe('the context gauge of a thread with no session', () => {
  it('counts an image whose file is missing as the short note a full load sends, not as an image', async () => {
    const image = randomBytes(3_000).toString('base64')
    const id = seed([chat('u1', 'user', 'hello')], mixedContext(image))
    const store = new ThreadDataStore(new ProjectManager())
    const dir = store.getThreadDir(id)
    store.closeThreadStorage()
    // The image's file is gone (a copied profile, a cleaned folder).
    rmSync(join(dir, BLOBS_DIR), { recursive: true, force: true })
    const [measured, loaded] = await measuredAndLoaded(id)
    expect((loaded as { used: number }).used).toBeGreaterThan(0)
    expect(measured).toEqual(loaded)
  })

  it('still counts an image whose file is there as an image', async () => {
    const image = randomBytes(3_000).toString('base64')
    const id = seed([chat('u1', 'user', 'hello')], mixedContext(image))
    const [measured, loaded] = await measuredAndLoaded(id)
    expect(measured).toEqual(loaded)
    // Two images of 1,024 tokens each are in view.
    expect((measured as { used: number }).used).toBeGreaterThan(2_048)
  })

  it('looks for the newest message with a token count only among the newest messages', async () => {
    const reported = [chat('a0', 'assistant', 'counted', 1_234)]
    const unreported = Array.from({ length: GAUGE_TOKEN_LOOKBACK + 50 }, (_, i) => chat(`m${i}`, i % 2 ? 'assistant' : 'user', `message ${i}`))
    const context = mixedContext(randomBytes(3_000).toString('base64'))
    const old = seed([...reported, ...unreported], context)
    const recent = seed([...unreported, ...reported, chat('late', 'assistant', 'late', 99), ...unreported.slice(0, 10)], context)
    const store = new ThreadDataStore(new ProjectManager())
    try {
      // A runtime that stopped reporting tokens long ago: the lookup stops after the newest messages.
      expect((await store.readGaugeData(old))!.messages).toEqual([])
      // The newest message with a count, found among the newest messages.
      expect((await store.readGaugeData(recent))!.messages.map((message) => message.id)).toEqual(['late'])
    } finally {
      store.closeThreadStorage()
    }
  })

  it('the read worker estimates each active message exactly as the daemon would from the whole thread', async () => {
    const image = randomBytes(3_000).toString('base64')
    const context = [...mixedContext(image), ...mixedContext(image)]
    const id = seed([chat('u1', 'user', 'hello')], context, { activeStartIndex: 3 })
    const store = new ThreadDataStore(new ProjectManager())
    const dir = store.getThreadDir(id)
    const engine = new ThreadDbEngine({ idleCloseMs: 0, checkpointOnClose: false })
    try {
      const expected = (): unknown => getActiveMessages(store.loadThreadData(id).llmContext as NativeLlmContext).map((message) => estimateMessage(message))
      const gauge = engine.gauge(dir)
      expect(gauge.estimates).toHaveLength(context.length - 3)
      expect(gauge.estimates).toEqual(expected())
      // With the images' files gone too.
      store.forgetThreadData(id)
      rmSync(join(dir, BLOBS_DIR), { recursive: true, force: true })
      expect(engine.gauge(dir).estimates).toEqual(expected())
    } finally {
      engine.closeEverything()
      store.closeThreadStorage()
    }
  })

  it('figures from estimates equal figures from the messages, with and without a measurement', () => {
    const messages = [...mixedContext(randomBytes(3_000).toString('base64')), ...mixedContext('')]
    const base = { draftInput: 'draft', contextLimit: 200_000, modelName: 'm', lastMeasuredCacheRead: null, lastMeasuredCacheWrite: null, summaryText: 'summary' }
    for (const measurement of [{ lastMeasuredInput: null }, { lastMeasuredInput: 5_000, lastMeasuredCacheRead: 1_000, measuredAtMessageLength: 4 }]) {
      const fromMessages = computeContextUsage({ ...base, ...measurement, messages })
      expect(fromMessages.used).toBeGreaterThan(0)
      expect(computeContextUsage({ ...base, ...measurement, messageEstimates: messages.map((message) => estimateMessage(message)) })).toEqual(fromMessages)
    }
  })
})
