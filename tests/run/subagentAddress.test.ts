import { afterEach, describe, expect, it } from 'vitest'
import { normalizeSubagentTitle, resolveSubagent, subagentsTitled, visibleSubagents } from '../../src/mms/run/delegation/subagentAddress'
import { narrowCeiling, delegationRequestKey, followUpRequestKey } from '../../src/mms/run/delegation/policy'
import { delegationFixture, type DelegationFixture } from './delegationFixture'

describe('addressing a subagent by title (issue #142)', () => {
  let f: DelegationFixture | undefined
  afterEach(() => {
    f?.dispose()
    f = undefined
  })

  /** Two parents, each with subagents; `titles` is what the thread store would answer. */
  const world = async () => {
    f = delegationFixture()
    const a = await f.runningRun('parent-a')
    const b = await f.runningRun('parent-b')
    const reviewer = await f.delegate(a.runId, 'a1', { title: 'API reviewer' })
    const writer = await f.delegate(a.runId, 'a2', { title: 'Docs writer' })
    const foreign = await f.delegate(b.runId, 'b1', { title: 'API reviewer' })
    const titles = new Map<string, string>([[reviewer.childThreadId, 'API reviewer'], [writer.childThreadId, 'Docs writer'], [foreign.childThreadId, 'API reviewer']])
    const sources = { delegations: f.engine.delegations, titleOf: (id: string) => titles.get(id) }
    return { sources, titles, reviewer, writer, foreign }
  }

  it('normalizes titles: trimmed, spaces collapsed, case ignored', () => {
    expect(normalizeSubagentTitle('  API   Reviewer\t')).toBe('api reviewer')
    expect(normalizeSubagentTitle('api reviewer')).toBe(normalizeSubagentTitle('API REVIEWER'))
    expect(normalizeSubagentTitle('API reviewer')).not.toBe(normalizeSubagentTitle('API reviewers'))
  })

  it('resolves by title, childThreadId and delegationId, only among the caller\'s own subagents', async () => {
    const { sources, reviewer, writer, foreign } = await world()
    expect(resolveSubagent(sources, 'parent-a', ' api  REVIEWER')).toMatchObject({ ok: true, childThreadId: reviewer.childThreadId, title: 'API reviewer' })
    expect(resolveSubagent(sources, 'parent-a', writer.childThreadId)).toMatchObject({ ok: true, childThreadId: writer.childThreadId })
    expect(resolveSubagent(sources, 'parent-a', reviewer.delegationId)).toMatchObject({ ok: true, childThreadId: reviewer.childThreadId, delegation: { delegationId: reviewer.delegationId } })
    // Another parent's subagent is not addressable, by title (same title, its own subagent), id or delegation.
    expect(resolveSubagent(sources, 'parent-b', 'API reviewer')).toMatchObject({ ok: true, childThreadId: foreign.childThreadId })
    expect(resolveSubagent(sources, 'parent-a', foreign.childThreadId)).toMatchObject({ ok: false, code: 'unknown_subagent' })
    expect(resolveSubagent(sources, 'parent-a', foreign.delegationId)).toMatchObject({ ok: false, code: 'unknown_subagent' })
  })

  it('an unknown name lists the caller\'s subagents, or says it has none', async () => {
    const { sources } = await world()
    const unknown = resolveSubagent(sources, 'parent-a', 'Nobody')
    expect(unknown).toMatchObject({ ok: false, code: 'unknown_subagent' })
    expect(unknown.ok ? '' : unknown.message).toBe('You have no subagent titled "Nobody". Your subagents: "API reviewer", "Docs writer".')
    const none = resolveSubagent(sources, 'parent-c', 'Nobody')
    expect(none.ok ? '' : none.message).toContain('you have not started any')
  })

  it('a subagent whose thread is gone is trashed when addressed by id, unknown by title', async () => {
    const { sources, titles, reviewer } = await world()
    titles.delete(reviewer.childThreadId)
    expect(resolveSubagent(sources, 'parent-a', reviewer.childThreadId)).toMatchObject({ ok: false, code: 'subagent_trashed', message: expect.stringContaining('delegate_task') })
    expect(resolveSubagent(sources, 'parent-a', reviewer.delegationId)).toMatchObject({ ok: false, code: 'subagent_trashed' })
    expect(resolveSubagent(sources, 'parent-a', 'API reviewer')).toMatchObject({ ok: false, code: 'unknown_subagent' })
    expect(visibleSubagents(sources, 'parent-a').map((child) => child.title)).toEqual(['Docs writer'])
  })

  it('older duplicates of a title are ambiguous and listed by thread id', async () => {
    const { sources, titles, reviewer, writer } = await world()
    titles.set(writer.childThreadId, 'api reviewer')
    const ambiguous = resolveSubagent(sources, 'parent-a', 'API reviewer')
    expect(ambiguous).toMatchObject({ ok: false, code: 'ambiguous_subagent', candidates: [reviewer.childThreadId, writer.childThreadId] })
    // A thread id still singles one out.
    expect(resolveSubagent(sources, 'parent-a', writer.childThreadId)).toMatchObject({ ok: true, childThreadId: writer.childThreadId })
    expect(subagentsTitled(sources, 'parent-a', 'api REVIEWER')).toEqual([reviewer.childThreadId, writer.childThreadId])
  })
})

describe('ceilings only narrow', () => {
  it.each([
    [[undefined, undefined], undefined],
    [['default', undefined], 'default'],
    [[undefined, 'default'], 'default'],
    [['default', 'default'], 'default'],
    [['plan', 'default'], 'plan'],
    [['default', 'plan'], 'plan'],
    [['plan', undefined], 'plan'],
    [[null, 'plan'], 'plan'],
    [['plan', 'plan'], 'plan']
  ] as const)('%j gives %s', (ceilings, expected) => {
    expect(narrowCeiling(...ceilings)).toBe(expected)
  })
})

describe('retry keys', () => {
  it('a model-supplied clientRequestId (mcp:) is scoped to the thread, a pi tool-call id to its run', () => {
    expect(delegationRequestKey('thread', 'run:1', 'mcp:abc')).toBe('delegation:thread:mcp:abc')
    expect(delegationRequestKey('thread', 'run:1', 'call-7')).toBe('delegation:run:1:call-7')
    expect(followUpRequestKey('thread', 'run:1', 'mcp:abc')).toBe('continue:thread:mcp:abc')
    expect(followUpRequestKey('thread', 'run:1', 'call-7')).toBe('continue:run:1:call-7')
  })
})
