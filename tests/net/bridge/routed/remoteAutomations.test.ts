/**
 * Automations of another computer, over two real daemons linked by Bridge. An automation is stored and run only by
 * the computer that owns it: a window of the other computer adds and edits it there through the routed rows, and the
 * owner keeps to its own limits for that computer. No provider runs: every automation here runs on demand only.
 */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { NetError } from '../../../../src/shared/net'
import { cleanupAll, linked } from './routerFixture'

let t: Awaited<ReturnType<typeof linked>>
beforeAll(async () => {
  t = await linked()
}, 120_000)
afterAll(cleanupAll)

const folders: string[] = []
afterAll(() => { for (const path of folders) rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })
const folder = (): string => {
  const path = realpathSync(mkdtempSync(join(tmpdir(), 'remote-automations-')))
  folders.push(path)
  return path
}

const manual = (name: string, extra: Record<string, unknown> = {}) => ({ name, prompt: `Do ${name}`, schedule: { kind: 'manual' }, ...extra })

/** The owner as if its link went: every session with it is gone. */
async function whileOffline<T>(work: () => Promise<T>): Promise<T> {
  const real = t.caller.net.session.bind(t.caller.net)
  const spy = vi.spyOn(t.caller.net, 'session').mockImplementation((node) => {
    if (node === t.node) throw new NetError('peer_offline')
    return real(node)
  })
  try {
    return await work()
  } finally {
    spy.mockRestore()
  }
}

