/**
 * Every thread and project id a window is given for a thread of another computer is qualified. The
 * walker takes the results and events a real owner sends for threads with a parent, a subagent, a
 * project and a started-from record, and fails on any owner id that is left as the owner wrote it.
 */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  ROUTED_PARAM_PROJECT_KEYS,
  ROUTED_PARAM_THREAD_KEYS,
  qualifyRoutedEvent,
  qualifyRoutedResult,
  unqualifyRoutedParams
} from '../../../../src/shared/bridge/routedIds'
import {
  ensureQualified,
  isQualifiedId,
  parseQualifiedId,
  qualifyId,
  unqualifyId
} from '../../../../src/shared/threadRef'
import { newId } from '../../../../src/shared/net'
import { cleanupAll, cleanups, linked } from './routerFixture'

afterAll(cleanupAll)

const NODE = newId('node')

describe('qualified ids', () => {
  it('round-trips, and never reads a plain id or a lists key as qualified', () => {
    const id = '5f1c0e1e-8f3a-4c0e-9f5e-6a1b2c3d4e5f'
    const named = qualifyId(NODE, id)
    expect(named).toBe(`${NODE}:${id}`)
    expect(parseQualifiedId(named)).toEqual({ node: NODE, id })
    expect(unqualifyId(named)).toBe(id)
    expect(unqualifyId(id)).toBe(id)
    expect(isQualifiedId(id)).toBe(false)
    expect(isQualifiedId('mousse:lists')).toBe(false)
    expect(isQualifiedId(`${NODE}:`)).toBe(false)
    expect(isQualifiedId(`${NODE}:a:b`)).toBe(false)
    expect(ensureQualified(NODE, named)).toBe(named)
    expect(ensureQualified(NODE, id)).toBe(named)
  })

  it('splits a call by the computer its ids name, and refuses nothing it does not understand', () => {
    const other = newId('node')
    const split = unqualifyRoutedParams({ threadId: `${NODE}:t1`, originThreadId: `${NODE}:t2`, name: 'x' })
    expect(split).toEqual({ params: { threadId: 't1', originThreadId: 't2', name: 'x' }, nodes: [NODE], hasLocal: false })
    expect(unqualifyRoutedParams({ threadId: `${NODE}:t1`, projectId: `${other}:p1` }).nodes.sort()).toEqual(
      [NODE, other].sort()
    )
    expect(unqualifyRoutedParams({ threadId: `${NODE}:t1`, originThreadId: 'local' })).toMatchObject({
      hasLocal: true,
      nodes: [NODE]
    })
    expect(unqualifyRoutedParams({ reference: { kind: 'thread', threadId: `${NODE}:t1` } })).toMatchObject({
      params: { reference: { kind: 'thread', threadId: 't1' } },
      nodes: [NODE]
    })
    expect(unqualifyRoutedParams({ query: 'x' })).toMatchObject({ nodes: [], hasLocal: false })
    expect([...ROUTED_PARAM_THREAD_KEYS, ...ROUTED_PARAM_PROJECT_KEYS]).toContain('threadId')
  })

  it('qualifies the project a thread was started from with the computer that started it, not the owner', () => {
    const origin = newId('node')
    const result = qualifyRoutedResult(
      'threads.get',
      { thread: { id: 't1', projectId: 'p1', startedFrom: { node: origin, projectId: 'p9' } } },
      { node: NODE, self: origin }
    ) as { thread: { id: string; projectId: string; startedFrom: { projectId: string } } }
    expect(result.thread.id).toBe(`${NODE}:t1`)
    expect(result.thread.projectId).toBe(`${NODE}:p1`)
    // Started from this very computer: that project id is this computer's own, so it stays plain.
    expect(result.thread.startedFrom.projectId).toBe('p9')
    const third = newId('node')
    const away = qualifyRoutedResult(
      'threads.get',
      { thread: { id: 't1', startedFrom: { node: third, projectId: 'p9' } } },
      { node: NODE, self: origin }
    ) as { thread: { startedFrom: { projectId: string } } }
    expect(away.thread.startedFrom.projectId).toBe(`${third}:p9`)
  })

  it('qualifies the thread and project references in a message', () => {
    const data = encodeURIComponent(JSON.stringify([{ id: 'r', kind: 'thread', title: 'T', threadId: 'abc', projectId: 'def' }]))
    const content = `look\n[Mousse references data="${data}"]\n- thread: "T"\n  Thread ID: abc\n  Project ID: def\n[/Mousse references]`
    const out = qualifyRoutedEvent('thread.message', { message: { id: 'm', content } }, { node: NODE }) as {
      message: { content: string }
    }
    expect(out.message.content).toContain(`Thread ID: ${NODE}:abc`)
    expect(out.message.content).toContain(`Project ID: ${NODE}:def`)
    const decoded = /data="([^"]+)"/.exec(out.message.content)![1]
    expect(JSON.parse(decodeURIComponent(decoded))[0]).toMatchObject({ threadId: `${NODE}:abc`, projectId: `${NODE}:def` })
  })
})

