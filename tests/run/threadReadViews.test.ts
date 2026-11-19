/**
 * `thread_read`'s short views for an agent (a thread pointed at by reference): `summary` (what the thread is, none of its
 * content) and `recent` (its last turns, trimmed), beside the paged `messages`. The registry and the real Run Engine; the
 * host is a fake that holds the threads.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { ChatMessage, Thread } from '../../src/shared/types'
import { delegationFixture, type DelegationFixture } from './delegationFixture'
import { appToolRegistry, appTurn, fakeAppToolHost } from './appToolsFixture'
import { RECENT_ANSWER_CHARS, RECENT_STEPS_MAX, recentTurns } from '../../src/mms/run/mcp/appTools/threadViews'

const NOW = '2026-11-16T10:00:00.000Z'
const thread = (id: string, patch: Partial<Thread> = {}): Thread => ({ id, name: `Thread ${id}`, createdAt: NOW, updatedAt: NOW, startedAt: NOW, projectId: 'p1', order: 0, ...patch }) as Thread
const message = (index: number, role: ChatMessage['role'], content: string): ChatMessage => ({ id: `m${index}`, role, content, timestamp: NOW })

/** Four turns: each a prompt, a progress note and an answer. The last answer is long. */
const TRANSCRIPT: ChatMessage[] = [0, 1, 2, 3].flatMap((turn) => [
  message(turn * 3, 'user', `Prompt ${turn}`),
  message(turn * 3 + 1, 'assistant', `Checking step ${turn}\nwith a second line`),
  message(turn * 3 + 2, 'assistant', turn === 3 ? `Final answer 3 ${'x'.repeat(RECENT_ANSWER_CHARS)}` : `Answer ${turn}`)
])

describe('thread_read summary and recent for an agent', () => {
  let fx: DelegationFixture | undefined
  afterEach(() => {
    fx?.dispose()
    fx = undefined
  })

  const world = async () => {
    fx = delegationFixture()
    const callerRun = await fx.runningRun('caller')
    const targetRun = await fx.runningRun('target')
    fx.finish(targetRun.runId)
    const threads = new Map<string, Thread>([
      ['caller', thread('caller')],
      ['target', thread('target', {
        name: 'Design notes',
        modelOverride: { instanceId: 'claude', llmProvider: 'claude', model: 'claude-fable-5-2', name: 'Claude Fable 5.2', effort: 'high' },
        pullRequest: { number: 42, url: 'https://github.com/o/r/pull/42', host: 'github.com', nameWithOwner: 'o/r', headRefName: 'design', baseRefName: 'main', headRepository: null, isCrossRepository: false, linkedAt: NOW }
      })],
      ['private', thread('private', { localOnly: true })],
      ['bot-chat', thread('bot-chat', { botOwned: true } as Partial<Thread>)]
    ])
    const fake = fakeAppToolHost({
      threadMeta: (id) => threads.get(id),
      listThreads: () => [...threads.values()],
      listProjects: () => [{ id: 'p1', name: 'Web app' }],
      threadMessages: (id) => (id === 'target' || id === 'private' ? TRANSCRIPT : []),
      threadActivity: () => ({ queuedCount: 0, pendingQuestions: [] }),
      botRole: (id) => (id === 'bot-chat' ? 'activation' : undefined)
    })
    const { registry, turns, request } = appToolRegistry(fx.engine, fake.host)
    turns.register(appTurn({ threadId: 'caller', runId: callerRun.runId }))
    const read = async (args: Record<string, unknown>) => {
      try {
        const outcome = await registry.call('thread_read', args, request({ threadId: 'caller', runId: callerRun.runId }))
        return outcome.isError ? { error: outcome.text } : { body: JSON.parse(outcome.text) as Record<string, any> }
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) }
      }
    }
    return { read, completedAt: fx.engine.getRun(targetRun.runId)!.completedAt }
  }

  it('summary says what the thread is and where it stands, and holds none of its text', async () => {
    const { read, completedAt } = await world()
    const { body } = await read({ threadId: 'target', view: 'summary' })
    expect(body).toMatchObject({
      threadId: 'target',
      link: 'mousse://thread/target',
      title: 'Design notes',
      project: 'Web app',
      status: 'idle',
      model: { model: 'claude-fable-5-2', name: 'Claude Fable 5.2' },
      lastCompletedAt: completedAt,
      pullRequest: { number: 42, url: 'https://github.com/o/r/pull/42' },
      messages: TRANSCRIPT.length
    })
    expect(completedAt).toBeTruthy()
    expect(JSON.stringify(body)).not.toMatch(/Prompt|Answer|Checking/)
  })

  it('recent holds the last turns, each its prompt, a line per step and its final answer, trimmed, and where to read on', async () => {
    const { read } = await world()
    const { body } = await read({ threadId: 'target', view: 'recent', turns: 2 })
    expect(body!.turns).toHaveLength(2)
    const [older, newest] = body!.turns
    expect(older).toMatchObject({ prompt: { index: 6, text: 'Prompt 2' }, steps: ['Checking step 2 with a second line'], answer: { index: 8, text: 'Answer 2' } })
    expect(newest.prompt.text).toBe('Prompt 3')
    expect(newest.answer).toMatchObject({ index: 11, cut: true, totalChars: TRANSCRIPT[11]!.content.length })
    expect(newest.answer.text.length).toBeLessThanOrEqual(RECENT_ANSWER_CHARS + 1)
    // Paging the full turns goes on from the first one shown.
    expect(body!.fromIndex).toBe(6)
    const page = (await read({ threadId: 'target', view: 'messages', afterIndex: body!.fromIndex })).body!
    expect(page.messages[0]).toMatchObject({ index: 6, text: 'Prompt 2' })
    // The default is three turns.
    expect((await read({ threadId: 'target', view: 'recent' })).body!.turns).toHaveLength(3)
  })

  // Who may read what, by view: the short views are held to the transcript's own rules.
  it.each([
    ['a thread of the profile', 'target', true],
    ['a private thread, from a shared one', 'private', false],
    ['a bot\'s chat', 'bot-chat', false],
    ['a thread that does not exist', 'gone', false]
  ])('%s: summary, recent and messages are all %s', async (_name, threadId, readable) => {
    const { read } = await world()
    for (const view of ['summary', 'recent', 'messages']) {
      const result = await read({ threadId, view })
      expect({ view, readable: result.error === undefined }).toEqual({ view, readable })
    }
  })

  it('refuses an unknown view and a turns count out of range', async () => {
    const { read } = await world()
    expect((await read({ threadId: 'target', view: 'everything' })).error).toMatch(/view must be/)
    expect((await read({ threadId: 'target', view: 'recent', turns: 11 })).error).toMatch(/turns must be an integer from 1 to 10/)
  })
})