describe('one owning computer per automation', () => {
  it('adds an automation on the computer that owns it, and only there', async () => {
    const before = t.caller.scheduled.listJobs().length
    const project = t.owner.projects.openProject(folder())
    const created = await t.dispatch('scheduled.create', { node: t.node, input: manual('Remote audit', { projectId: t.qualified(project.id) }) })
    // The window gets the owner's job, named the way this computer names it.
    expect(created.job.id).toBe(t.qualified(created.job.id.split(':')[1]))
    expect(created.job.projectId).toBe(t.qualified(project.id))
    expect(created.jobs).toBeUndefined()
    const stored = t.owner.scheduled.getJob(created.job.id.split(':')[1])
    expect(stored).toMatchObject({ name: 'Remote audit', projectId: project.id })
    expect(t.caller.scheduled.listJobs()).toHaveLength(before)
  }, 60_000)

  it('edits it there by its qualified id', async () => {
    const { job } = await t.dispatch('scheduled.create', { node: t.node, input: manual('To rename') })
    const renamed = await t.dispatch('scheduled.update', { id: job.id, patch: { name: 'Renamed there' } })
    expect(renamed.job).toMatchObject({ id: job.id, name: 'Renamed there' })
    expect(t.owner.scheduled.getJob(job.id.split(':')[1])?.name).toBe('Renamed there')
  }, 60_000)

  it('holds the job to the limit the owner set for this computer', async () => {
    // The owner lets another computer run turns in Auto-accept edits at most (the default).
    const refused = await t.refused(t.dispatch('scheduled.create', { node: t.node, input: manual('Too wide', { permissionMode: 'full' }) }))
    expect(refused.message).toMatch(/cannot run above/)
    const { job } = await t.dispatch('scheduled.create', { node: t.node, input: manual('Held') })
    expect(t.owner.scheduled.getJob(job.id.split(':')[1])?.permissionCeiling).toBe('accept_edits')
    const wider = await t.refused(t.dispatch('scheduled.update', { id: job.id, patch: { permissionMode: 'full' } }))
    expect(wider.message).toMatch(/cannot run above/)
  }, 60_000)

  it('never runs or resumes an automation above the limit the owner set for this computer', async () => {
    // A person on the owner made it in Full access; this computer may run Auto-accept edits at most.
    const full = t.owner.scheduled.createJob({ name: 'Owner full', prompt: 'x', schedule: { kind: 'manual' }, permissionMode: 'full', permissionCeiling: 'full' })
    const run = await t.refused(t.dispatch('scheduled.run', { id: t.qualified(full.id) }))
    expect(run).toMatchObject({ code: 'permission_mode_above_ceiling', message: expect.stringMatching(/Full access/) })
    t.owner.scheduled.pauseJob(full.id)
    expect((await t.refused(t.dispatch('scheduled.resume', { id: t.qualified(full.id) }))).code).toBe('permission_mode_above_ceiling')
    expect(t.owner.scheduled.getJob(full.id)).toMatchObject({ state: 'paused' })
    expect(t.owner.scheduled.getJob(full.id)?.runHistory ?? []).toHaveLength(0)
    // Made while this computer could run Full access (in a Full access thread), then its limit was lowered.
    const fullThread = t.thread('Full here')
    t.owner.threads.updateThreadMeta(fullThread.id, { permissionMode: 'full' }, { touch: false })
    await t.owner.net.request('bridge.policy', { node: t.callerNode, maxPermissionMode: 'full' })
    let made: { id: string }
    try {
      made = (await t.dispatch('scheduled.create', { node: t.node, input: manual('Was allowed', { permissionMode: 'full', threadId: t.qualified(fullThread.id) }) })).job
      await t.dispatch('scheduled.pause', { id: made.id })
    } finally {
      await t.owner.net.request('bridge.policy', { node: t.callerNode, maxPermissionMode: 'accept_edits' })
    }
    expect((await t.refused(t.dispatch('scheduled.resume', { id: made.id }))).code).toBe('permission_mode_above_ceiling')
    expect((await t.refused(t.dispatch('scheduled.run', { id: made.id }))).code).toBe('permission_mode_above_ceiling')
    // One within the limit resumes as before.
    const { job: held } = await t.dispatch('scheduled.create', { node: t.node, input: manual('Within') })
    await t.dispatch('scheduled.pause', { id: held.id })
    expect((await t.dispatch('scheduled.resume', { id: held.id })).job).toMatchObject({ enabled: true })
  }, 60_000)

  it('never reaches a private thread through the pull request an automation wakes on', async () => {
    const secret = t.owner.threads.createThread('Secret PR', undefined, undefined, { started: true, localOnly: true })
    t.owner.threads.updateThreadMeta(secret.id, { pullRequest: { number: 77, url: 'https://example.com/pr/77', host: 'example.com', nameWithOwner: 'o/r', headRefName: 'f', baseRefName: 'main', headRepository: null, isCrossRepository: false, linkedAt: new Date().toISOString() } }, { touch: false })
    const owned = t.owner.scheduled.listJobs().length
    const wakeOn = { threadId: t.qualified(secret.id), events: ['review'] }
    // Without an output thread it would run in the private thread; with a new thread per run it would still name it.
    expect((await t.refused(t.dispatch('scheduled.create', { node: t.node, input: manual('On its PR', { threadEvent: wakeOn }) }))).code).toBe('thread_not_found')
    expect((await t.refused(t.dispatch('scheduled.create', { node: t.node, input: manual('On its PR, new thread', { threadEvent: wakeOn, createThread: true }) }))).code).toBe('thread_not_found')
    expect(t.owner.scheduled.listJobs()).toHaveLength(owned)
    // One the owner made that wakes on it stays on the owner: not listed, and not acted on.
    const watching = t.owner.scheduled.createJob({ name: 'Watches secret', prompt: 'x', schedule: { kind: 'manual' }, createThread: true, threadEvent: { threadId: secret.id, number: 77, events: ['review'] } })
    const index = await t.dispatch('automations.list', {})
    expect(index.items.some((item: { id: string }) => item.id === t.qualified(watching.id))).toBe(false)
    expect((await t.refused(t.dispatch('scheduled.update', { id: t.qualified(watching.id), patch: { name: 'Seen' } }))).code).toBe('job_not_found')
  }, 60_000)

  it('refuses what only the owner picks, and what another computer may not see', async () => {
    const saved = await t.refused(t.dispatch('scheduled.create', { node: t.node, input: manual('Saved agent', { agent: { definitionId: 'agent-1' } }) }))
    expect(saved.code).toBe('job_refused')
    const secret = t.owner.threads.createThread('Secret', undefined, undefined, { started: true, localOnly: true })
    const bound = t.owner.scheduled.createJob({ name: 'Private', prompt: 'x', schedule: { kind: 'manual' }, threadId: secret.id })
    expect((await t.refused(t.dispatch('scheduled.update', { id: t.qualified(bound.id), patch: { name: 'Seen' } }))).code).toBe('job_not_found')
    expect((await t.refused(t.dispatch('scheduled.create', { node: t.node, input: manual('In secret', { threadId: t.qualified(secret.id) }) }))).code).toBe('thread_not_found')
    // A project of this computer is not one of the owner's: one call names one computer.
    const mine = t.caller.projects.openProject(folder())
    expect((await t.refused(t.dispatch('scheduled.create', { node: t.node, input: manual('Mixed', { projectId: mine.id }) }))).code).toBe('mixed_computers')
  }, 60_000)

  it('fails with "<computer> is offline" while the owner is away, and keeps nothing here', async () => {
    const before = t.caller.scheduled.listJobs().length
    const owned = t.owner.scheduled.listJobs().length
    const refused = await whileOffline(() => t.refused(t.dispatch('scheduled.create', { node: t.node, input: manual('While away') })))
    expect(refused.code).toBe('computer_offline')
    expect(refused.message).toMatch(/ is offline\.$/)
    expect(t.caller.scheduled.listJobs()).toHaveLength(before)
    expect(t.owner.scheduled.listJobs()).toHaveLength(owned)
  }, 60_000)

  it('never falls back to this computer when routing is off', async () => {
    const before = t.caller.scheduled.listJobs().length
    t.routing(false)
    try {
      const refused = await t.refused(t.dispatch('scheduled.create', { node: t.node, input: manual('No fallback') }))
      expect(refused.code).toBe('computer_offline')
      const { job } = await (async () => { t.routing(true); try { return await t.dispatch('scheduled.create', { node: t.node, input: manual('Back') }) } finally { t.routing(false) } })()
      expect((await t.refused(t.dispatch('scheduled.update', { id: job.id, patch: { name: 'Here?' } }))).code).toBe('computer_offline')
    } finally {
      t.routing(true)
    }
    expect(t.caller.scheduled.listJobs()).toHaveLength(before)
  }, 60_000)
})

