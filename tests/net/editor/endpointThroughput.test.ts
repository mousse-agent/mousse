import { spawn } from 'node:child_process'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { daemonBed, type DaemonBed } from '../helpers/editorDaemonBed'
import { endpointBed, type Bed } from '../helpers/endpointBed'

vi.mock('../../../src/mms/net/editor/sshConfig', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/mms/net/editor/sshConfig')>()),
  systemSshVerifier: () => async () => ({ ok: true as const })
}))

/**
 * Throughput smoke tests with a floor, so that a regression shows. They are floors and not benchmarks: a developer's
 * computer is several times faster.
 *
 * - **The endpoint alone** (a client of the `ssh2` library in this process, over a pair of streams): the SSH layer,
 *   its ciphers, its channel windows and the pipes of a real program. Floors of 20 MiB/s each way. The event loop of
 *   the process is watched, because the crypto runs on the daemon's thread.
 * - **The whole path** (the system `ssh`, the proxy, the daemon, a Mousse Net session over loopback TLS, the tunnel,
 *   the endpoint). The floor here only catches a stall: the tunnel of a Net session carries a few MiB/s today, which
 *   is the session's and not the endpoint's (a tunnel to a plain socket with no SSH in it moves the same).
 */

const unix = process.platform !== 'win32'
vi.setConfig({ testTimeout: 240_000, hookTimeout: 120_000 })
const MIB = 1024 * 1024
const ENDPOINT_FLOOR_MIBS = 20
const PATH_FLOOR_MIBS = 0.5
/** The longest the event loop of a daemon may be held in one piece while an editor transfer runs, at the 99th percentile. */
const LOOP_P99_CEILING_MS = 250

const ms = (nanoseconds: number): string => (nanoseconds / 1e6).toFixed(1)
const rate = (mib: number, seconds: number): number => mib / seconds

describe.skipIf(!unix)('throughput of the endpoint alone', () => {
  let b: Bed
  beforeAll(async () => {
    b = await endpointBed()
  })
  afterAll(async () => {
    await b?.close()
  })

  it('moves 256 MiB each way above the floor, and the event loop stays free', async () => {
    const { client } = await b.connect()
    const loop = monitorEventLoopDelay({ resolution: 5 })
    loop.enable()

    const down = await new Promise<number>((resolve, reject) => {
      const started = process.hrtime.bigint()
      client.exec(`head -c ${256 * MIB} /dev/zero`, (error, channel) => {
        if (error) return reject(error)
        let received = 0
        channel.on('data', (chunk: Buffer) => (received += chunk.length))
        channel.stderr.on('data', () => {})
        channel.on('close', () => {
          expect(received).toBe(256 * MIB)
          resolve(rate(256, Number(process.hrtime.bigint() - started) / 1e9))
        })
      })
    })
    const up = await new Promise<number>((resolve, reject) => {
      const started = process.hrtime.bigint()
      client.exec('cat > /dev/null', (error, channel) => {
        if (error) return reject(error)
        const chunk = Buffer.alloc(256 * 1024, 7)
        let sent = 0
        const pump = (): void => {
          while (sent < 256 * MIB) {
            sent += chunk.length
            if (!channel.write(chunk)) return void channel.once('drain', pump)
          }
          channel.end()
        }
        channel.on('data', () => {})
        channel.on('close', () =>
          resolve(rate(256, Number(process.hrtime.bigint() - started) / 1e9))
        )
        pump()
      })
    })
    loop.disable()
    console.info(
      `endpoint alone: down ${down.toFixed(0)} MiB/s, up ${up.toFixed(0)} MiB/s; event-loop delay of this process (the endpoint and a client of the library share it): p50 ${ms(loop.percentile(50))} ms, p99 ${ms(loop.percentile(99))} ms, max ${ms(loop.max)} ms`
    )
    expect(down).toBeGreaterThan(ENDPOINT_FLOOR_MIBS)
    expect(up).toBeGreaterThan(ENDPOINT_FLOOR_MIBS)
    expect(loop.percentile(99) / 1e6).toBeLessThan(LOOP_P99_CEILING_MS)
  })
})

describe.skipIf(!unix)('throughput of the whole path', () => {
  const cleanup: Array<() => unknown> = []
  afterEach(async () => {
    for (const task of cleanup.splice(0).reverse()) await task()
  })
  let b: DaemonBed
  beforeAll(async () => {
    b = await daemonBed()
  })
  afterAll(async () => {
    await b?.close()
  })

  function transfer(command: string, send: number): Promise<{ seconds: number; received: number }> {
    return new Promise((resolve, reject) => {
      const started = process.hrtime.bigint()
      const child = spawn('ssh', [...b.sshArgs, 'mousse-owner', command], {
        env: { PATH: process.env.PATH, HOME: b.userHome },
        stdio: ['pipe', 'pipe', 'pipe']
      })
      cleanup.push(() => child.kill('SIGKILL'))
      let received = 0
      child.stdout.on('data', (chunk: Buffer) => (received += chunk.length))
      child.on('error', reject)
      child.on('close', (code) => {
        if (code !== 0) return reject(new Error(`ssh exited ${code}`))
        resolve({ seconds: Number(process.hrtime.bigint() - started) / 1e9, received })
      })
      child.stdin.on('error', () => {})
      if (send === 0) return void child.stdin.end()
      const chunk = Buffer.alloc(256 * 1024, 7)
      let sent = 0
      const pump = (): void => {
        while (sent < send) {
          const piece = chunk.subarray(0, Math.min(chunk.length, send - sent))
          sent += piece.length
          if (!child.stdin.write(piece)) return void child.stdin.once('drain', pump)
        }
        child.stdin.end()
      }
      pump()
    })
  }

  it('moves 16 MiB each way, with the daemon’s event loop watched', async () => {
    // One warm-up connection, so the numbers are of a transfer and not of the first tunnel.
    await transfer('true', 0)
    const loop = monitorEventLoopDelay({ resolution: 5 })
    loop.enable()
    const down = await transfer(`head -c ${16 * MIB} /dev/zero`, 0)
    const up = await transfer('cat > /dev/null', 16 * MIB)
    loop.disable()
    expect(down.received).toBe(16 * MIB)
    const downRate = rate(16, down.seconds)
    const upRate = rate(16, up.seconds)
    console.info(
      `whole path: down ${downRate.toFixed(1)} MiB/s, up ${upRate.toFixed(1)} MiB/s; event-loop delay of the process that holds the daemon, the owner's Net service and the endpoint: mean ${ms(loop.mean)} ms, p99 ${ms(loop.percentile(99))} ms, max ${ms(loop.max)} ms`
    )
    expect(downRate).toBeGreaterThan(PATH_FLOOR_MIBS)
    expect(upRate).toBeGreaterThan(PATH_FLOOR_MIBS)
    expect(loop.percentile(99) / 1e6).toBeLessThan(LOOP_P99_CEILING_MS)
  })
})