describe('the walker', () => {
  let t: Awaited<ReturnType<typeof linked>>
  beforeAll(async () => {
    t = await linked()
  }, 120_000)

  it('leaves no owner thread or project id unqualified in results or events', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'routed-ids-')))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const project = t.owner.projects.openProject(dir)
    const parent = t.owner.threads.createThread('Parent', project.id, dir, { started: true })
    const child = t.owner.threads.createThread('Child', project.id, dir, {
      started: true,
      lineage: { parentThreadId: parent.id, rootThreadId: parent.id, relationship: 'subagent' } as never
    })
    t.owner.threads.updateThreadMeta(parent.id, { startedFrom: { node: t.callerNode, projectId: 'local-project' } }, { touch: false })

    const results: Array<[string, unknown]> = []
    const read = async (method: string, params: Record<string, unknown>) =>
      results.push([method, await t.dispatch(method, params)])
    for (const thread of [parent, child]) {
      const id = t.qualified(thread.id)
      await read('threads.get', { threadId: id })
      await read('thread.snapshot', { threadId: id })
      await read('queue.list', { threadId: id })
      await read('subagents.list', { threadId: id })
      await read('agents.list', { threadId: id })
      await read('tasks.list', { threadId: id })
      await read('activity.get', { threadId: id })
      await read('runs.list', { threadId: id })
      await read('orchestrator.pendingQuestions', { threadId: id })
      await read('threads.approvalRules', { threadId: id })
    }
    await read('projects.list', {})
    await read('threads.rename', { threadId: t.qualified(parent.id), name: 'Parent renamed' })
    await read('threads.settle', { threadId: t.qualified(child.id), settled: false })
    await read('threads.create', { node: t.node, name: 'Made here', projectId: t.qualified(project.id) })

    // Events the owner raises for the parent and its subagent.
    await t.dispatch('threads.focus', { threadId: t.qualified(parent.id) })
    const from = t.events.length
    t.owner.orchestrator.emit('thread-message', {
      threadId: parent.id,
      message: { id: 'm1', role: 'user', content: 'hi', timestamp: new Date().toISOString() }
    })
    t.owner.orchestrator.emit('queue-updated', { threadId: parent.id, items: [] })
    t.owner.orchestrator.emit('turn-started', { threadId: parent.id })
    t.owner.orchestrator.emit('turn-completed', { threadId: parent.id })
    t.owner.threads.updateThreadMeta(child.id, { name: 'Child renamed' })
    await vi.waitFor(() => expect(t.events.length - from).toBeGreaterThanOrEqual(4), { timeout: 10_000 })
    // A subagent's note and a question, as the owner's stream sends them.
    const attached = (t.router.attached as unknown as { apply(a: unknown, type: string, data: unknown, note: boolean): void; threads: Map<string, unknown> })
    const attachment = [...attached.threads.values()][0]
    attached.apply(attachment, 'subagents.updated', { parentThreadId: parent.id }, true)
    attached.apply(attachment, 'questions.updated', { threadId: parent.id, pending: [{ requestId: 'q', threadId: parent.id, questions: [] }] }, true)
    attached.apply(attachment, 'actions.updated', { threadId: parent.id }, true)

    const owned = [parent.id, child.id, project.id]
    const all = [...results.map(([, value]) => JSON.stringify(value)), ...t.events.slice(from).map((event) => JSON.stringify(event))]
    for (const text of all)
      for (const id of owned) {
        let at = text.indexOf(id)
        while (at >= 0) {
          // Every occurrence is the id of a qualified one: `<node>:<id>`.
          expect(text.slice(Math.max(0, at - NODE.length - 1), at), `${id} in ${text.slice(0, 200)}`).toBe(`${t.node}:`)
          at = text.indexOf(id, at + 1)
        }
      }
    // What it found is real: the parent's row, its subagent and the project were all seen.
    const joined = all.join('\n')
    for (const id of owned) expect(joined).toContain(`${t.node}:${id}`)
    // The record of who started the parent names a project of the caller, which stays its own.
    expect(joined).toContain('"projectId":"local-project"')
  }, 120_000)
})
