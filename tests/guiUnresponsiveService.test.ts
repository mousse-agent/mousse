/**
 * A service that holds the home with its process alive but answers no handshake (its main thread is stuck: a
 * deadlock, a native hang, an endless loop) is replaced by the app: asked to stop, ended when it outlives the stop, and
 * a new one started, instead of the app retrying "Hello timeout" for as long as the stuck process lives. A service that
 * is only slow, briefly busy, just restarted, or run by the dev script or a test is never replaced.
 *
 * Real services run in this process. The lease names an endpoint in front of each real one that passes the connection
 * on, holds it without an answer (stuck), or answers late. How the app starts a service is replaced, so the "new" one
 * is another in-process service over the same home; ending the stuck process is scripted (it stops the service).
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { createConnection, createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MousseMainService } from '../src/mms/MousseMainService'
import { MmsProtocolServer } from '../src/mms/protocol/server'
import { GuiMmsController, type GuiMmsControllerOptions } from '../src/main/mms/GuiMmsController'
import { publishOwnRuntimeRecord, readStopRequest, removeOwnRuntimeRecord } from '../src/cli/mmsRuntime'
import { readOwnerRecord } from '../src/mms/ownership/MmsOwnerLease'

vi.setConfig({ testTimeout: 60_000 })

/** Short enough for a test, long enough for an in-process service to answer a handshake through the front. */
const HELLO_MS = 300
/** Three unanswered handshakes (about 900 ms from the first one's start) pass it; two do not. */
const AFTER_MS = 700
const GRACE_MS = 300

type FrontMode = 'pass' | 'stuck' | { lateMs: number }

/** The endpoint the lease names, in front of a real service's server. */
class Front {
  mode: FrontMode = 'pass'
  private readonly sockets = new Set<Socket>()
  private server: Server | null = null

  constructor(private readonly target: string, readonly path: string) {}

