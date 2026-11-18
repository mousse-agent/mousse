/**
 * The test link of a cross-machine cell (design §9): how the caller's run drives its host's run. The host
 * (`MOUSSE_NET_ENGINE_CHECK_ROLE=host`) listens on `MOUSSE_NET_ENGINE_CHECK_LINK_PORT` (47190) on every interface; the
 * caller dials it at `MOUSSE_NET_ENGINE_CHECK_HOST` (the host's local network address). The caller asks, the host
 * answers, one JSON line each; the caller ends the run with `done`, and its reason, if any, is the host's too.
 *
 * The host's computers (`hostSide`) say Yes to whoever joins them (the approval is injected, as the ticket is) and
 * answer what the caller asks about them: their rows, their grants, a dial, a helper restart, a terminal. Their
 * shells are fake and echo each line written to them as `echo:<line>`.
 *
 * Without a role, a cell runs both sides in one process over `localLink`, on one fabric.
 *
 * Its defaults are named here, each with its variable: the link's port, how long either side waits for the other
 * (`MOUSSE_NET_ENGINE_CHECK_LINK_WAIT_MS`, 30 min) and for one answer (`MOUSSE_NET_ENGINE_CHECK_ASK_MS`, 2 min), and
 * where and how long a computer looks for the internet (`MOUSSE_NET_ENGINE_CHECK_INTERNET_PROBES`, three public DNS
 * services on port 443; `MOUSSE_NET_ENGINE_CHECK_PROBE_MS`, 3 s).
 */
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { connect, createServer, type Socket } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Spawned } from '../../net/bridge/routed/terminalFixture'
import { approveAll, codeOf, deviceState, type Computer, type Fabric } from './harness'

export type Role = 'host' | 'caller'

/** This run's side of a cross-machine cell; undefined when both run here. */
export function linkRole(): Role | undefined {
  const role = process.env.MOUSSE_NET_ENGINE_CHECK_ROLE?.trim()
  return role === 'host' || role === 'caller' ? role : undefined
}

/** The cell's endpoints (`--topology`), or `fallback`. */
export function topology(fallback: string): string {
  return process.env.MOUSSE_NET_ENGINE_CHECK_TOPOLOGY?.trim() || fallback
}

const LINK_PORT = Number(process.env.MOUSSE_NET_ENGINE_CHECK_LINK_PORT || 47190)
/** How long a caller keeps trying to reach its host, and a host waits for its caller to finish. */
const LINK_WAIT_MS = Number(process.env.MOUSSE_NET_ENGINE_CHECK_LINK_WAIT_MS || 30 * 60_000)
const ASK_MS = Number(process.env.MOUSSE_NET_ENGINE_CHECK_ASK_MS || 120_000)

type Handlers = Record<string, (args: any) => Promise<unknown> | unknown>

export interface Link {
  /** Runs the host's `op`; rejects with the host's error, its `code` the reason the host gave. */
  ask<T = any>(op: string, args?: unknown): Promise<T>
  /** Ends the run on the host, with the caller's reason when it failed. */
  done(reason?: string): Promise<void>
}

function linkError(message: string, reason?: string): Error {
  return Object.assign(new Error(message), reason ? { code: reason } : {})
}

async function answer(handlers: Handlers, op: string, args: unknown) {
  const handler = handlers[op]
  if (!handler) return { ok: false, error: `no op ${op}` }
  try {
    return { ok: true, value: (await handler(args)) ?? null }
  } catch (error) {
    return { ok: false, error: String((error as Error)?.message ?? error), reason: codeOf(error) }
  }
}

/** Both sides in one process. */
export function localLink(handlers: Handlers): Link & { ended: Promise<string | undefined> } {
  let end!: (reason: string | undefined) => void
  const ended = new Promise<string | undefined>((resolve) => (end = resolve))
  return {
    ended,
    ask: async (op, args) => {
      const reply = await answer(handlers, op, args)
      if (!reply.ok) throw linkError(`${op}: ${reply.error}`, reply.reason)
      return reply.value as never
    },
    done: async (reason) => end(reason)
  }
}

/** One JSON line at a time from `socket`. */
function lines(socket: Socket, onLine: (message: any) => void): void {
  let buffer = ''
  socket.setEncoding('utf8')
  socket.on('data', (text: string) => {
    buffer += text
    for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
      const line = buffer.slice(0, at)
      buffer = buffer.slice(at + 1)
      if (line.trim()) onLine(JSON.parse(line))
    }
  })
}