describe('the merged list', () => {
  it('lists the other computer’s automations after this one’s, with its computer and zone', async () => {
    const weekly = t.owner.scheduled.createJob({ name: 'Deps bump', prompt: 'bump', schedule: { kind: 'cron', expr: '0 3 * * 1' } })
    const secret = t.owner.threads.createThread('Hidden', undefined, undefined, { started: true, localOnly: true })
    const hidden = t.owner.scheduled.createJob({ name: 'Hidden', prompt: 'x', schedule: { kind: 'manual' }, threadId: secret.id })
    const mine = t.caller.scheduled.createJob({ name: 'Mine', prompt: 'x', schedule: { kind: 'manual' } })
    const index = await t.dispatch('automations.list', {})
    const row = index.items.find((item: { id: string }) => item.id === t.qualified(weekly.id))
    expect(row).toMatchObject({
      key: `job:${t.qualified(weekly.id)}`,
      link: { kind: 'job', jobId: t.qualified(weekly.id) },
      computer: { node: t.node, local: false, timeZone: expect.any(String) },
      next: { at: expect.any(String) }
    })
    expect(row.computer.offline).toBeUndefined()
    // This computer's rows come first and say so.
    expect(index.items.find((item: { id: string }) => item.id === mine.id)).toMatchObject({ computer: { local: true } })
    // A private thread's automation stays on its computer.
    expect(index.items.some((item: { id: string }) => item.id === t.qualified(hidden.id))).toBe(false)
    expect(index.computers).toEqual([expect.objectContaining({ node: t.node, local: false })])
    // The record that edits it, named the same way.
    expect(index.remoteJobs.find((job: { id: string }) => job.id === t.qualified(weekly.id))).toMatchObject({ name: 'Deps bump' })
    // The CLI gets this computer's list only.
    const cli = await t.dispatch('automations.list', {}, t.connection('cli-1', 'cli'))
    expect(cli.items.some((item: { computer: { local: boolean } }) => !item.computer.local)).toBe(false)
  }, 60_000)

  it('keeps an offline computer’s rows from its last copy, waiting with the reason offline', async () => {
    const weekly = t.owner.scheduled.createJob({ name: 'Weekly while away', prompt: 'x', schedule: { kind: 'cron', expr: '0 3 * * 1' } })
    await t.dispatch('automations.list', {})
    const index = await whileOffline(() => t.dispatch('automations.list', {}))
    const row = index.items.find((item: { id: string }) => item.id === t.qualified(weekly.id))
    expect(row).toMatchObject({ computer: { node: t.node, offline: true, seenAt: expect.any(String) }, active: { state: 'waiting', reason: 'offline' } })
    expect(index.computers[0]).toMatchObject({ offline: true })
    // The copy is on disk: a restart of this computer still lists it while the other is away.
    const remote = t.caller.remoteAutomations as unknown as { cache?: unknown }
    remote.cache = undefined
    const again = await whileOffline(() => t.dispatch('automations.list', {}))
    expect(again.items.some((item: { id: string }) => item.id === t.qualified(weekly.id))).toBe(true)
  }, 60_000)

  it('keeps nothing of another computer while routing is off', async () => {
    t.routing(false)
    try {
      const index = await t.dispatch('automations.list', {})
      expect(index.items.some((item: { computer: { local: boolean } }) => !item.computer.local)).toBe(false)
    } finally {
      t.routing(true)
    }
  }, 60_000)
})
