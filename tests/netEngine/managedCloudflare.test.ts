import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ManagedCloudflare } from '../../src/mms/netEngine/cloudflare/service'

const fixture = vi.hoisted(() => {
  type ProcessOptions = {
    line(line: string): void
    state(state: 'provisioning' | 'degraded'): void
  }
  const processes: Array<{ ready(index?: number): void; lost(index?: number): void; stop: ReturnType<typeof vi.fn> }> = []
  class FakeSupervisor {
    stop = vi.fn(async () => undefined)

    constructor(private readonly options: ProcessOptions) {
      processes.push({
        ready: (connIndex = 0) => options.line(JSON.stringify({ connIndex, message: 'Registered tunnel connection' })),
        lost: (connIndex = 0) => options.line(JSON.stringify({ connIndex, message: 'Connection terminated' })),
        stop: this.stop
      })
    }

    start(): void {
      this.options.state('provisioning')
    }
  }

  return {
    login: vi.fn(),
    create: vi.fn(),
    token: vi.fn(),
    route: vi.fn(),
    processes,
    FakeSupervisor
  }
})

vi.mock('../../src/mms/data/privateAcl', async () => {
  const { mkdirSync } = await import('node:fs')
  return { ensurePrivateDirectory: (root: string) => mkdirSync(root, { recursive: true }) }
})

vi.mock('../../src/mms/netEngine/cloudflare/runtime', () => ({
  cloudflaredEnv: () => ({}),
  resolveCloudflared: async () => 'cloudflared'
}))
vi.mock('../../src/mms/netEngine/cloudflare/cli', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/mms/netEngine/cloudflare/cli')>()),
  CloudflareCli: class {
    login = fixture.login
    createOrRecover = fixture.create
    token = fixture.token
    route = fixture.route
  }
}))
vi.mock('../../src/mms/net/transports/runtime/process', () => ({
  ProcessSupervisor: fixture.FakeSupervisor
}))

const TUNNEL_ID = 'b73d0796-c988-4716-a9a4-9420224df5b1'
const account = { accountId: 'a'.repeat(32), zoneId: 'b'.repeat(32) }
let folder: string
let connection: ManagedCloudflare

beforeEach(async () => {
  vi.clearAllMocks()
  fixture.processes.length = 0
  fixture.login.mockResolvedValue(account)
  fixture.create.mockResolvedValue(TUNNEL_ID)
  fixture.token.mockResolvedValue(Buffer.from(JSON.stringify({
    a: account.accountId, t: TUNNEL_ID, s: Buffer.alloc(32).toString('base64')
  })).toString('base64'))
  fixture.route.mockImplementation(async (_id: string, label: string) => `${label}.example.net`)
  folder = await mkdtemp(join(tmpdir(), 'mousse-named-tunnel-test-'))
  connection = new ManagedCloudflare(join(folder, 'tunnel'), join(folder, 'runtime'), () => undefined)
})

afterEach(async () => {
  await connection.useOrigin(undefined)
  await rm(folder, { recursive: true, force: true })
})

function origin(port: number) {
  return { port, test: vi.fn<() => Promise<boolean>>(), advertise: vi.fn(async () => undefined) }
}