/** The host's side: answers one caller at a time until one says `done`; resolves with its reason. */
export function serveLink(handlers: Handlers): Promise<string | undefined> {
  return new Promise((resolveDone, reject) => {
    const server = createServer((socket) => {
      socket.on('error', () => undefined)
      lines(socket, (message) => {
        if (message.t === 'done') {
          socket.end(`${JSON.stringify({ t: 'bye' })}\n`)
          server.close()
          clearTimeout(timer)
          resolveDone(message.reason || undefined)
          return
        }
        void answer(handlers, message.op, message.args).then((reply) => {
          if (!socket.destroyed)
            socket.write(`${JSON.stringify({ t: 'answer', id: message.id, ...reply })}\n`)
        })
      })
    })
    const timer = setTimeout(() => {
      server.close()
      reject(linkError(`no caller finished within ${LINK_WAIT_MS} ms`, 'no_caller'))
    }, LINK_WAIT_MS)
    server.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    server.listen(LINK_PORT, '0.0.0.0', () =>
      console.log(`host: test link on port ${LINK_PORT}; waiting for the caller`)
    )
  })
}

/** The caller's side: dials its host, trying again until the host listens. */
export async function dialLink(): Promise<Link> {
  const host = process.env.MOUSSE_NET_ENGINE_CHECK_HOST?.trim()
  if (!host)
    throw linkError("set MOUSSE_NET_ENGINE_CHECK_HOST to the host computer's address", 'no_host')
  const [address, port] = host.includes(':')
    ? [host.slice(0, host.lastIndexOf(':')), Number(host.slice(host.lastIndexOf(':') + 1))]
    : [host, LINK_PORT]
  const until = Date.now() + LINK_WAIT_MS
  let socket: Socket | undefined
  while (!socket) {
    socket = await new Promise<Socket | undefined>((done) => {
      const attempt = connect({ host: address, port }, () => done(attempt))
      attempt.once('error', () => done(undefined))
    })
    if (!socket) {
      if (Date.now() > until)
        throw linkError(`the host at ${address}:${port} did not answer`, 'no_host')
      await new Promise((done) => setTimeout(done, 1_000))
    }
  }
  const open = socket
  const waiting = new Map<
    number,
    { resolve: (value: any) => void; reject: (error: Error) => void }
  >()
  let next = 0
  let closed: Error | undefined
  lines(open, (message) => {
    const asked = waiting.get(message.id)
    if (message.t !== 'answer' || !asked) return
    waiting.delete(message.id)
    if (message.ok) asked.resolve(message.value)
    else asked.reject(linkError(message.error, message.reason))
  })
  const lost = () => {
    closed = linkError('the test link to the host closed', 'host_gone')
    for (const asked of waiting.values()) asked.reject(closed)
    waiting.clear()
  }
  open.on('close', lost)
  open.on('error', () => undefined)
  return {
    ask: (op, args) =>
      new Promise((resolveAsk, reject) => {
        if (closed) return reject(closed)
        const id = ++next
        const timer = setTimeout(() => {
          waiting.delete(id)
          reject(linkError(`the host did not answer ${op} within ${ASK_MS} ms`, 'host_gone'))
        }, ASK_MS)
        waiting.set(id, {
          resolve: (value) => (clearTimeout(timer), resolveAsk(value)),
          reject: (error) => (clearTimeout(timer), reject(error))
        })
        open.write(`${JSON.stringify({ t: 'ask', id, op, args })}\n`)
      }),
    done: async (reason) => {
      if (closed) return
      await new Promise<void>((done) => {
        open.once('close', () => done())
        open.write(`${JSON.stringify({ t: 'done', reason })}\n`)
        setTimeout(done, 5_000)
      })
    }
  }
}

/** This app checkout's build, as `scripts/net-engine-check.mjs` names it. */
function appBuild(): string {
  if (process.env.MOUSSE_NET_ENGINE_CHECK_APP_BUILD)
    return process.env.MOUSSE_NET_ENGINE_CHECK_APP_BUILD
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
  try {
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8'
    }).trim()
    const dirty =
      execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim() !== ''
    return `${commit}${dirty ? '-dirty' : ''}`
  } catch {
    return 'unknown'
  }
}

/** Where the internet is looked for: well-known public addresses. */
const PROBES = (
  process.env.MOUSSE_NET_ENGINE_CHECK_INTERNET_PROBES || '1.1.1.1:443,8.8.8.8:443,9.9.9.9:443'
)
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean)
const PROBE_MS = Number(process.env.MOUSSE_NET_ENGINE_CHECK_PROBE_MS || 3_000)

