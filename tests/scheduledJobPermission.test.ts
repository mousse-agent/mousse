/**
 * A job's permission mode is bounded by a ceiling: the mode its creator held when creating or editing it.
 * The daemon sets the ceiling; no request can. These tests cover the helpers, the store, and the protocol
 * (creation, editing, the refused key, and the ceiling given to jobs saved before ceilings existed).
 */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MousseConfigStore } from '../src/mms/config/MousseConfigStore'
import { MousseMainService } from '../src/mms/MousseMainService'
import { LocalMmsClient } from '../src/mms/protocol/client'
import { MmsProtocolServer } from '../src/mms/protocol/server'
import { asCreateScheduledJobInput, asScheduledJobPatch } from '../src/mms/protocol/validators'
import { isExecutableJobEdit, jobPermissionRequest, permissionAboveCeiling, permissionsAfterEdit } from '../src/mms/scheduled/jobPermission'
import { ScheduledJobStore } from '../src/mms/scheduled/ScheduledJobStore'
import type { PermissionMode } from '../src/shared/permissionMode'
import type { ScheduledJob } from '../src/shared/types'

const MODES: PermissionMode[] = ['ask', 'accept_edits', 'full']

describe('what a run of a job asks for', () => {
  it('is the stricter of the job\'s mode and its ceiling, and nothing when the job has neither', () => {
    expect(jobPermissionRequest({})).toBeUndefined()
    expect(jobPermissionRequest({ permissionMode: 'full' })).toBe('full')
    expect(jobPermissionRequest({ permissionCeiling: 'accept_edits' })).toBe('accept_edits')
    for (const mode of MODES) {
      for (const ceiling of MODES) {
        const expected = MODES[Math.min(MODES.indexOf(mode), MODES.indexOf(ceiling))]
        expect(jobPermissionRequest({ permissionMode: mode, permissionCeiling: ceiling })).toBe(expected)
      }
    }
  })

  it('reads a stored value that is not a mode as the strictest mode', () => {
    expect(jobPermissionRequest({ permissionCeiling: 'root' as never })).toBe('ask')
    expect(jobPermissionRequest({ permissionMode: 'full', permissionCeiling: 'root' as never })).toBe('ask')
  })

  it('refuses a mode wider than the ceiling, and nothing else', () => {
    expect(permissionAboveCeiling('full', 'ask')).toMatch(/wider than Ask before acting/)
    expect(permissionAboveCeiling('accept_edits', 'ask')).toBeDefined()
    expect(permissionAboveCeiling('ask', 'full')).toBeUndefined()
    expect(permissionAboveCeiling('full', 'full')).toBeUndefined()
    expect(permissionAboveCeiling(undefined, 'ask')).toBeUndefined()
    expect(permissionAboveCeiling('full', undefined)).toBeUndefined()
  })
})

