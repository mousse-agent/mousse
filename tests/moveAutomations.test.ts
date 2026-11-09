/**
 * Move to computer with the other computer faked: what happens here and there when it refuses, when its answer is
 * lost after it made the copy, when turning the copy on fails, and across a restart in the middle of a move.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MovedAutomationStore } from '../src/mms/automations/MovedAutomations'
import { moveAutomations, type MoveDeps } from '../src/mms/automations/moveAutomations'
import { DomainRpcError } from '../src/mms/protocol/domainRegistry'
import type { RemoteAutomationsPort } from '../src/mms/protocol/remoteAutomationsPort'
import type { CreateScheduledJobInput, ScheduledJob } from '../src/shared/types'

const NODE = 'node-b'
const homes: string[] = []
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }) })

function job(extra: Partial<ScheduledJob> = {}): ScheduledJob {
  return { id: 'j1', name: 'Audit', prompt: 'audit', schedule: { kind: 'cron', expr: '0 3 * * 1' }, enabled: true, state: 'scheduled', nextRunAt: '2026-11-16T03:00:00.000Z', runHistory: [], createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z', ...extra } as ScheduledJob
}

/** The other computer: it keeps what it made by idempotency key, like the owner's ledger, and can fail on purpose. */
function otherComputer() {
  const made = new Map<string, ScheduledJob & { input: CreateScheduledJobInput }>()
  const resumed: string[] = []
  const faults: { create?: 'refuse' | 'lose' ; resume?: boolean } = {}
  let seq = 0
  const remote: RemoteAutomationsPort = {
    read: async () => [],
    computers: () => [{ node: NODE, name: 'Laptop', online: true }, { node: 'node-c', name: 'Desktop', online: true }],
    matchProject: async () => ({ projectId: 'their-project', weak: false }),
    create: async (_node, input, options) => {
      if (faults.create === 'refuse') throw new DomainRpcError('scheduled_job_refused', 'A job cannot run above the mode its creator holds.')
      const key = options?.idem ?? `x${seq++}`
      let copy = made.get(key)
      if (!copy) {
        copy = { ...job({ id: `there-${made.size + 1}`, name: input.name, enabled: !input.paused, state: input.paused ? 'paused' : 'scheduled' }), input }
        made.set(key, copy)
      }
      if (faults.create === 'lose') throw new DomainRpcError('outcome_uncertain', 'Laptop did not confirm this.')
      return copy
    },
    resume: async (_node, jobId) => {
      if (faults.resume) throw new DomainRpcError('outcome_uncertain', 'Laptop did not confirm this.')
      resumed.push(jobId)
      const copy = [...made.values()].find((entry) => entry.id === jobId)
      if (copy) Object.assign(copy, { enabled: true, state: 'scheduled' })
    }
  }
  return { remote, made, resumed, faults }
}

/** This computer: its jobs in memory, its moves on disk (so a "restart" reads them again). */
function here(jobs: ScheduledJob[], remote: RemoteAutomationsPort, home?: string) {
  const dir = home ?? mkdtempSync(join(tmpdir(), 'move-automations-'))
  if (!home) homes.push(dir)
  const store = new MovedAutomationStore(dir)
  const byId = new Map(jobs.map((entry) => [entry.id, entry]))
  let tick = 0
  const deps: MoveDeps = {
    remote,
    getJob: (id) => byId.get(id),
    project: () => ({ name: 'repo', path: '/repo' }),
    pause: (id, reason) => { const entry = byId.get(id)!; Object.assign(entry, { enabled: false, state: 'paused', pausedReason: reason, pausedAt: `2026-11-09T00:00:0${tick++}.000Z` }) },
    resume: (id) => { const entry = byId.get(id)!; Object.assign(entry, { enabled: true, state: 'scheduled', pausedReason: undefined, pausedAt: undefined }) },
    remove: (id) => byId.delete(id),
    keepHistory: (entry) => store.add(entry),
    transfers: { get: (id) => store.transfer(id), begin: (entry) => store.begin(entry), end: (id) => store.end(id) },
    defaultMode: () => 'accept_edits'
  }
  return { deps, byId, store, dir }
}