describe('recentTurns', () => {
  const rows = (entries: Array<[string, string]>) => entries.map(([role, text], index) => ({ index, role, text }))

  it.each([
    ['no messages', [], 0, []],
    ['answers before any prompt read as one turn', [['assistant', 'Started on its own'], ['assistant', 'Done']], 1, [{ steps: ['Started on its own'], answer: 'Done' }]],
    ['a prompt with no answer yet', [['user', 'Go'], ['assistant', 'Done'], ['user', 'And then?']], 2, [{ prompt: 'Go', answer: 'Done' }, { prompt: 'And then?' }]],
    ['a system line between steps is marked', [['user', 'Go'], ['system', 'Turn stopped.'], ['assistant', 'Resumed and done']], 1, [{ prompt: 'Go', steps: ['(system) Turn stopped.'], answer: 'Resumed and done' }]]
  ] as const)('%s', (_name, entries, count, expected) => {
    const { turns } = recentTurns(rows(entries as unknown as Array<[string, string]>), 3)
    expect(turns).toHaveLength(count)
    turns.forEach((turn, at) => {
      const want = expected[at] as { prompt?: string; steps?: readonly string[]; answer?: string }
      expect(turn.prompt?.text).toBe(want.prompt)
      expect(turn.steps).toEqual(want.steps)
      expect(turn.answer?.text).toBe(want.answer)
    })
  })

  it(`keeps the newest ${RECENT_STEPS_MAX} step lines and counts the rest`, () => {
    const steps = Array.from({ length: RECENT_STEPS_MAX + 3 }, (_, at): [string, string] => ['assistant', `step ${at}`])
    const [turn] = recentTurns(rows([['user', 'Go'], ...steps, ['assistant', 'Done']]), 1).turns
    expect(turn!.steps).toHaveLength(RECENT_STEPS_MAX)
    expect(turn!.steps![0]).toBe('step 3')
    expect(turn!.stepsLeftOut).toBe(3)
  })
})