describe('the permissions of a job after an edit', () => {
  const edit = (options: Parameters<typeof permissionsAfterEdit>[0]) => permissionsAfterEdit(options)

  it('never raises the ceiling above the editor\'s own', () => {
    for (const stored of MODES) {
      for (const editor of MODES) {
        for (const patchMode of [undefined, null, ...MODES]) {
          for (const executable of [false, true]) {
            const result = edit({ stored: { permissionCeiling: stored }, editor, patchMode, executable })
            if (!result.ok || result.permissionCeiling === undefined) continue
            if (executable || patchMode !== undefined) {
              expect(MODES.indexOf(result.permissionCeiling)).toBeLessThanOrEqual(MODES.indexOf(editor))
            }
            // A mode never exceeds the ceiling it ends up with.
            expect(permissionAboveCeiling(result.permissionMode, result.permissionCeiling)).toBeUndefined()
          }
        }
      }
    }
  })

  it('lowers the ceiling and the mode of a job whose what-it-does is edited by someone holding less', () => {
    expect(edit({ stored: { permissionMode: 'full', permissionCeiling: 'full' }, editor: 'ask', patchMode: undefined, executable: true }))
      .toEqual({ ok: true, permissionMode: 'ask', permissionCeiling: 'ask', changed: true })
    // Holding more than the job's ceiling raises nothing.
    expect(edit({ stored: { permissionCeiling: 'ask' }, editor: 'full', patchMode: undefined, executable: true }))
      .toEqual({ ok: true, permissionMode: undefined, permissionCeiling: 'ask', changed: true })
  })

  it('leaves both fields alone for an edit that changes nothing a run does', () => {
    expect(edit({ stored: { permissionMode: 'full', permissionCeiling: 'full' }, editor: 'ask', patchMode: undefined, executable: false }))
      .toEqual({ ok: true, permissionMode: 'full', permissionCeiling: 'full', changed: false })
  })

  it('takes a mode chosen on purpose up to the editor\'s own, and refuses one above it', () => {
    expect(edit({ stored: { permissionCeiling: 'ask' }, editor: 'full', patchMode: 'full', executable: true }))
      .toEqual({ ok: true, permissionMode: 'full', permissionCeiling: 'full', changed: true })
    expect(edit({ stored: { permissionCeiling: 'full' }, editor: 'accept_edits', patchMode: 'full', executable: true }))
      .toMatchObject({ ok: false, error: expect.stringContaining('wider than Auto-accept edits') })
  })

  it('keeps the ceiling when the mode is cleared', () => {
    expect(edit({ stored: { permissionMode: 'ask', permissionCeiling: 'ask' }, editor: 'full', patchMode: null, executable: true }))
      .toEqual({ ok: true, permissionMode: undefined, permissionCeiling: 'ask', changed: true })
  })

  it('counts what a run does as the fields of an executable edit', () => {
    expect(isExecutableJobEdit({ prompt: 'x' })).toBe(true)
    expect(isExecutableJobEdit({ permissionMode: null })).toBe(true)
    expect(isExecutableJobEdit({ workspace: { kind: 'project' } })).toBe(true)
    expect(isExecutableJobEdit({ name: 'x', enabled: false, repeat: { times: 2 }, schedule: { kind: 'manual' } })).toBe(false)
  })
})

describe('the protocol refuses a ceiling', () => {
  const base = { name: 'n', prompt: 'p', schedule: { kind: 'manual' } }

  it('accepts a job\'s own mode and clears it with null on an edit', () => {
    expect(asCreateScheduledJobInput({ ...base, permissionMode: 'accept_edits' }).permissionMode).toBe('accept_edits')
    expect(asScheduledJobPatch({ permissionMode: 'full' }).permissionMode).toBe('full')
    expect(asScheduledJobPatch({ permissionMode: null }).permissionMode).toBeNull()
    expect(() => asCreateScheduledJobInput({ ...base, permissionMode: 'yolo' })).toThrow(/ask\|accept_edits\|full/)
    expect(() => asScheduledJobPatch({ permissionMode: 'agent' })).toThrow(/ask\|accept_edits\|full/)
  })

  it('refuses permissionCeiling on a create and on an edit, with any value', () => {
    for (const value of ['ask', 'full', null, 1]) {
      expect(() => asCreateScheduledJobInput({ ...base, permissionCeiling: value })).toThrow(/permissionCeiling is not allowed/)
      expect(() => asScheduledJobPatch({ permissionCeiling: value })).toThrow(/permissionCeiling is not allowed/)
    }
  })
})

