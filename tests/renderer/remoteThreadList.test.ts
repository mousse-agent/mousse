import { afterEach, describe, expect, it } from 'vitest'
import type { Device } from '../../src/renderer/lib/netDevices'
import {
  refreshRemoteListedThreads,
  remoteRowActivity,
  sidebarRemoteThreads,
  startedElsewhere,
  useRemoteListedThreads,
  type RemoteListedThread
} from '../../src/renderer/lib/remoteThreadList'
import { remoteThreadKey, type RemoteThreadEntry } from '../../src/renderer/lib/remoteThreadStore'
import type { Thread } from '../../src/shared/types'

const self = 'nod_00000000000000000000000001' as const
const studio = 'nod_00000000000000000000000002' as const
const linux = 'nod_00000000000000000000000003' as const
const phone = 'nod_00000000000000000000000004' as const

const device = (node: Device['node'], name: string, over: Partial<Device> = {}): Device =>
  ({ node, name, caps: [], keyEpoch: 1, expiresAt: 0, self: false, revoked: false, state: 'open', ...over }) as Device
const thread = (id: string, over: Partial<Thread> = {}): Thread =>
  ({ id, name: `Thread ${id}`, createdAt: '2026-10-27T10:00:00Z', updatedAt: '2026-10-27T10:00:00Z', startedAt: '2026-10-27T10:00:00Z', ...over }) as Thread

afterEach(() => useRemoteListedThreads.setState({ threads: [] }))

describe('the status a sidebar row shows for an attached thread', () => {
  const view = (over: Record<string, unknown> = {}) =>
    ({ thread: thread('t'), messages: [], active: false, queued: 0, questions: 0, ...over }) as never
  const pause = { until: '2026-10-28T09:00:00Z', estimated: true, autoResume: true }

  it('shows nothing for an idle or unattached thread', () => {
    expect(remoteRowActivity(undefined)).toEqual({})
    expect(remoteRowActivity({ view: view(), sending: false })).toEqual({})
  })

  it('shows working while a turn or a message of this window runs', () => {
    expect(remoteRowActivity({ view: view({ active: true }), sending: false })).toEqual({ activity: 'processing' })
    expect(remoteRowActivity({ view: undefined, sending: true })).toEqual({ activity: 'processing' })
  })

  it('shows a question as waiting for input, ahead of everything else', () => {
    expect(remoteRowActivity({ view: view({ active: true, questions: 1 }), sending: true })).toEqual({ activity: 'awaiting_input' })
    // What the target last answered replaces the count the display carried when it attached.
    expect(remoteRowActivity({ view: view({ questions: 1 }), sending: false, questions: 0 })).toEqual({})
    expect(remoteRowActivity({ view: view(), sending: false, questions: 2 })).toEqual({ activity: 'awaiting_input' })
  })

  it('shows a run a usage limit paused, with when it resets, and not once the turn works again', () => {
    expect(remoteRowActivity({ view: view({ paused: pause }), sending: false })).toEqual({ activity: 'paused', pause })
    expect(remoteRowActivity({ view: view({ paused: pause, active: true }), sending: false })).toEqual({ activity: 'processing' })
  })
})