describe('managed Cloudflare tunnel', () => {
  it('publishes only after verification and reconnects with the same hostname on a new helper', async () => {
    const first = origin(47101)
    let allowProbe!: (ok: boolean) => void
    first.test.mockImplementation(() => new Promise<boolean>((resolve) => { allowProbe = resolve }))
    await connection.useOrigin(first)
    connection.start()
    connection.start()

    await vi.waitFor(() => expect(fixture.processes, JSON.stringify(connection.status())).toHaveLength(1))
    expect(fixture.login).toHaveBeenCalledTimes(1)
    expect(first.advertise).not.toHaveBeenCalled()
    fixture.processes[0].ready()
    await vi.waitFor(() => expect(first.test).toHaveBeenCalledTimes(1))
    expect(first.advertise).not.toHaveBeenCalled()
    allowProbe(true)

    await vi.waitFor(() => expect(connection.status()?.state).toBe('connected'))
    const address = connection.status()?.hostname
    const route = `wss://${address}/mousse-net/1`
    expect(first.advertise).toHaveBeenCalledWith(route)
    expect(await readdir(join(folder, 'tunnel'))).not.toContainEqual(expect.stringMatching(/^login-/))

    fixture.processes[0].ready(1)
    fixture.processes[0].lost()
    expect(connection.status()?.state).toBe('connected')
    vi.useFakeTimers()
    try {
      fixture.processes[0].lost(1)
      expect(first.advertise).toHaveBeenLastCalledWith(null)
      await vi.advanceTimersByTimeAsync(120_000)
      expect(fixture.processes[0].stop).not.toHaveBeenCalled()
      expect(connection.status()).toMatchObject({ state: 'reconnecting', message: expect.stringContaining('Check') })
    } finally {
      vi.useRealTimers()
    }
    first.test.mockResolvedValue(true)
    fixture.processes[0].ready()
    await vi.waitFor(() => expect(connection.status()?.state).toBe('connected'))
    expect(connection.status()?.message).toBeUndefined()

    await connection.useOrigin(undefined)
    expect(first.advertise).toHaveBeenLastCalledWith(null)
    expect(fixture.processes[0].stop).toHaveBeenCalledTimes(1)

    const next = origin(47109)
    next.test.mockResolvedValue(true)
    await connection.useOrigin(next)
    await vi.waitFor(() => expect(fixture.processes).toHaveLength(2))
    fixture.processes[1].ready()
    await vi.waitFor(() => expect(connection.status()?.state).toBe('connected'))
    expect(connection.status()?.hostname).toBe(address)
    expect(next.advertise).toHaveBeenCalledWith(route)
    expect(fixture.login).toHaveBeenCalledTimes(1)
    expect(fixture.create).toHaveBeenCalledTimes(1)

    await connection.stop()
    expect(next.advertise).toHaveBeenLastCalledWith(null)
    expect(connection.status()).toMatchObject({ state: 'off', hostname: address })
    await connection.useOrigin(origin(47110))
    expect(fixture.processes).toHaveLength(2)
  })

  it('cancels browser sign-in without provisioning or keeping its scratch directory', async () => {
    fixture.login.mockImplementation((signal: AbortSignal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
    }))
    await connection.useOrigin(origin(47101))
    connection.start()
    await vi.waitFor(() => expect(fixture.login).toHaveBeenCalled())
    await connection.stop()

    expect(connection.status()).toEqual({ state: 'off' })
    expect(fixture.create).not.toHaveBeenCalled()
    expect(fixture.processes).toHaveLength(0)
    expect(await readdir(join(folder, 'tunnel'))).toEqual([])
  })

  it('reuses the saved setup on retry and lets a person forget it to choose another domain', async () => {
    fixture.token.mockRejectedValueOnce(new Error('Token request failed'))
    fixture.token.mockRejectedValueOnce(new Error('Token request failed'))
    await connection.useOrigin(origin(47101))
    connection.start()
    await vi.waitFor(() => expect(connection.status()).toMatchObject({ state: 'failed', canForget: true }))
    const [label, secret] = fixture.create.mock.calls[0]

    connection.start()
    await vi.waitFor(() => expect(connection.status()).toMatchObject({ state: 'failed', canForget: true }))
    expect(fixture.create).toHaveBeenLastCalledWith(label, secret, expect.any(AbortSignal))

    fixture.login.mockResolvedValue({ ...account, zoneId: 'c'.repeat(32) })
    connection.start()
    await vi.waitFor(() => expect(connection.status()?.message).toContain('forget this setup'))
    expect(fixture.create).toHaveBeenCalledTimes(2)

    await connection.forget()
    expect(connection.status()).toEqual({ state: 'off' })
    expect(await readdir(join(folder, 'tunnel'))).toEqual([])
    connection.start()
    await vi.waitFor(() => expect(fixture.processes).toHaveLength(1))
    expect(fixture.create.mock.lastCall?.[0]).not.toBe(label)
  })
})