/** The first public address this computer reaches, or undefined when it reaches none: the internet is unreachable. */
export async function internetReached(): Promise<string | undefined> {
  const reached = await Promise.all(
    PROBES.map(
      (probe) =>
        new Promise<string | undefined>((done) => {
          const at = probe.lastIndexOf(':')
          const socket = connect({ host: probe.slice(0, at), port: Number(probe.slice(at + 1)) })
          const finish = (value: string | undefined) => {
            clearTimeout(timer)
            socket.destroy()
            done(value)
          }
          const timer = setTimeout(() => finish(undefined), PROBE_MS)
          socket.once('connect', () => finish(probe))
          socket.once('error', () => finish(undefined))
        })
    )
  )
  return reached.find(Boolean)
}

/** What a caller heard of its host's builds, kept in the run's folder for `scripts/net-engine-check.mjs`. */
export function keepHostBuilds(hello: { host_build: string; host_app_build: string }): void {
  const out = process.env.MOUSSE_NET_ENGINE_CHECK_OUT
  if (!out) return
  writeFileSync(join(out, 'host_build'), hello.host_build)
  writeFileSync(join(out, 'host_app_build'), hello.host_app_build)
}

/** The row `on` keeps for the endpoint `endpoint`, in any state but removed. */
function rowOf(on: Computer, endpoint: string) {
  return on.mms.netEngine
    .peerRows()
    .find((row) => row.endpoint === endpoint && row.state !== 'removed')
}

/**
 * What the host's computers answer over the link. `online` is whether the host itself reaches the internet (only
 * asked across machines).
 */
export function hostSide(
  fabric: Fabric,
  computers: Map<string, Computer>,
  probe: boolean,
  /** The reason the host's own setup failed with, told to the caller. */
  failed?: string
): Handlers {
  const stops: Array<() => void> = []
  const shells = new Map<string, Spawned[]>()
  for (const [name, computer] of computers) shells.set(name, fabric.shells(computer, echo))
  const get = (name: string) => {
    const computer = computers.get(name)
    if (!computer) throw new Error(`no computer ${name} here`)
    return computer
  }
  const node = (name: string, endpoint: string) => {
    const row = rowOf(get(name), endpoint)
    if (!row) throw linkError(`${name} has no row for ${endpoint}`, 'not_paired')
    return row.localId
  }
  return {
    hello: async () => ({
      host_build: process.env.MOUSSE_NET_ENGINE_HELPER_BUILD || 'unknown',
      host_app_build: appBuild(),
      online: probe ? ((await internetReached()) ?? null) : null,
      failed: failed ?? null,
      endpoints: Object.fromEntries(
        [...computers].map(([name, computer]) => [name, computer.endpoint])
      )
    }),
    invite: async ({ name }: { name: string }) => {
      const computer = get(name)
      stops.push(approveAll(computer))
      return (await computer.dispatch('netEngine.invite', {}, true)).uri
    },
    /** What `name`'s Devices list shows for `endpoint` (`none` without a row). */
    state: ({ name, endpoint }: { name: string; endpoint: string }) => {
      const row = rowOf(get(name), endpoint)
      return row ? (deviceState(get(name), row.localId) ?? row.state) : 'none'
    },
    online: ({ name, endpoint }: { name: string; endpoint: string }) => {
      const row = rowOf(get(name), endpoint)
      return !!row && get(name).mms.netEngine.online(row.localId)
    },
    dial: async ({ name, endpoint }: { name: string; endpoint: string }) =>
      fabric.connect(get(name), node(name, endpoint)),
    grants: async ({ name }: { name: string }) =>
      ((await get(name).engine.request('grants.list')).grants as Array<{ identity: string }>).map(
        (grant) => grant.identity
      ),
    allowTerminal: ({ name, endpoint }: { name: string; endpoint: string }) =>
      get(name).dispatch('bridge.policy', { node: node(name, endpoint), terminal: true }, true),
    restartHelper: ({ name }: { name: string }) => fabric.restartHelper(get(name)),
    shells: ({ name }: { name: string }) => shells.get(name)?.length ?? 0,
    /** A new project folder on the host. */
    folder: () => fabric.folder(),
    stopApproving: () => {
      for (const stop of stops.splice(0)) stop()
    }
  }
}

/** A fake shell that writes each line it is given back as `echo:<line>`. */
function echo(shell: Spawned): void {
  const write = shell.pty.write.bind(shell.pty)
  let pending = ''
  shell.pty.write = (data: string) => {
    write(data)
    pending += data
    for (let at = pending.search(/[\r\n]/); at >= 0; at = pending.search(/[\r\n]/)) {
      const line = pending.slice(0, at)
      pending = pending.slice(at + 1)
      if (line) shell.pty.say(`echo:${line}\r\n`)
    }
  }
}