describe('threads started from another device', () => {
  it('lists a computer\'s threads that another device started, with this computer\'s project only for its own', () => {
    const rows = startedElsewhere([
      thread('mine', { startedFrom: { node: self, projectId: 'p-here' }, worktreeEnabled: true }),
      thread('theirs', { startedFrom: { node: linux, projectId: 'p-linux' } }),
      thread('local'),
      thread('settled', { startedFrom: { node: self }, settledAt: '2026-10-27T11:00:00Z' }),
      thread('draft', { startedFrom: { node: self }, name: 'New Thread', startedAt: undefined }),
      thread('child', { startedFrom: { node: self }, lineage: { parentThreadId: 'mine' } as Thread['lineage'] })
    ], device(studio, 'Studio Mac'), self)
    expect(rows).toEqual([
      { key: remoteThreadKey({ nodeId: studio, entityId: 'mine' }), ref: { nodeId: studio, entityId: 'mine' }, deviceName: 'Studio Mac', name: 'Thread mine', updatedAt: '2026-10-27T10:00:00Z', worktreeEnabled: true, localProjectId: 'p-here' },
      { key: remoteThreadKey({ nodeId: studio, entityId: 'theirs' }), ref: { nodeId: studio, entityId: 'theirs' }, deviceName: 'Studio Mac', name: 'Thread theirs', updatedAt: '2026-10-27T10:00:00Z' }
    ])
  })

  it('reads every connected computer, keeps the last rows of one that fails, and skips phones and offline ones', async () => {
    const devices = [
      device(self, 'This Mac', { self: true }),
      device(studio, 'Studio Mac'),
      device(linux, 'Linux box'),
      device(phone, 'Phone', { kind: 'phone' }),
      device('nod_00000000000000000000000005', 'Offline', { state: 'closed' })
    ]
    const asked: string[] = []
    let failLinux = false
    const deps = {
      devices: async () => devices,
      threads: async (node: string) => {
        asked.push(node)
        if (node === linux && failLinux) throw new Error('timeout')
        return [thread(`on-${node.slice(-1)}`, { startedFrom: { node: phone } })]
      },
      current: () => true
    }
    await refreshRemoteListedThreads(deps)
    expect(asked.sort()).toEqual([studio, linux].sort())
    expect(useRemoteListedThreads.getState().threads.map((row) => row.deviceName).sort()).toEqual(['Linux box', 'Studio Mac'])
    failLinux = true
    await refreshRemoteListedThreads(deps)
    expect(useRemoteListedThreads.getState().threads).toHaveLength(2)
    // A computer that is no longer connected drops its rows.
    devices[2] = device(linux, 'Linux box', { state: 'closed' })
    await refreshRemoteListedThreads(deps)
    expect(useRemoteListedThreads.getState().threads.map((row) => row.deviceName)).toEqual(['Studio Mac'])
  })

  it('drops an answer that arrives after the profile changed', async () => {
    await refreshRemoteListedThreads({
      devices: async () => [device(studio, 'Studio Mac')],
      threads: async () => [thread('late', { startedFrom: { node: self } })],
      current: () => false
    })
    expect(useRemoteListedThreads.getState().threads).toEqual([])
  })
})

describe('sidebar placement', () => {
  const listed = (id: string, updatedAt: string, localProjectId?: string): RemoteListedThread => ({
    key: remoteThreadKey({ nodeId: studio, entityId: id }), ref: { nodeId: studio, entityId: id }, deviceName: 'Studio Mac',
    name: `Listed ${id}`, updatedAt, ...(localProjectId ? { localProjectId } : {})
  })
  const entry = (id: string, localProjectId?: string): RemoteThreadEntry => ({
    key: remoteThreadKey({ nodeId: studio, entityId: id }), ref: { nodeId: studio, entityId: id }, deviceName: 'Studio Mac',
    title: `Attached ${id}`, ...(localProjectId ? { localProjectId } : {}), live: false, error: '', sending: false, notice: '', attachment: 0
  })

  it('puts attached threads first, then listed ones by last update, each under its local project or with the project-less chats', () => {
    const a = entry('a', 'project-here'), b = entry('b')
    const placed = sidebarRemoteThreads(
      { [a.key]: a, [b.key]: b },
      [a.key, b.key, 'nod_missing:x'],
      [listed('old', '2026-10-27T08:00:00Z', 'project-here'), listed('b', '2026-10-27T12:00:00Z', 'project-here'), listed('new', '2026-10-27T09:00:00Z', 'project-gone')],
      new Set(['project-here'])
    )
    expect(placed.all.map((row) => row.ref.entityId)).toEqual(['b', 'a', 'new', 'old'])
    // An attached thread takes the project its listing knows when it was opened without one.
    expect(placed.byProject.get('project-here')?.map((row) => row.ref.entityId)).toEqual(['b', 'a', 'old'])
    // A project removed from this computer no longer holds its remote threads.
    expect(placed.unfiled.map((row) => row.ref.entityId)).toEqual(['new'])
    expect(placed.all.map((row) => Boolean(row.entry))).toEqual([true, true, false, false])
  })
})