describe('Move to computer', () => {
  it('makes the copy paused in one step, removes it here, then turns it on there because it was on', async () => {
    const other = otherComputer()
    const local = here([job({ keys: ['GITHUB_TOKEN'], cliName: 'audit', schedule: { kind: 'manual' } })], other.remote)
    const result = await moveAutomations(local.deps, ['j1'], NODE)
    expect(result).toEqual({ moved: [{ id: 'j1', to: `${NODE}:there-1` }], failed: [] })
    const [copy] = [...other.made.values()]
    // Made paused: it could not fire before the move was confirmed.
    expect(copy.input.paused).toEqual({ reason: 'Moving here' })
    expect(copy.input).toMatchObject({ keys: ['GITHUB_TOKEN'], cliName: 'audit', permissionMode: 'accept_edits' })
    expect(other.resumed).toEqual(['there-1'])
    expect(local.byId.has('j1')).toBe(false)
    expect(local.store.transfer('j1')).toBeUndefined()
    expect(local.store.list()).toEqual([expect.objectContaining({ id: 'j1', movedTo: { node: NODE, name: 'Laptop', jobId: 'there-1' } })])
  })

  it('keeps a paused automation paused there, with its reason and end, and never turns it on', async () => {
    const other = otherComputer()
    const local = here([job({ enabled: false, state: 'paused', pausedReason: 'Holiday', pausedAt: '2026-11-01T00:00:00.000Z', resumeAt: '2026-12-01T00:00:00.000Z' })], other.remote)
    const result = await moveAutomations(local.deps, ['j1'], NODE)
    expect(result.moved).toHaveLength(1)
    expect([...other.made.values()][0].input.paused).toEqual({ reason: 'Holiday', until: '2026-12-01T00:00:00.000Z' })
    expect(other.resumed).toEqual([])
  })

  it('sends the mode it ran in here, never wider: a stricter ceiling goes with it', async () => {
    const other = otherComputer()
    const local = here([job({ id: 'a', permissionCeiling: 'ask' }), job({ id: 'b', permissionMode: 'full', permissionCeiling: 'auto' })], other.remote)
    await moveAutomations(local.deps, ['a', 'b'], NODE)
    expect([...other.made.values()].map((copy) => copy.input.permissionMode)).toEqual(['ask', 'auto'])
  })

  it('refuses an automation an agent added: its access limits stay on this computer', async () => {
    const other = otherComputer()
    const local = here([job({ createdBy: { threadId: 't1' } as ScheduledJob['createdBy'], accessCap: 'read_only' as ScheduledJob['accessCap'] })], other.remote)
    const result = await moveAutomations(local.deps, ['j1'], NODE)
    expect(result.failed).toEqual([{ id: 'j1', name: 'Audit', error: expect.stringMatching(/agent added it/) }])
    expect(other.made.size).toBe(0)
    expect(local.byId.get('j1')).toMatchObject({ enabled: true, state: 'scheduled' })
  })

  it('leaves it here as it was when the other computer refuses', async () => {
    const other = otherComputer()
    other.faults.create = 'refuse'
    const local = here([job()], other.remote)
    const result = await moveAutomations(local.deps, ['j1'], NODE)
    expect(result.failed[0].error).toMatch(/cannot run above/)
    expect(local.byId.get('j1')).toMatchObject({ enabled: true, state: 'scheduled' })
    expect(local.store.transfer('j1')).toBeUndefined()
  })

  it('keeps both paused when the answer is lost after the copy was made, and a move again finishes it', async () => {
    const other = otherComputer()
    other.faults.create = 'lose'
    const local = here([job()], other.remote)
    const first = await moveAutomations(local.deps, ['j1'], NODE)
    expect(first.failed[0].error).toMatch(/^Check Laptop/)
    // Paused here, and the copy there is paused: it runs on neither until the move is finished.
    expect(local.byId.get('j1')).toMatchObject({ enabled: false, state: 'paused', pausedReason: expect.stringMatching(/^Check Laptop/) })
    expect([...other.made.values()]).toEqual([expect.objectContaining({ enabled: false })])
    // Moving it elsewhere first is refused; moving it to Laptop again reaches the same copy and turns it on.
    expect((await moveAutomations(local.deps, ['j1'], 'node-c')).failed[0].error).toMatch(/^Check Laptop first/)
    expect(other.made.size).toBe(1)
    other.faults.create = undefined
    const again = await moveAutomations(local.deps, ['j1'], NODE)
    expect(again.moved).toEqual([{ id: 'j1', to: `${NODE}:there-1` }])
    expect(other.made.size).toBe(1)
    expect(other.resumed).toEqual(['there-1'])
  })

  it('finishes a move that a restart interrupted, turning the copy on only because it was on before', async () => {
    const other = otherComputer()
    other.faults.create = 'lose'
    const before = here([job()], other.remote)
    await moveAutomations(before.deps, ['j1'], NODE)
    // A restart: the job (paused) and the move record are read again from disk.
    const after = here([{ ...before.byId.get('j1')! }], other.remote, before.dir)
    expect(after.store.transfer('j1')).toMatchObject({ node: NODE, wasEnabled: true })
    other.faults.create = undefined
    expect((await moveAutomations(after.deps, ['j1'], NODE)).moved).toHaveLength(1)
    expect(other.resumed).toEqual(['there-1'])
  })

  it('forgets an unconfirmed move once the person resumed it here', async () => {
    const other = otherComputer()
    other.faults.create = 'lose'
    const local = here([job({ enabled: false, state: 'paused', pausedAt: '2026-11-01T00:00:00.000Z' })], other.remote)
    await moveAutomations(local.deps, ['j1'], NODE)
    // It was paused before: the lost answer does not touch its pause, and the copy stays paused.
    expect(local.byId.get('j1')).toMatchObject({ enabled: false, pausedAt: '2026-11-01T00:00:00.000Z' })
    local.deps.resume('j1')
    other.faults.create = 'refuse'
    await moveAutomations(local.deps, ['j1'], NODE)
    expect(local.store.transfer('j1')).toBeUndefined()
    expect(local.byId.get('j1')).toMatchObject({ enabled: true })
  })

  it('counts it moved, paused there, when turning it on there fails', async () => {
    const other = otherComputer()
    other.faults.resume = true
    const local = here([job()], other.remote)
    const result = await moveAutomations(local.deps, ['j1'], NODE)
    expect(result.moved).toEqual([{ id: 'j1', to: `${NODE}:there-1`, warning: 'Audit is paused on Laptop. Resume it there.' }])
    expect(local.byId.has('j1')).toBe(false)
    expect([...other.made.values()][0]).toMatchObject({ enabled: false })
  })

  it('keeps it paused here, and the move open, when it cannot be removed here after the copy was made', async () => {
    const other = otherComputer()
    const local = here([job()], other.remote)
    const remove = local.deps.remove
    local.deps.remove = () => { throw new Error('disk full') }
    const result = await moveAutomations(local.deps, ['j1'], NODE)
    expect(result.failed[0].error).toMatch(/made on Laptop, paused, but not removed here/)
    expect(local.byId.get('j1')).toMatchObject({ enabled: false })
    expect(other.resumed).toEqual([])
    local.deps.remove = remove
    expect((await moveAutomations(local.deps, ['j1'], NODE)).moved).toHaveLength(1)
    expect(other.made.size).toBe(1)
    expect(other.resumed).toEqual(['there-1'])
  })
})
