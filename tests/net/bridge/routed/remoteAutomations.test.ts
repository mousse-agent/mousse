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