describe('the store keeps a job within its ceiling', () => {
  let home: string
  beforeEach(() => { home = mkdtempSync(join(realpathSync(tmpdir()), 'mousse-job-ceiling-store-')) })
  afterEach(() => { rmSync(home, { recursive: true, force: true }) })

  const open = () => new ScheduledJobStore(MousseConfigStore.load(home))
  const input = { name: 'Job', prompt: 'work', schedule: { kind: 'manual' } as const }

  it('stores the mode and the ceiling and refuses a mode above the ceiling', () => {
    const store = open()
    const job = store.createJob({ ...input, permissionMode: 'ask', permissionCeiling: 'accept_edits' })
    expect(open().getJob(job.id)).toMatchObject({ permissionMode: 'ask', permissionCeiling: 'accept_edits' })
    expect(() => store.createJob({ ...input, permissionMode: 'full', permissionCeiling: 'ask' })).toThrow(/wider than Ask before acting/)
    expect(() => store.updateJob(job.id, { permissionMode: 'full' })).toThrow(/wider than Auto-accept edits/)
    // Nothing was stored by the refused calls.
    expect(store.listJobs()).toHaveLength(1)
    expect(store.getJob(job.id)).toMatchObject({ permissionMode: 'ask', permissionCeiling: 'accept_edits' })
  })

  it('does not stop an unrelated edit of a job a file already holds out of range', () => {
    const store = open()
    const job = store.createJob({ ...input, permissionMode: 'ask', permissionCeiling: 'ask' })
    // Out of range on disk: a hand edit.
    const config = MousseConfigStore.load(home)
    const section = config.getScheduledSection()
    section.jobs[0].permissionMode = 'full'
    config.updateScheduledSection({ jobs: section.jobs })
    expect(() => store.updateJob(job.id, { name: 'Renamed' })).not.toThrow()
  })

  describe('jobs saved before ceilings existed', () => {
    const seed = (store: ScheduledJobStore): ScheduledJob[] => [
      store.createJob({ ...input, name: 'Bound', threadId: 'thread-ask' }),
      store.createJob({ ...input, name: 'Per run', projectId: 'project-1' }),
      store.createJob({ ...input, name: 'Unknown', threadId: 'thread-missing' }),
      store.createJob({ ...input, name: 'Has one', permissionCeiling: 'full' })
    ]
    const ceilingFor = (job: ScheduledJob): PermissionMode => {
      if (job.threadId === 'thread-ask') return 'ask'
      if (job.threadId === 'thread-missing') throw new Error('thread unreadable')
      return 'accept_edits'
    }

    it('get the thread\'s mode, else the default for threads, else ask, and keep a ceiling they already have', () => {
      const store = open()
      seed(store)
      expect(store.stampMissingPermissionCeilings(ceilingFor)).toBe(3)

      const byName = Object.fromEntries(open().listJobs().map((job) => [job.name, job.permissionCeiling]))
      expect(byName).toEqual({ Bound: 'ask', 'Per run': 'accept_edits', Unknown: 'ask', 'Has one': 'full' })
    })

    it('is safe to run on every start: a second run changes nothing', () => {
      const store = open()
      seed(store)
      store.stampMissingPermissionCeilings(ceilingFor)
      const before = JSON.stringify(open().listJobs())
      expect(open().stampMissingPermissionCeilings(() => 'full')).toBe(0)
      expect(JSON.stringify(open().listJobs())).toBe(before)
    })

    it('treats a ceiling that is not a mode as missing', () => {
      const store = open()
      const job = store.createJob({ ...input, permissionCeiling: 'root' as never })
      expect(store.stampMissingPermissionCeilings(() => 'ask')).toBe(1)
      expect(store.getJob(job.id)?.permissionCeiling).toBe('ask')
    })
  })
})

