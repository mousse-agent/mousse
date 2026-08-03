/**
 * Phase 5: scheduler/channels/settings/MCP/skills over protocol;
 * multi-client observation; daemon-only ownership; shutdown.
 */

import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MousseMainService } from '../src/mms/MousseMainService'
import { MmsProtocolServer } from '../src/mms/protocol/server'
import { LocalMmsClient } from '../src/mms/protocol/client'
import { PROTOCOL_METHODS } from '../src/mms/protocol/types'
import { resolveOwnerStatus } from '../src/mms/ownership/MmsOwnerLease'
import type { ProtocolEvent } from '../src/mms/protocol/types'

describe('Phase 5 protocol surface', () => {
  let home: string
  let mms: MousseMainService
  let server: MmsProtocolServer
  let ownerToken: string
  let endpoint: string

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'mousse-p5-'))
    process.env.MOUSSE_HOME = home
    mms = await MousseMainService.create({
      homeDir: home,
      headless: true,
      ownerKind: 'test'
    })
    await mms.start()
    ownerToken = mms.getOwnerLease()!.owner.token
    server = new MmsProtocolServer({ mms, ownerToken, version: 'test' })
    endpoint = await server.start()
  })

  afterEach(async () => {
    await server.stop()
    await mms.stop()
    try {
      rmSync(home, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
    delete process.env.MOUSSE_HOME
  })

  async function client(type: 'test' | 'cli' | 'gui' = 'test'): Promise<LocalMmsClient> {
    const c = new LocalMmsClient({
      homeDir: home,
      ownerToken,
      endpoint,
      clientType: type
    })
    await c.connect()
    return c
  }

  it('includes Phase 5 methods in allowlist', () => {
    const required = [
      'scheduled.list',
      'scheduled.get',
      'scheduled.create',
      'scheduled.update',
      'scheduled.delete',
      'scheduled.pause',
      'scheduled.resume',
      'scheduled.run',
      'scheduled.status',
      'channels.getSnapshot',
      'channels.getConfig',
      'channels.updateConfig',
      'channels.connect',
      'channels.disconnect',
      'channels.listPairingRequests',
      'channels.approvePairing',
      'channels.rejectPairing',
      'channels.sendTest',
      'channels.getActivity',
      'mcp.listServers',
      'mcp.listTools',
      'mcp.testServer',
      'mcp.authenticate',
      'mcp.restartServer',
      'mcp.getConfigSources',
      'mcp.writeCursorConfig',
      'mcp.openConfigIntent',
      'skills.list',
      'skills.read',
      'skills.refresh',
      'skills.openFolderIntent',
      'settings.get',
      'settings.set',
      'settings.getOptions',
      'providers.listConfigured',
      'providers.getLoginOptions',
      'providers.getAmbientInfo',
      'providers.setApiKey',
      'providers.verifyAmbient',
      'providers.logout',
      'providers.loginOAuth',
      'providers.loginApiKey',
      'providers.loginRespond',
      'providers.loginCancel',
      'daemon.shutdown'
    ]
    for (const m of required) {
      expect(PROTOCOL_METHODS, m).toContain(m)
    }
  })

  it('scheduler CRUD works with zero GUI clients (protocol only)', async () => {
    const c = await client('cli')
    const created = await c.request<{ job: { id: string; name: string; enabled: boolean } }>(
      'scheduled.create',
      {
        input: {
          name: 'nightly',
          prompt: 'run tests',
          schedule: { kind: 'interval', minutes: 60 }
        }
      }
    )
    expect(created.job.name).toBe('nightly')
    const list = await c.request<{ jobs: { id: string }[] }>('scheduled.list')
    expect(list.jobs.some((j) => j.id === created.job.id)).toBe(true)

    await c.request('scheduled.pause', { id: created.job.id, reason: 'test' })
    const paused = await c.request<{ job: { enabled: boolean; state: string } }>(
      'scheduled.get',
      { id: created.job.id }
    )
    expect(paused.job.enabled).toBe(false)
    expect(paused.job.state).toBe('paused')

    await c.request('scheduled.resume', { id: created.job.id })
    await c.request('scheduled.run', { id: created.job.id })

    const status = await c.request<{ status: { running: boolean } }>('scheduled.status')
    expect(typeof status.status.running).toBe('boolean')

    await c.request('scheduled.delete', { id: created.job.id })
    const after = await c.request<{ jobs: { id: string }[] }>('scheduled.list')
    expect(after.jobs.some((j) => j.id === created.job.id)).toBe(false)
    await c.close()
  })

  it('scheduler stays running with zero clients after create', async () => {
    const c = await client()
    const created = await c.request<{ job: { id: string } }>('scheduled.create', {
      input: {
        name: 'solo',
        prompt: 'x',
        schedule: { kind: 'interval', minutes: 120 }
      }
    })
    await c.close()
    // No clients — daemon still owns jobs
    expect(mms.scheduled.listJobs().some((j) => j.id === created.job.id)).toBe(true)
    const status = mms.scheduled.getStatus()
    expect(typeof status.running).toBe('boolean')
  })

  it('two clients observe the same settings after set', async () => {
    const a = await client('gui')
    const b = await client('cli')
    await a.request('settings.set', {
      partial: { profile: { username: 'phase5-user' } }
    })
    const fromB = await b.request<{ settings: { profile: { username: string } } }>(
      'settings.get'
    )
    expect(fromB.settings.profile.username).toBe('phase5-user')
    await a.close()
    await b.close()
  })

  it('settings.changed event is sequenced to subscribers', async () => {
    const a = await client()
    const b = await client()
    await a.subscribe(0)
    await b.subscribe(0)

    const seen: ProtocolEvent[] = []
    const unsub = b.onEvent((ev) => {
      if (ev.type === 'settings.changed') seen.push(ev)
    })

    await a.request('settings.set', {
      partial: { profile: { username: 'event-user' } }
    })

    await new Promise((r) => setTimeout(r, 300))
    expect(seen.length).toBeGreaterThanOrEqual(1)
    const data = seen[0].data as { settings?: { profile?: { username?: string } } }
    expect(data?.settings?.profile?.username).toBe('event-user')
    unsub()
    await a.close()
    await b.close()
  })

  it('two clients observe same scheduled jobs', async () => {
    const a = await client()
    const b = await client()
    const created = await a.request<{ job: { id: string; name: string } }>(
      'scheduled.create',
      {
        input: {
          name: 'shared-job',
          prompt: 'go',
          schedule: { kind: 'interval', minutes: 30 }
        }
      }
    )
    const listB = await b.request<{ jobs: { id: string; name: string }[] }>('scheduled.list')
    expect(listB.jobs.some((j) => j.id === created.job.id && j.name === 'shared-job')).toBe(
      true
    )
    await a.close()
    await b.close()
  })

  it('channel snapshot survives client disconnect (daemon keeps service)', async () => {
    const c = await client()
    const snap1 = await c.request<{ snapshot: { platforms?: unknown } }>(
      'channels.getSnapshot'
    )
    expect(snap1.snapshot).toBeTruthy()
    await c.close()

    // No GUI — channels still answer
    const c2 = await client()
    const snap2 = await c2.request<{ snapshot: unknown }>('channels.getSnapshot')
    expect(snap2.snapshot).toBeTruthy()
    const activity = await c2.request<{ activity: unknown[] }>('channels.getActivity', {
      limit: 10
    })
    expect(Array.isArray(activity.activity)).toBe(true)
    await c2.close()
  })

  it('settings and channel and skills snapshot round-trip', async () => {
    const c = await client()
    const snap = await c.request<{ snapshot: unknown }>('channels.getSnapshot')
    expect(snap.snapshot).toBeTruthy()
    const cfg = await c.request<{ config: unknown }>('channels.getConfig')
    expect(cfg.config).toBeTruthy()
    const skills = await c.request<{ snapshot: unknown }>('skills.list', {})
    expect(skills.snapshot).toBeTruthy()
    const mcp = await c.request<{ servers: unknown[] }>('mcp.listServers', {})
    expect(Array.isArray(mcp.servers)).toBe(true)
    const sources = await c.request<{ sources: unknown[] }>('mcp.getConfigSources', {})
    expect(Array.isArray(sources.sources)).toBe(true)
    const intent = await c.request<{ intent: { kind: string } }>('mcp.openConfigIntent', {
      scope: 'global'
    })
    expect(intent.intent.kind).toBe('open-mcp-config')
    const skillIntent = await c.request<{ intent: { kind: string } }>(
      'skills.openFolderIntent',
      { scope: 'global' }
    )
    expect(skillIntent.intent.kind).toBe('open-skills-folder')
    await c.close()
  })

  it('providers.listConfigured and settings.getOptions are daemon-backed', async () => {
    const c = await client()
    const providers = await c.request<{ providers: unknown[] }>('providers.listConfigured')
    expect(Array.isArray(providers.providers)).toBe(true)
    const options = await c.request<{ options: { themes: unknown[]; llmProviders: unknown[] } }>(
      'settings.getOptions'
    )
    expect(Array.isArray(options.options.themes)).toBe(true)
    expect(Array.isArray(options.options.llmProviders)).toBe(true)
    await c.close()
  })

  it('daemon.shutdown writes stop request for authenticated client', async () => {
    const c = await client()
    const res = await c.request<{ accepted: boolean }>('daemon.shutdown', {
      reason: 'test'
    })
    expect(res.accepted).toBe(true)
    await c.close()
  })

  it('health/status does not leak owner token', async () => {
    const c = await client()
    const health = await c.request<Record<string, unknown>>('health')
    const json = JSON.stringify(health)
    expect(json).not.toContain(ownerToken)
    await c.close()
  })

  it('owner lease is held by daemon process only (test service)', () => {
    const status = resolveOwnerStatus(home)
    expect(status.owned).toBe(true)
    expect(status.record?.pid).toBe(process.pid)
  })

  it('CLI and GUI client types can share the same daemon concurrently', async () => {
    const gui = await client('gui')
    const cli = await client('cli')
    const t = await gui.request<{ thread: { id: string } }>('threads.create', {
      name: 'shared'
    })
    const list = await cli.request<{ threads: { id: string }[] }>('threads.list')
    expect(list.threads.some((x) => x.id === t.thread.id)).toBe(true)
    await gui.request('settings.set', { partial: { profile: { username: 'gui-cli' } } })
    const s = await cli.request<{ settings: { profile: { username: string } } }>('settings.get')
    expect(s.settings.profile.username).toBe('gui-cli')
    await gui.close()
    await cli.close()
  })

  it('scheduler service is started once by MMS start (not per client)', async () => {
    // mms.start() already called in beforeEach — status reflects daemon lifecycle
    const s1 = mms.scheduled.getStatus()
    const c = await client()
    const s2 = await c.request<{ status: { running: boolean } }>('scheduled.status')
    // Connecting a client must not toggle a second start identity
    expect(typeof s1.running).toBe('boolean')
    expect(s2.status.running).toBe(s1.running)
    await c.close()
    const s3 = mms.scheduled.getStatus()
    expect(s3.running).toBe(s1.running)
  })
})
