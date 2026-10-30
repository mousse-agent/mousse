import { mkdtempSync, realpathSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MousseMainService } from '../src/mms/MousseMainService'
import { MmsProtocolServer } from '../src/mms/protocol/server'
import { LocalMmsClient } from '../src/mms/protocol/client'
import type { ProtocolEvent } from '../src/mms/protocol/types'
import { readStopRequest } from '../src/cli/mmsRuntime'
import { buildScheduleAddInput } from '../src/cli/commands/schedule'
import { parseArgs } from '../src/cli/parseArgs'

/**
 * Several clients of one daemon: settings, scheduled jobs, skills and MCP
 * snapshots are daemon-owned and survive any single client disconnecting.
 */
describe('daemon protocol across clients', () => {
  let home: string
  let mms: MousseMainService
  let server: MmsProtocolServer
  let ownerToken: string
  let endpoint: string

  beforeEach(async () => {
    home = mkdtempSync(join(realpathSync(tmpdir()), 'mousse-protocol-clients-'))
    process.env.MOUSSE_HOME = home
    mms = await MousseMainService.create({ homeDir: home, headless: true, ownerKind: 'test' })
    await mms.start()
    ownerToken = mms.getOwnerLease()!.owner.token
    server = new MmsProtocolServer({ mms, ownerToken, version: 'test' })
    endpoint = await server.start()
  })

  afterEach(async () => {
    await server.stop()
    await mms.stop()
    rmSync(home, { recursive: true, force: true })
    delete process.env.MOUSSE_HOME
  })

  async function connect(type: 'gui' | 'cli' | 'test' = 'test'): Promise<LocalMmsClient> {
    const c = new LocalMmsClient({ homeDir: home, ownerToken, endpoint, clientType: type })
    await c.connect()
    return c
  }

  it('GUI and CLI clients share the same daemon settings and jobs', async () => {
    const gui = await connect('gui')
    const cli = await connect('cli')
    await gui.request('settings.set', { partial: { profile: { username: 'shared' } } })
    const fromCli = await cli.request<{ settings: { profile: { username: string } } }>('settings.get')
    expect(fromCli.settings.profile.username).toBe('shared')

    const job = await cli.request<{ job: { id: string } }>('scheduled.create', {
      input: { name: 'shared-job', prompt: 'x', schedule: { kind: 'interval', minutes: 45 } }
    })
    const list = await gui.request<{ jobs: { id: string }[] }>('scheduled.list')
    expect(list.jobs.some((j) => j.id === job.job.id)).toBe(true)
    await gui.close()
    expect(mms.scheduled.listJobs().some((j) => j.id === job.job.id)).toBe(true)
    await cli.close()
  })

  it('scheduler CRUD works over the protocol without a GUI client', async () => {
    const c = await connect('cli')
    const created = await c.request<{ job: { id: string; name: string; enabled: boolean } }>('scheduled.create', {
      input: { name: 'nightly', prompt: 'run tests', schedule: { kind: 'interval', minutes: 60 } }
    })
    expect(created.job.name).toBe('nightly')
    const list = await c.request<{ jobs: { id: string }[] }>('scheduled.list')
    expect(list.jobs.some((j) => j.id === created.job.id)).toBe(true)

    await c.request('scheduled.pause', { id: created.job.id, reason: 'test' })
    const paused = await c.request<{ job: { enabled: boolean; state: string } }>('scheduled.get', { id: created.job.id })
    expect(paused.job.enabled).toBe(false)
    expect(paused.job.state).toBe('paused')

    await c.request('scheduled.resume', { id: created.job.id })
    await c.request('scheduled.run', { id: created.job.id })

    await c.request('scheduled.delete', { id: created.job.id })
    const after = await c.request<{ jobs: { id: string }[] }>('scheduled.list')
    expect(after.jobs.some((j) => j.id === created.job.id)).toBe(false)
    await c.close()
  })

  it('creates the job `schedule add --instance --model --mode --workspace` describes', async () => {
    const c = await connect('cli')
    const project = mms.projects.openProject(home)
    const input = buildScheduleAddInput('Check CI', 'Check CI', { kind: 'manual' }, parseArgs(['schedule', 'add', '--instance', 'claude', '--model', 'sonnet', '--mode', 'plan', '--workspace', 'project', '--project', project.id]).flags)
    const created = await c.request<{ job: { selection?: { instanceId?: string; model: string }; mode?: string; workspace?: { kind: string } } }>('scheduled.create', { input })
    expect(created.job).toMatchObject({ selection: { instanceId: 'claude', model: 'sonnet' }, mode: 'plan' })
    await c.close()
  })

  it('refuses Run now while the job\'s run is waiting in a queue, and says why', async () => {
    const c = await connect('cli')
    const created = await c.request<{ job: { id: string } }>('scheduled.create', { input: { name: 'queued', prompt: 'x', schedule: { kind: 'manual' } } })
    const store = (mms.scheduled as any).store
    store.updateJob(created.job.id, { pendingOccurrence: { occurrenceKey: 'k', threadId: 't', runId: 'r', queueItemId: 'i', state: 'queued' } })
    await expect(c.request('scheduled.run', { id: created.job.id })).rejects.toThrow(/waiting in the queue/)
    store.updateJob(created.job.id, { pendingOccurrence: undefined, state: 'running', runClaim: { pid: process.pid, processInstanceId: 'x', token: 't', claimedAt: '', heartbeatAt: '', occurrenceKey: 'k' } })
    await expect(c.request('scheduled.run', { id: created.job.id })).rejects.toThrow(/already running/)
    await c.close()
  })

  it('rejects a scheduled.create carrying an own-property pollution key', async () => {
    const c = await connect()
    await expect(
      c.request('scheduled.create', {
        input: JSON.parse(JSON.stringify({
          name: 'bad',
          prompt: 'x',
          schedule: { kind: 'interval', minutes: 5 },
          constructor: { prototype: { polluted: true } }
        }))
      })
    ).rejects.toThrow()
    await c.close()
  })

  it('a forced-queue send survives the sending client disconnecting', async () => {
    const gui = await connect('gui')
    const created = await gui.request<{ thread: { id: string } }>('threads.create', { name: 'fault-thread' })
    const threadId = created.thread.id
    await gui.request('orchestrator.send', { threadId, content: 'hello fault', source: 'gui', forceQueue: true })
    await gui.close()

    const cli = await connect('cli')
    const snap = await cli.request<{ messages: { content?: string }[]; queue: unknown[] }>('thread.snapshot', { threadId })
    const texts = (snap.messages ?? []).map((m) => m.content).join(' ')
    expect(texts.includes('hello fault') || (Array.isArray(snap.queue) && snap.queue.length > 0)).toBe(true)
    await cli.close()
  })

  it('settings.changed events reach subscribers', async () => {
    const a = await connect()
    const b = await connect()
    await a.subscribe(0)
    await b.subscribe(0)

    const seen: ProtocolEvent[] = []
    const unsub = b.onEvent((ev) => {
      if (ev.type === 'settings.changed') seen.push(ev)
    })
    await a.request('settings.set', { partial: { profile: { username: 'event-user' } } })
    await new Promise((r) => setTimeout(r, 300))
    expect(seen.length).toBeGreaterThanOrEqual(1)
    const data = seen[0].data as { settings?: { profile?: { username?: string } } }
    expect(data?.settings?.profile?.username).toBe('event-user')
    unsub()
    await a.close()
    await b.close()
  })

  it('a provider change made by one client reaches the others as a snapshots event', async () => {
    const a = await connect()
    const b = await connect()
    await b.subscribe(0)
    const seen: ProtocolEvent[] = []
    const unsub = b.onEvent((ev) => {
      if (ev.type === 'providers.snapshots') seen.push(ev)
    })
    const { snapshots } = await a.request<{ snapshots: Array<{ instanceId: string }> }>('providers.snapshots', { scope: { kind: 'device' } })
    const instanceId = snapshots[0]!.instanceId
    await a.request('providers.instances.setEnabled', { instanceId, scope: { kind: 'device' }, enabled: false })
    await new Promise((r) => setTimeout(r, 300))
    const last = seen.at(-1)?.data as { scope?: { kind?: string }; snapshots?: Array<{ instanceId: string; enabled: { device: boolean } }> } | undefined
    expect(last?.scope?.kind).toBe('device')
    expect(last?.snapshots?.find((snapshot) => snapshot.instanceId === instanceId)?.enabled.device).toBe(false)
    unsub()
    await a.close()
    await b.close()
  })

  it('daemon reads answer after a client disconnects', async () => {
    const c = await connect()
    const before = await c.request<{ status: unknown }>('scheduled.status')
    expect(before.status).toBeTruthy()
    await c.close()

    const c2 = await connect()
    const after = await c2.request<{ status: unknown }>('scheduled.status')
    expect(after.status).toBeTruthy()
    const settings = await c2.request<{ settings: unknown }>('settings.get')
    expect(settings.settings).toBeTruthy()
    await c2.close()
  })

  it('skills and MCP snapshots round-trip', async () => {
    const c = await connect()
    const skills = await c.request<{ snapshot: unknown }>('skills.list', {})
    expect(skills.snapshot).toBeTruthy()
    const mcp = await c.request<{ servers: unknown[] }>('mcp.listServers', {})
    expect(Array.isArray(mcp.servers)).toBe(true)
    const sources = await c.request<{ sources: unknown[] }>('mcp.getConfigSources', {})
    expect(Array.isArray(sources.sources)).toBe(true)
    const intent = await c.request<{ intent: { kind: string } }>('mcp.openConfigIntent', { scope: 'global' })
    expect(intent.intent.kind).toBe('open-mcp-config')
    const skillIntent = await c.request<{ intent: { kind: string } }>('skills.openFolderIntent', { scope: 'global' })
    expect(skillIntent.intent.kind).toBe('open-skills-folder')
    await c.close()
  })

  it('provider snapshots, Add provider options and settings.getOptions are daemon-backed', async () => {
    const c = await connect()
    const snapshots = await c.request<{ snapshots: unknown[] }>('providers.snapshots', { scope: { kind: 'device' } })
    expect(Array.isArray(snapshots.snapshots)).toBe(true)
    const addOptions = await c.request<{ options: unknown[] }>('providers.catalog.addOptions')
    expect(Array.isArray(addOptions.options)).toBe(true)
    const options = await c.request<{ options: { themes: unknown[]; llmProviders: unknown[] } }>('settings.getOptions')
    expect(Array.isArray(options.options.themes)).toBe(true)
    expect(Array.isArray(options.options.llmProviders)).toBe(true)
    await c.close()
  })

  it('daemon.shutdown writes a stop request fenced by the owner token', async () => {
    const c = await connect()
    await c.request('daemon.shutdown', { reason: 'test' })
    expect(readStopRequest(home)?.token).toBe(ownerToken)
    await c.close()
  })

  it('health does not leak the owner token', async () => {
    const c = await connect()
    const health = await c.request<Record<string, unknown>>('health')
    expect(JSON.stringify(health)).not.toContain(ownerToken)
    await c.close()
  })
})