  listen(): Promise<void> {
    const server = createServer((client) => {
      this.sockets.add(client)
      client.on('error', () => undefined)
      client.on('close', () => this.sockets.delete(client))
      const mode = this.mode
      if (mode === 'stuck') return
      const pass = (): void => {
        if (client.destroyed) return
        const upstream = createConnection(this.target)
        this.sockets.add(upstream)
        upstream.on('error', () => client.destroy())
        upstream.on('close', () => { this.sockets.delete(upstream); client.destroy() })
        client.on('close', () => upstream.destroy())
        client.pipe(upstream)
        upstream.pipe(client)
      }
      if (mode === 'pass') pass()
      else setTimeout(pass, mode.lateMs)
    })
    this.server = server
    return new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.path, () => resolve())
    })
  }

  /** Closes every connection through it, as a service that went away would. */
  drop(): void {
    for (const socket of this.sockets) socket.destroy()
  }

  async close(): Promise<void> {
    this.drop()
    const server = this.server
    this.server = null
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

interface Service {
  token: string
  front: Front
  stopped: boolean
  stop(): Promise<void>
}

describe('a service that stops answering', () => {
  const homes: string[] = []
  const services: Service[] = []
  const controllers: GuiMmsController[] = []
  let fronts = 0

  const newHome = (): string => {
    const home = mkdtempSync(join(tmpdir(), 'mousse-unresp-'))
    homes.push(home)
    process.env.MOUSSE_HOME = home
    return home
  }

  /** A real service holding the home, reached through a front. */
  const startService = async (home: string): Promise<Service> => {
    const mms = await MousseMainService.create({ homeDir: home, headless: true, ownerKind: 'daemon' })
    await mms.start()
    const token = mms.getOwnerLease()!.owner.token
    const server = new MmsProtocolServer({ mms, ownerToken: token, version: 'test' })
    const endpoint = await server.start()
    fronts += 1
    const frontPath = process.platform === 'win32'
      ? `\\\\.\\pipe\\mousse-unresp-${process.pid}-${fronts}`
      : join(home, `front-${fronts}.sock`)
    const front = new Front(endpoint, frontPath)
    await front.listen()
    mms.getOwnerLease()!.setEndpoint(frontPath)
    publishOwnRuntimeRecord(home, { ownerToken: token })
    const service: Service = {
      token,
      front,
      stopped: false,
      async stop() {
        if (service.stopped) return
        service.stopped = true
        await front.close()
        removeOwnRuntimeRecord(home, token)
        await server.stop()
        await mms.stop()
      }
    }
    services.push(service)
    return service
  }

  /** Stops the service once a stop request names it, as its watchdog thread does while its main thread is stuck. */
  const obeysStopRequests = (home: string, service: Service): void => {
    const timer = setInterval(() => {
      if (!readStopRequest(home, service.token)) return
      clearInterval(timer)
      void service.stop()
    }, 20)
  }

  const app = (home: string, opts: GuiMmsControllerOptions = {}) => {
    const log: Array<{ event: string; fields: Record<string, unknown> }> = []
    const ended: number[] = []
    const started: Service[] = []
    let stuck: Service | null = null
    const stopRequestedBeforeEnd: boolean[] = []
    const gui = new GuiMmsController({
      homeDir: home,
      reconnectBaseMs: 10,
      helloTimeoutMs: HELLO_MS,
      ...opts,
      unresponsiveService: {
        afterMs: AFTER_MS,
        stopGraceMs: GRACE_MS,
        endProcess: async (pid) => {
          ended.push(pid)
          stopRequestedBeforeEnd.push(stuck !== null && readStopRequest(home, stuck.token) !== null)
          await stuck?.stop()
        },
        ...opts.unresponsiveService
      }
    })
    controllers.push(gui)
    gui.setConnectionLog({ write: (event, fields = {}) => void log.push({ event, fields }) })
    gui.on('error', () => undefined)
    const spawn = vi.spyOn(gui as unknown as { spawnDaemon: () => Promise<unknown> }, 'spawnDaemon').mockImplementation(async () => {
      const service = await startService(home)
      started.push(service)
      return { exitCode: null, signalCode: null }
    })
    return {
      gui,
      log,
      ended,
      started,
      spawn,
      stopRequestedBeforeEnd,
      events: () => log.map((line) => line.event),
      /** The service whose process is ended when it outlives the stop. */
      endsProcessOf: (service: Service) => { stuck = service }
    }
  }

  /** One start of the app (a window's request, or Mousse opened again) that fails at the handshake. */
  const failedStart = async (gui: GuiMmsController): Promise<void> => {
    await expect(gui.start()).rejects.toMatchObject({ code: 'hello_timeout' })
  }

  afterEach(async () => {
    vi.restoreAllMocks()
    for (const gui of controllers.splice(0)) await gui.stop().catch(() => undefined)
    for (const service of services.splice(0)) await service.stop().catch(() => undefined)
    delete process.env.MOUSSE_HOME
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
  })

  it('is replaced while the app reconnects: asked to stop, ended when it stays, and a new service serves the app', async () => {
    const home = newHome()
    const stuck = await startService(home)
    const stuckPid = readOwnerRecord(home)!.pid
    const a = app(home)
    a.endsProcessOf(stuck)
    await a.gui.start()

    // Its main thread stops: the connection drops, and every handshake after that is accepted and never answered.
    stuck.front.mode = 'stuck'
    stuck.front.drop()

    await vi.waitFor(() => {
      expect(a.events()).toContain('service.restored')
      expect(a.gui.connectionState).toBe('ready')
    }, { timeout: 20_000, interval: 50 })

    // The process that never answered was the one ended, after it was asked to stop, and only once.
    expect(a.ended).toEqual([stuckPid])
    expect(a.stopRequestedBeforeEnd).toEqual([true])
    expect(a.spawn).toHaveBeenCalledTimes(1)
    expect(readOwnerRecord(home)?.token).toBe(a.started[0]!.token)
    const events = a.events()
    const unresponsive = events.indexOf('service.unresponsive')
    expect(unresponsive).toBeGreaterThan(-1)
    expect(events.indexOf('service.ending')).toBeGreaterThan(unresponsive)
    expect(events.indexOf('service.replaced')).toBeGreaterThan(events.indexOf('service.ending'))
    expect(events.lastIndexOf('service.connected')).toBeGreaterThan(events.indexOf('service.replaced'))
    const noted = a.log.find((line) => line.event === 'service.unresponsive')!.fields
    expect(noted.attempts).toBeGreaterThanOrEqual(3)
    expect(noted.unansweredMs).toBeGreaterThanOrEqual(AFTER_MS)
    expect(a.log.find((line) => line.event === 'service.replaced')?.fields).toMatchObject({ ended: true })

    // The new service answers.
    await expect(a.gui.request('profiles.status', {})).resolves.toBeDefined()
  })

  it('found stuck when Mousse opens is stopped through its stop request, and nothing is ended from outside', async () => {
    const home = newHome()
    const stuck = await startService(home)
    stuck.front.mode = 'stuck'
    obeysStopRequests(home, stuck)
    const a = app(home)

    await failedStart(a.gui)
    await failedStart(a.gui)
    const hello = await a.gui.start()

    expect(a.ended).toEqual([])
    expect(a.spawn).toHaveBeenCalledTimes(1)
    expect(hello.instanceId).toBeTruthy()
    expect(readOwnerRecord(home)?.token).toBe(a.started[0]!.token)
    expect(a.log.find((line) => line.event === 'service.replaced')?.fields).toMatchObject({ ended: false })
    expect(a.events()).not.toContain('service.ending')
  })

  /**
   * Each row: a service that leaves handshakes unanswered for a while but must be kept. `run` drives the app; nothing
   * may be asked to stop, ended or started, and the service that held the home at the end still holds it.
   */
  const kept: Array<{
    name: string
    opts?: GuiMmsControllerOptions
    run: (ctx: { home: string; gui: GuiMmsController; service: Service; setService: (s: Service) => void }) => Promise<void>
  }> = [
    {
      name: 'slow to start: handshakes go unanswered, but for less than the minute',
      opts: { unresponsiveService: { afterMs: 60_000 } },
      run: async ({ gui }) => {
        for (let i = 0; i < 4; i += 1) await failedStart(gui)
      }
    },
    {
      name: 'briefly busy: an answer in time between unanswered handshakes starts the count again',
      run: async ({ gui, service }) => {
        await failedStart(gui)
        await failedStart(gui)
        service.front.mode = { lateMs: HELLO_MS / 3 }
        await gui.start()
        await gui.stop()
        service.front.mode = 'stuck'
        await failedStart(gui)
        await failedStart(gui)
      }
    },
    {
      name: 'restarted meanwhile: a different service holds the home, so its count starts again',
      run: async ({ home, gui, service, setService }) => {
        await failedStart(gui)
        await failedStart(gui)
        await service.stop()
        const next = await startService(home)
        next.front.mode = 'stuck'
        setService(next)
        await failedStart(gui)
      }
    },
    {
      name: 'run by the dev script (managed)',
      opts: { managedDaemon: true },
      run: async ({ gui }) => {
        for (let i = 0; i < 4; i += 1) await failedStart(gui)
      }
    },
    {
      name: 'auto-start off (tests)',
      opts: { disableAutoStart: true },
      run: async ({ gui }) => {
        for (let i = 0; i < 4; i += 1) await failedStart(gui)
      }
    }
  ]

  it.each(kept)('is kept when $name', async ({ opts, run }) => {
    const home = newHome()
    let service = await startService(home)
    service.front.mode = 'stuck'
    const a = app(home, opts)
    a.endsProcessOf(service)

    await run({ home, gui: a.gui, service, setService: (next) => { service = next; a.endsProcessOf(next) } })

    expect(readStopRequest(home, service.token)).toBeNull()
    expect(a.ended).toEqual([])
    expect(a.spawn).not.toHaveBeenCalled()
    expect(readOwnerRecord(home)?.token).toBe(service.token)
    expect(a.events()).not.toContain('service.unresponsive')
  })
})
