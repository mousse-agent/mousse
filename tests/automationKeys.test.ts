import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MousseConfigStore } from '../src/mms/config/MousseConfigStore'
import { ScheduledJobStore } from '../src/mms/scheduled/ScheduledJobStore'
import { ScheduledJobService } from '../src/mms/scheduled/ScheduledJobService'
import { createProfileSecretAdapter, listProfileKeyNames, writeProfileSecret } from '../src/mms/profiles/secrets'
import { resolveRecord } from '../src/mms/integrations/secrets'
import { buildAutomationIndex } from '../src/mms/automations/AutomationIndex'
import { asCreateScheduledJobInput, asScheduledJobPatch } from '../src/mms/protocol/validators'
import { keyNameOf } from '../src/shared/automationKeys'
import type { ScheduledRunEnded } from '../src/shared/automations'
import { DomainHandlerRegistry } from '../src/mms/protocol/domainRegistry'
import { registerAutomationMethods } from '../src/mms/automations/registerMethods'
import type { HandlerContext } from '../src/mms/protocol/handlers'

const VALUE = 'ghp_s3cret-value-never-in-a-prompt'

describe('saved keys', () => {
  let home: string
  let previousHome: string | undefined
  beforeEach(() => {
    previousHome = process.env.MOUSSE_HOME
    home = mkdtempSync(join(tmpdir(), 'mousse-keys-'))
    process.env.MOUSSE_HOME = home
  })
  afterEach(() => {
    if (previousHome === undefined) delete process.env.MOUSSE_HOME
    else process.env.MOUSSE_HOME = previousHome
    rmSync(home, { recursive: true, force: true })
  })

  it('names keys like environment variables', () => {
    expect(keyNameOf('github token')).toBe('GITHUB_TOKEN')
    expect(keyNameOf('npm-token')).toBe('NPM_TOKEN')
    expect(keyNameOf('1password')).toBeNull()
    expect(keyNameOf('')).toBeNull()
    expect(asCreateScheduledJobInput({ name: 'n', prompt: 'p', schedule: { kind: 'manual' }, keys: ['GITHUB_TOKEN', 'GITHUB_TOKEN'] }).keys).toEqual(['GITHUB_TOKEN'])
    expect(() => asCreateScheduledJobInput({ name: 'n', prompt: 'p', schedule: { kind: 'manual' }, keys: ['ghp_value'] })).toThrow(/names like/)
    expect(asScheduledJobPatch({ keys: null }).keys).toBeNull()
  })

  it('stores a key only from a window, and lists keys by name, never by value', async () => {
    const domains = new DomainHandlerRegistry()
    const set = vi.fn((name: string, value: string) => writeProfileSecret(home, name, value))
    registerAutomationMethods(domains, async () => ({
      index: () => { throw new Error('unused') },
      answerAsk: () => { throw new Error('unused') },
      keep: () => null,
      move: async () => ({ moved: [], failed: [] }),
      resend: () => ({ occurrenceId: 'x' }),
      keys: { list: () => listProfileKeyNames(home), set }
    }))
    const context = (clientType: string) => ({ connection: { clientType, binding: { profileId: 'p', epoch: 1 }, capabilities: new Set<string>() } }) as unknown as HandlerContext
    await expect(domains.dispatch(context('cli'), 'automations.keys.set', { name: 'GITHUB_TOKEN', value: VALUE })).rejects.toThrow(/window/)
    await expect(domains.dispatch(context('gui'), 'automations.keys.set', { name: 'github token', value: VALUE })).rejects.toThrow(/GITHUB_TOKEN/)
    await expect(domains.dispatch(context('gui'), 'automations.keys.set', { name: 'GITHUB_TOKEN', value: '' })).rejects.toThrow(/16 KB/)
    expect(set).not.toHaveBeenCalled()
    await domains.dispatch(context('gui'), 'automations.keys.set', { name: 'GITHUB_TOKEN', value: VALUE })
    const listed = await domains.dispatch(context('cli'), 'automations.keys.list', {})
    expect(listed).toEqual({ keys: [{ name: 'GITHUB_TOKEN' }] })
    expect(JSON.stringify(listed)).not.toContain(VALUE)
  })

  it('lists the stored keys by name only, without the webhook secrets in the same file', () => {
    writeProfileSecret(home, 'GITHUB_TOKEN', VALUE)
    writeProfileSecret(home, 'scheduled-webhook-j1', 'whsec_x')
    expect(listProfileKeyNames(home)).toEqual(['GITHUB_TOKEN'])
  })

  it('reaches a tool through ${secret:NAME} in its settings, the existing secret path', () => {
    writeProfileSecret(home, 'GITHUB_TOKEN', VALUE)
    const secrets = createProfileSecretAdapter({ profileRoot: home, inheritProcessEnv: false })
    expect(resolveRecord({ GITHUB_TOKEN: '${secret:GITHUB_TOKEN}', OTHER: '${secret:MISSING}' }, secrets)).toEqual({ GITHUB_TOKEN: VALUE, OTHER: '' })
  })

  it('ends a run Incomplete with "Add key <name>" when a key it names is not stored, and runs it once the key is there', async () => {
    const store = new ScheduledJobStore(MousseConfigStore.load(home))
    const prompts: Array<{ prompt: string; ingress: unknown }> = []
    const service = new ScheduledJobService({ runIsolated: async (prompt, ingress) => { prompts.push({ prompt, ingress }); return { text: 'done', silent: false } } }, store)
    service.setKeyStore({ has: (name) => listProfileKeyNames(home).includes(name) })
    const ended: ScheduledRunEnded[] = []
    service.on('runEnded', (event: ScheduledRunEnded) => ended.push(event))
    const job = store.createJob({ name: 'Bump deps', prompt: 'Open a PR that bumps deps', schedule: { kind: 'manual' }, keys: ['GITHUB_TOKEN'] })

    store.triggerJob(job.id)
    await service.tickNow()
    expect(prompts).toHaveLength(0)
    const record = store.getJob(job.id)!.runHistory!.at(-1)!
    expect(record).toMatchObject({ missingKey: 'GITHUB_TOKEN', error: 'Add key GITHUB_TOKEN' })
    expect(ended.at(-1)).toMatchObject({ outcome: 'incomplete', notify: true })
    const index = buildAutomationIndex({ jobs: () => store.listJobs(), thread: () => undefined, threads: () => [], projectName: () => undefined, threadMode: () => 'ask', keyStored: (name) => listProfileKeyNames(home).includes(name), computerName: 'Desk', timeZone: 'UTC' })
    expect(index.items[0]).toMatchObject({ keys: [{ name: 'GITHUB_TOKEN', stored: false }], last: { state: 'incomplete', detail: 'Add key GITHUB_TOKEN' }, attention: { kind: 'incomplete', text: 'Add key GITHUB_TOKEN', addKey: 'GITHUB_TOKEN' } })

    writeProfileSecret(home, 'GITHUB_TOKEN', VALUE)
    store.triggerJob(job.id)
    await service.tickNow()
    expect(prompts).toHaveLength(1)
    // The value is never in the prompt, the run's inputs, the job or its run records.
    expect(prompts[0]!.prompt).not.toContain(VALUE)
    expect(JSON.stringify(prompts[0]!.ingress)).not.toContain(VALUE)
    expect(JSON.stringify(store.getJob(job.id))).not.toContain(VALUE)
    expect(readFileSync(join(home, 'scheduled', 'jobs-runtime.json'), 'utf8')).not.toContain(VALUE)
    // A later run that succeeded clears Needs you.
    const after = buildAutomationIndex({ jobs: () => store.listJobs(), thread: () => undefined, threads: () => [], projectName: () => undefined, threadMode: () => 'ask', keyStored: () => true, computerName: 'Desk', timeZone: 'UTC' })
    expect(after.items[0]!.attention).toBeUndefined()
    vi.restoreAllMocks()
  })
})