describe('creating and editing a job through the protocol', () => {
  let home: string
  let mms: MousseMainService
  let server: MmsProtocolServer
  let client: LocalMmsClient
  let originalHome: string | undefined

  async function start(): Promise<void> {
    mms = await MousseMainService.create({ homeDir: home, headless: true, ownerKind: 'test' })
    await mms.start()
    const ownerToken = mms.getOwnerLease()!.owner.token
    server = new MmsProtocolServer({ mms, ownerToken, version: 'test' })
    const endpoint = await server.start()
    client = new LocalMmsClient({ homeDir: home, ownerToken, endpoint, clientType: 'test' })
    await client.connect()
  }

  async function stop(): Promise<void> {
    await client.close()
    await server.stop()
    await mms.stop()
  }

  beforeEach(async () => {
    originalHome = process.env.MOUSSE_HOME
    home = mkdtempSync(join(realpathSync(tmpdir()), 'mousse-job-ceiling-'))
    process.env.MOUSSE_HOME = home
    await start()
  })

  afterEach(async () => {
    await stop().catch(() => undefined)
    if (originalHome === undefined) delete process.env.MOUSSE_HOME
    else process.env.MOUSSE_HOME = originalHome
    rmSync(home, { recursive: true, force: true })
  })

  const setDefaultMode = async (mode: PermissionMode): Promise<void> => { mms.settings.set({ permissions: { defaultMode: mode } }) }
  const create = (input: Record<string, unknown>) =>
    client.request<{ job: ScheduledJob }>('scheduled.create', { input: { name: 'Job', prompt: 'work', schedule: { kind: 'manual' }, ...input } })
  const update = (id: string, patch: Record<string, unknown>) => client.request<{ job: ScheduledJob }>('scheduled.update', { id, patch })
  const threadWithMode = async (mode: PermissionMode): Promise<string> => {
    const created = await client.request<{ thread: { id: string } }>('threads.create', { name: `thread-${mode}` })
    await client.request('threads.setPermissionMode', { threadId: created.thread.id, mode })
    return created.thread.id
  }

  describe('creation', () => {
    it('gives a job with no thread the mode threads start in as its ceiling', async () => {
      for (const mode of MODES) {
        await setDefaultMode(mode)
        const { job } = await create({ name: `Default ${mode}` })
        expect(job.permissionCeiling).toBe(mode)
        expect(job.permissionMode).toBeUndefined()
      }
    })

    it('gives a job bound to a thread that thread\'s mode as its ceiling, whatever the default is', async () => {
      await setDefaultMode('full')
      const strict = await threadWithMode('ask')
      const middle = await threadWithMode('accept_edits')
      expect((await create({ threadId: strict })).job.permissionCeiling).toBe('ask')
      expect((await create({ threadId: middle })).job.permissionCeiling).toBe('accept_edits')
    })

    it('keeps the job\'s own mode within the ceiling and refuses one above it', async () => {
      await setDefaultMode('accept_edits')
      const { job } = await create({ permissionMode: 'ask' })
      expect(job).toMatchObject({ permissionMode: 'ask', permissionCeiling: 'accept_edits' })
      expect((await create({ permissionMode: 'accept_edits' })).job.permissionMode).toBe('accept_edits')

      await expect(create({ permissionMode: 'full' })).rejects.toThrow(/wider than Auto-accept edits/)
      const strict = await threadWithMode('ask')
      await expect(create({ threadId: strict, permissionMode: 'accept_edits' })).rejects.toThrow(/wider than Ask before acting/)
      expect((await client.request<{ jobs: ScheduledJob[] }>('scheduled.list')).jobs).toHaveLength(2)
    })

    it('refuses a ceiling sent with the request, and stores the daemon\'s own', async () => {
      await setDefaultMode('ask')
      // The validator's own message is checked above; over the wire a validation failure reads as a generic error.
      await expect(create({ permissionCeiling: 'full' })).rejects.toThrow()
      expect((await client.request<{ jobs: ScheduledJob[] }>('scheduled.list')).jobs).toHaveLength(0)
      expect((await create({})).job.permissionCeiling).toBe('ask')
    })
  })

  describe('editing', () => {
    it('refuses a ceiling sent with the edit and leaves the job as it was', async () => {
      await setDefaultMode('ask')
      const { job } = await create({})
      await expect(update(job.id, { permissionCeiling: 'full' })).rejects.toThrow()
      expect(mms.scheduled.getJob(job.id)?.permissionCeiling).toBe('ask')
    })

    it('lowers the ceiling and the mode when someone holding less edits what the job does, and not when they rename it', async () => {
      await setDefaultMode('full')
      const { job } = await create({ permissionMode: 'full' })
      expect(job).toMatchObject({ permissionMode: 'full', permissionCeiling: 'full' })

      await setDefaultMode('ask')
      await update(job.id, { name: 'Renamed', schedule: { kind: 'manual' } })
      expect(mms.scheduled.getJob(job.id)).toMatchObject({ name: 'Renamed', permissionMode: 'full', permissionCeiling: 'full' })

      await update(job.id, { prompt: 'a different task' })
      expect(mms.scheduled.getJob(job.id)).toMatchObject({ prompt: 'a different task', permissionMode: 'ask', permissionCeiling: 'ask' })
    })

    it('never raises the ceiling by an edit of the prompt, even for an editor who holds more', async () => {
      await setDefaultMode('ask')
      const { job } = await create({})
      await setDefaultMode('full')
      await update(job.id, { prompt: 'different' })
      expect(mms.scheduled.getJob(job.id)?.permissionCeiling).toBe('ask')
    })

    it('sets the ceiling to the editor\'s mode when the mode is chosen on purpose, and refuses a mode above it', async () => {
      await setDefaultMode('ask')
      const { job } = await create({})
      await setDefaultMode('accept_edits')

      await expect(update(job.id, { permissionMode: 'full' })).rejects.toThrow(/wider than Auto-accept edits/)
      expect(mms.scheduled.getJob(job.id)?.permissionCeiling).toBe('ask')
      expect(mms.scheduled.getJob(job.id)?.permissionMode).toBeUndefined()

      await update(job.id, { permissionMode: 'accept_edits' })
      expect(mms.scheduled.getJob(job.id)).toMatchObject({ permissionMode: 'accept_edits', permissionCeiling: 'accept_edits' })
    })

    it('keeps the ceiling when the mode is cleared', async () => {
      await setDefaultMode('ask')
      const { job } = await create({ permissionMode: 'ask' })
      await setDefaultMode('full')
      await update(job.id, { permissionMode: null })
      expect(mms.scheduled.getJob(job.id)?.permissionCeiling).toBe('ask')
      expect(mms.scheduled.getJob(job.id)?.permissionMode).toBeUndefined()
    })

    it('uses the mode of the thread the job is moved to as the editor\'s', async () => {
      await setDefaultMode('full')
      const { job } = await create({})
      const strict = await threadWithMode('ask')
      await update(job.id, { threadId: strict })
      expect(mms.scheduled.getJob(job.id)).toMatchObject({ threadId: strict, permissionCeiling: 'ask' })
    })
  })

  describe('jobs saved before ceilings existed', () => {
    it('get a ceiling at the next start: their thread\'s mode, else the default for threads', async () => {
      await setDefaultMode('full')
      const strict = await threadWithMode('ask')
      // Saved without a ceiling, as an older version did.
      const bound = mms.scheduled.createJob({ name: 'Old bound', prompt: 'work', schedule: { kind: 'manual' }, threadId: strict })
      const perRun = mms.scheduled.createJob({ name: 'Old per run', prompt: 'work', schedule: { kind: 'manual' } })
      expect(bound.permissionCeiling).toBeUndefined()
      expect(perRun.permissionCeiling).toBeUndefined()

      await stop()
      await start()

      expect(mms.scheduled.getJob(bound.id)).toMatchObject({ permissionCeiling: 'ask' })
      expect(mms.scheduled.getJob(perRun.id)).toMatchObject({ permissionCeiling: 'full' })
    })

    it('are stamped once: a later start keeps the ceiling they got', async () => {
      await setDefaultMode('accept_edits')
      const job = mms.scheduled.createJob({ name: 'Old', prompt: 'work', schedule: { kind: 'manual' } })
      await stop()
      await start()
      expect(mms.scheduled.getJob(job.id)?.permissionCeiling).toBe('accept_edits')

      await setDefaultMode('full')
      await stop()
      await start()
      expect(mms.scheduled.getJob(job.id)?.permissionCeiling).toBe('accept_edits')
    })
  })
})
