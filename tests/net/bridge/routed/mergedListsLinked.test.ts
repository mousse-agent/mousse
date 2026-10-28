/**
 * The merged lists over a real link: two daemons, the owner's private lists stream, and what a window of
 * the other computer is given.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanupAll, linked } from './routerFixture'

afterAll(cleanupAll)

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', ...args], {
    cwd,
    encoding: 'utf8'
  }).trim()
const folders: string[] = []
afterAll(() => {
  for (const path of folders)
    rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})
const folder = (): string => {
  const path = realpathSync(mkdtempSync(join(tmpdir(), 'merged-linked-')))
  folders.push(path)
  return path
}

describe('another computer’s lists over a real link', () => {
  let t: Awaited<ReturnType<typeof linked>>
  const lists = () => t.caller.bridge.lists
  beforeAll(async () => {
    t = await linked()
  }, 120_000)

  it('list its threads and projects with qualified ids, and keep them when a local thread is renamed or created', async () => {
    const repo = folder()
    git(repo, 'init', '-q')
    git(repo, 'commit', '-q', '--allow-empty', '-m', `root ${Math.random()}`)
    const project = t.owner.projects.openProject(repo)
    const inProject = t.owner.threads.createThread('In a project', project.id, repo, {})
    const alone = t.owner.threads.createThread('On its own')
    await lists().reconcile()
    await vi.waitFor(
      () =>
        expect(
          lists()
            .threads()
            .map((row) => row.id)
            .sort()
        ).toEqual([t.qualified(alone.id), t.qualified(inProject.id)].sort()),
      {
        timeout: 20_000
      }
    )
    const row = lists()
      .threads()
      .find((entry) => entry.id === t.qualified(inProject.id))!
    expect(row).toMatchObject({
      name: 'In a project',
      node: t.node,
      projectId: t.qualified(project.id)
    })
    expect(lists().projects()).toMatchObject([
      { id: t.qualified(project.id), node: t.node, name: expect.any(String) }
    ])

    // `threads.list` of a window has them after this computer's own.
    const local = t.caller.threads.createThread('Mine')
    const listed = await t.dispatch('threads.list', {})
    expect(listed.threads.map((entry: { id: string }) => entry.id)).toEqual(
      expect.arrayContaining([local.id, t.qualified(alone.id), t.qualified(inProject.id)])
    )
    // A local rename, create and pin each return the complete list, with the rows of the other computer in it.
    for (const [method, params] of [
      ['threads.rename', { threadId: local.id, name: 'Renamed' }],
      ['threads.pin', { threadId: local.id, pinned: true }],
      ['threads.create', { name: 'Another of mine' }]
    ] as const) {
      const result = await t.dispatch(method, params)
      const ids = result.threads.map((entry: { id: string }) => entry.id)
      expect(ids, method).toEqual(
        expect.arrayContaining([t.qualified(alone.id), t.qualified(inProject.id)])
      )
    }
    // The list a project asks for gets only that project's remote rows.
    const projectList = await t.dispatch('threads.list', { projectId: t.qualified(project.id) })
    expect(projectList.threads.map((entry: { id: string }) => entry.id)).toEqual([
      t.qualified(inProject.id)
    ])
    // A subagent of the other computer is listed under its parent, with the lineage named by qualified ids.
    const child = t.owner.threads.createThread('A subagent', project.id, repo, {})
    t.owner.threads.updateThreadMeta(child.id, {
      lineage: {
        parentThreadId: inProject.id,
        rootThreadId: inProject.id,
        relationship: 'subagent'
      }
    } as never)
    await vi.waitFor(
      () =>
        expect(
          lists()
            .threads()
            .find((entry) => entry.id === t.qualified(child.id))?.lineage
        ).toEqual({
          parentThreadId: t.qualified(inProject.id),
          rootThreadId: t.qualified(inProject.id),
          relationship: 'subagent'
        }),
      { timeout: 20_000 }
    )
  }, 90_000)

  it('shows what the threads are doing, and a change on the other computer reaches the window as it happens', async () => {
    const thread = t.owner.threads.createThread('Working')
    await vi.waitFor(
      () =>
        expect(
          lists()
            .threads()
            .some((row) => row.id === t.qualified(thread.id))
        ).toBe(true),
      { timeout: 20_000 }
    )
    const from = t.events.length
    t.owner.threadRuntimes.setActivity(thread.id, 'processing')
    await vi.waitFor(() => expect(lists().activity()[t.qualified(thread.id)]).toBe('processing'), {
      timeout: 20_000
    })
    const snapshots = t.events.slice(from).filter((event) => event.type === 'activity.snapshot')
    expect(snapshots.length).toBeGreaterThan(0)
    // The window's `activity.snapshot` method has it too.
    const asked = await t.dispatch('activity.snapshot', {})
    expect(asked.activity[t.qualified(thread.id)]).toBe('processing')
    // Not told as a notification: this computer never touched the thread.
    expect(
      t.events
        .slice(from)
        .filter((event) => event.type === 'activity' && event.threadId === t.qualified(thread.id))
    ).toHaveLength(0)
    // A thread this computer opened does notify.
    lists().noteOpened(t.qualified(thread.id))
    t.owner.threadRuntimes.setActivity(thread.id, 'completed')
    await vi.waitFor(
      () =>
        expect(
          t.events
            .filter(
              (event) => event.type === 'activity' && event.threadId === t.qualified(thread.id)
            )
            .map((event) => event.data.state)
        ).toEqual(['completed']),
      { timeout: 20_000 }
    )
  }, 90_000)

  it('moves a thread to the front when a person sends in it from here, and tells once when it completes', async () => {
    const first = t.owner.threads.createThread('Sent in from here')
    const second = t.owner.threads.createThread('Left alone')
    await vi.waitFor(
      () =>
        expect(
          [first, second].every((thread) =>
            lists()
              .threads()
              .some((row) => row.id === t.qualified(thread.id))
          )
        ).toBe(true),
      { timeout: 20_000 }
    )
    const send = vi
      .spyOn(t.owner.orchestrator, 'send')
      .mockResolvedValue({ message: '', actions: [], runId: 'run-x', accepted: true } as never)
    try {
      await t.dispatch('orchestrator.send', {
        threadId: t.qualified(first.id),
        content: 'hello',
        requestId: `req-${first.id}`,
        source: 'gui'
      })
    } finally {
      send.mockRestore()
    }
    const order = (thread: { id: string }) =>
      lists()
        .threads()
        .find((row) => row.id === t.qualified(thread.id))!.order
    const others = lists()
      .threads()
      .filter((row) => row.id !== t.qualified(first.id) && !row.projectId)
    expect(order(first)).toBeLessThan(Math.min(...others.map((row) => row.order)))
    const from = t.events.length
    t.owner.threadRuntimes.setActivity(first.id, 'processing')
    t.owner.threadRuntimes.setActivity(second.id, 'processing')
    await vi.waitFor(() => expect(lists().activity()[t.qualified(first.id)]).toBe('processing'), {
      timeout: 20_000
    })
    t.owner.threadRuntimes.setActivity(first.id, 'completed')
    t.owner.threadRuntimes.setActivity(second.id, 'completed')
    await vi.waitFor(() => expect(lists().activity()[t.qualified(second.id)]).toBe('completed'), {
      timeout: 20_000
    })
    await vi.waitFor(() => expect(lists().activity()[t.qualified(first.id)]).toBe('completed'), {
      timeout: 20_000
    })
    const told = t.events
      .slice(from)
      .filter((event) => event.type === 'activity' && event.data.state === 'completed')
      .map((event) => event.threadId)
    // The one this computer sent in notifies, once; the one it never touched does not.
    expect(told).toEqual([t.qualified(first.id)])
  }, 90_000)

  it('names a project of this computer as the same repository when the Git history matches', async () => {
    const original = folder()
    git(original, 'init', '-q')
    git(original, 'commit', '-q', '--allow-empty', '-m', `root ${Math.random()}`)
    git(original, 'remote', 'add', 'origin', 'https://example.com/org/same.git')
    const clone = join(folder(), 'clone')
    git(original, 'clone', '-q', original, clone)
    git(clone, 'remote', 'set-url', 'origin', 'https://example.com/org/same.git')
    const mine = t.caller.projects.openProject(original)
    const theirs = t.owner.projects.openProject(clone)
    await vi.waitFor(
      () =>
        expect(
          lists()
            .projects()
            .some((project) => project.id === t.qualified(theirs.id))
        ).toBe(true),
      { timeout: 20_000 }
    )
    await vi.waitFor(
      () =>
        expect(
          lists()
            .projects()
            .find((project) => project.id === t.qualified(theirs.id))?.sameAs
        ).toBe(mine.id),
      { timeout: 30_000 }
    )
  }, 90_000)

  it('is searched together with this computer, and Recently deleted lists its trash', async () => {
    const thread = t.owner.threads.createThread('Findable elsewhere zebra')
    t.owner.threads.updateThreadMeta(thread.id, { startedAt: new Date().toISOString() } as never)
    t.caller.threads.createThread('Findable here zebra')
    const scan = vi.spyOn(t.owner.threads, 'searchThreads')
    const found = await t.dispatch('threads.search', { query: 'zebra', limit: 20 })
    // The other computer reads the transcripts of its newest threads only for a search asked from here.
    expect(scan.mock.calls.at(-1)?.[2]).toMatchObject({
      hideSubagents: true,
      maxMessageThreads: 100
    })
    scan.mockRestore()
    expect(found.results.map((result: { threadName: string }) => result.threadName).sort()).toEqual(
      expect.arrayContaining(['Findable elsewhere zebra'])
    )
    const remote = found.results.find(
      (result: { threadName: string }) => result.threadName === 'Findable elsewhere zebra'
    )
    expect(remote).toMatchObject({ threadId: t.qualified(thread.id), node: t.node })
    expect(found.skipped).toBeUndefined()

    // Trash it on the other computer: its Recently deleted record is listed here, by qualified id and without its folders.
    await t.dispatch('threads.delete', { threadId: t.qualified(thread.id) })
    // Storage settings ask about this computer alone, and do not wait for the others.
    const asked = vi.spyOn(t.client(), 'call')
    const own = await t.dispatch('threads.inventory', {})
    expect(own.lifecycles.some((entry: { node?: string }) => entry.node)).toBe(false)
    expect(asked.mock.calls.filter((call) => call[1] === 'threads.inventory')).toHaveLength(0)
    asked.mockRestore()
    const trash = await t.dispatch('threads.inventory', { includeComputers: true })
    const record = trash.lifecycles.find(
      (entry: { taskId: string }) => entry.taskId === t.qualified(thread.id)
    )
    expect(record).toMatchObject({ node: t.node, state: 'trashed', location: '' })
    expect(trash.taskNames[t.qualified(thread.id)]).toBe('Findable elsewhere zebra')
  }, 90_000)

  it('says which computer a search could not ask when it refuses this device', async () => {
    await t.owner.net.request('bridge.workOnThreads', { enabled: false })
    try {
      const found = await t.dispatch('threads.search', { query: 'zebra', limit: 20 })
      // It said no: that is "stopped sharing", not "offline".
      expect(found.skipped).toEqual([{ node: t.node, name: expect.any(String), reason: 'refused' }])
      // Its rows stay listed, marked not shared (its stream ended with a refusal).
      await vi.waitFor(
        () =>
          expect(
            lists()
              .threads()
              .every((row) => row.notShared === true)
          ).toBe(true),
        {
          timeout: 20_000
        }
      )
      expect(lists().threads().length).toBeGreaterThan(0)
      expect(
        lists()
          .threads()
          .some((row) => row.offline)
      ).toBe(false)
    } finally {
      await t.owner.net.request('bridge.workOnThreads', { enabled: true })
      // The stream the owner ended is opened again as soon as it is asked for, not after the next wait.
      lists().nodeOnline(t.node)
    }
  }, 60_000)

  it('places a row of the other computer where a drag leaves it among this computer’s own', async () => {
    const group = () =>
      t.caller.threads.listAllThreads().filter((row) => !row.projectId && !row.lineage)
    const mine = group()
    const remote = t.owner.threads.createThread('Dragged')
    await vi.waitFor(
      () =>
        expect(
          lists()
            .threads()
            .some((row) => row.id === t.qualified(remote.id))
        ).toBe(true),
      { timeout: 20_000 }
    )
    // The group as the sidebar sends it: this computer's rows in a new order, the remote one between the first two.
    const ordered = [...mine].sort((a, b) => b.order - a.order).map((row) => row.id)
    ordered.splice(1, 0, t.qualified(remote.id))
    const result = await t.dispatch('threads.reorder', { threadIds: ordered })
    const inGroup = (result.all as Array<{ id: string; order: number; projectId?: string }>)
      .filter((row) => ordered.includes(row.id))
      .sort((a, b) => a.order - b.order)
    expect(inGroup.map((row) => row.id)).toEqual(ordered)
    // The other computer's own order is not touched, and the place survives the next snapshot from it.
    t.owner.threads.updateThreadMeta(remote.id, { name: 'Dragged and renamed' })
    await vi.waitFor(
      () =>
        expect(
          lists()
            .threads()
            .find((row) => row.id === t.qualified(remote.id))?.name
        ).toBe('Dragged and renamed'),
      { timeout: 20_000 }
    )
    const after = [...t.caller.threads.listAllThreads(), ...lists().threads()]
      .filter((row) => ordered.includes(row.id))
      .sort((a, b) => a.order - b.order)
    expect(after.map((row) => row.id)).toEqual(ordered)
  }, 60_000)

  it('puts this computer’s own thread in front of a remote row that went to the front, on a send and on a create', async () => {
    const mine = t.caller.threads.createThread('Mine, in front')
    const remote = t.owner.threads.createThread('Theirs, sent in from here')
    await vi.waitFor(
      () =>
        expect(
          lists()
            .threads()
            .some((row) => row.id === t.qualified(remote.id))
        ).toBe(true),
      {
        timeout: 20_000
      }
    )
    // The remote thread goes to the front of the standalone group on a send from here.
    lists().noteSent(t.qualified(remote.id))
    const remoteOrder = () =>
      lists()
        .threads()
        .find((row) => row.id === t.qualified(remote.id))!.order
    // A send in this computer's own thread at the front of its own rows puts it in front of the remote row.
    t.caller.threads.touchThreadUserActivity(mine.id)
    expect(t.caller.threads.getThread(mine.id)!.order).toBeLessThan(remoteOrder())
    // And a new thread of this computer starts in front of every row of the group, remote ones included.
    const fresh = t.caller.threads.createThread('Brand new')
    expect(fresh.order).toBeLessThan(remoteOrder())
    expect(fresh.order).toBeLessThan(t.caller.threads.getThread(mine.id)!.order)
    // A row of another project is not in this group.
    expect(t.caller.threads.remoteFloor?.('some-project')).toBeUndefined()
  }, 60_000)

  it('does not list a phone, and lists a computer again when its kind is computer', async () => {
    // On the owner, which is the authority: the caller is a computer; marking it a phone takes it out.
    const ownerLists = t.owner.bridge.router
    expect(ownerLists.pairedComputers()?.map((row) => row.node)).toContain(t.callerNode)
    await t.owner.net.request('bridge.setKind', { node: t.callerNode, kind: 'phone' })
    expect(ownerLists.pairedComputers()?.map((row) => row.node) ?? []).not.toContain(t.callerNode)
    await t.owner.net.request('bridge.setKind', { node: t.callerNode, kind: 'computer' })
    // A phone loses "Works on threads"; the computer gets it back.
    await t.owner.net.request('bridge.setCaps', {
      node: t.callerNode,
      caps: ['read', 'chat', 'write', 'settings']
    })
    expect(ownerLists.pairedComputers()?.map((row) => row.node)).toContain(t.callerNode)
    // A device this computer blocks is not listed either.
    await t.owner.net.request('bridge.policy', { node: t.callerNode, blocked: true })
    try {
      expect(ownerLists.pairedComputers()?.map((row) => row.node) ?? []).not.toContain(t.callerNode)
    } finally {
      await t.owner.net.request('bridge.policy', { node: t.callerNode, blocked: false })
    }
  }, 60_000)

  it('keeps the other computers’ projects in the list a clone returns', async () => {
    const path = folder()
    const clone = vi.spyOn(t.caller.gitService.github, 'cloneRepository').mockResolvedValue(path)
    try {
      const result = await t.dispatch('github.cloneRepository', {
        repository: 'org/app',
        destination: path
      })
      expect(result.projects.some((project: { node?: string }) => project.node === t.node)).toBe(
        true
      )
    } finally {
      clone.mockRestore()
    }
  }, 60_000)

  it('adds nothing and changes nothing with the routing flag off', async () => {
    t.routing(false)
    try {
      await lists().reconcile()
      expect(lists().threads()).toEqual([])
      const listed = await t.dispatch('threads.list', {})
      expect(listed.threads.every((entry: { node?: string }) => entry.node === undefined)).toBe(
        true
      )
      const found = await t.dispatch('threads.search', { query: 'zebra' })
      expect(found.skipped).toBeUndefined()
    } finally {
      t.routing(true)
    }
  }, 60_000)
})
