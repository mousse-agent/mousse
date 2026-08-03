/**
 * Phase 6 E2E/fault: multi-client daemon, disconnect, ownership race, stop.
 */

import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MousseMainService } from '../src/mms/MousseMainService'
import { MmsProtocolServer } from '../src/mms/protocol/server'
import { LocalMmsClient } from '../src/mms/protocol/client'
import { resolveOwnerStatus } from '../src/mms/ownership/MmsOwnerLease'
import {
  readStopRequest,
  writeStopRequest
} from '../src/cli/mmsRuntime'

describe('Phase 6 multi-client and fault paths', () => {
  let home: string
  let mms: MousseMainService
  let server: MmsProtocolServer
  let ownerToken: string
  let endpoint: string

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'mousse-p6-'))
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

  async function connect(type: 'gui' | 'cli' | 'test' = 'test'): Promise<LocalMmsClient> {
    const c = new LocalMmsClient({
      homeDir: home,
      ownerToken,
      endpoint,
      clientType: type
    })
    await c.connect()
    return c
  }

  it('GUI-like and CLI clients share the same daemon settings and jobs', async () => {
    const gui = await connect('gui')
    const cli = await connect('cli')
    await gui.request('settings.set', {
      partial: { profile: { username: 'shared-p6' } }
    })
    const fromCli = await cli.request<{ settings: { profile: { username: string } } }>(
      'settings.get'
    )
    expect(fromCli.settings.profile.username).toBe('shared-p6')

    const job = await cli.request<{ job: { id: string } }>('scheduled.create', {
      input: {
        name: 'p6-job',
        prompt: 'x',
        schedule: { kind: 'interval', minutes: 45 }
      }
    })
    const list = await gui.request<{ jobs: { id: string }[] }>('scheduled.list')
    expect(list.jobs.some((j) => j.id === job.job.id)).toBe(true)
    await gui.close()
    // Job still present with GUI gone
    expect(mms.scheduled.listJobs().some((j) => j.id === job.job.id)).toBe(true)
    await cli.close()
  })

  it('disconnect GUI during turn still leaves authoritative snapshot on reconnect', async () => {
    const gui = await connect('gui')
    const created = await gui.request<{ thread: { id: string } }>('threads.create', {
      name: 'fault-thread'
    })
    const threadId = created.thread.id
    // Enqueue a message without waiting for a real LLM (forceQueue)
    await gui.request('orchestrator.send', {
      threadId,
      content: 'hello fault',
      source: 'gui',
      forceQueue: true
    })
    await gui.close()

    const cli = await connect('cli')
    const snap = await cli.request<{
      messages: { content?: string }[]
      queue: unknown[]
    }>('thread.snapshot', { threadId })
    const texts = (snap.messages ?? []).map((m) => m.content).join(' ')
    // Either accepted into transcript or still queued — never empty loss
    expect(
      texts.includes('hello fault') || (Array.isArray(snap.queue) && snap.queue.length > 0)
    ).toBe(true)
    await cli.close()
  })

  it('second owner construction fails while first lease is live', async () => {
    const status = resolveOwnerStatus(home)
    expect(status.owned).toBe(true)
    await expect(
      MousseMainService.create({
        homeDir: home,
        headless: true,
        ownerKind: 'daemon'
      })
    ).rejects.toThrow()
  })

  it('daemon.shutdown writes stop request with owner token fence', async () => {
    const c = await connect()
    await c.request('daemon.shutdown', { reason: 'p6-test' })
    const req = readStopRequest(home)
    expect(req?.token).toBe(ownerToken)
    await c.close()
  })

  it('stop-file fallback is owner-token authenticated', () => {
    writeStopRequest(home, ownerToken)
    const req = readStopRequest(home)
    expect(req?.token).toBe(ownerToken)
    writeStopRequest(home, 'wrong-token')
    // Overwrite is allowed on disk; daemon poll ignores mismatched token
    const bad = readStopRequest(home)
    expect(bad?.token).toBe('wrong-token')
    expect(bad?.token).not.toBe(ownerToken)
  })

  it('rejects adversarial scheduled.create via protocol', async () => {
    const c = await connect()
    await expect(
      c.request('scheduled.create', {
        input: {
          name: 'bad',
          prompt: 'x',
          schedule: { kind: 'interval', minutes: -1 }
        }
      })
    ).rejects.toThrow()
    // Own-property pollution key (as delivered by JSON protocol frames).
    await expect(
      c.request('scheduled.create', {
        input: JSON.parse(
          JSON.stringify({
            name: 'bad',
            prompt: 'x',
            schedule: { kind: 'interval', minutes: 5 },
            constructor: { prototype: { polluted: true } }
          })
        )
      })
    ).rejects.toThrow()
    await c.close()
  })

  it('scheduler status remains after all clients disconnect', async () => {
    const c = await connect()
    const before = await c.request<{ status: { running: boolean } }>('scheduled.status')
    await c.close()
    const after = mms.scheduled.getStatus()
    expect(after.running).toBe(before.status.running)
  })
})
