/**
 * Owner check `phase1b.routes-cross`, a cross-machine cell (`pc-to-mac-lan`) run once per route (`--route`, 1b §14):
 * the PC dials the Mac, and only that way. Every connection comes up on the route under test (`conn.up.route`, the
 * PC's of its class too), else the run fails with `route_mismatch`; a request to Plus is recorded and any other
 * egress refused (the harness's guard, beside the kit's).
 *
 * - `tcp`: the Mac's helper listens on its local network address. Its ticket offers only the PC's loopback stand-in,
 *   which carries each connection there and which the PC's class map gives the tailnet class.
 * - `ws`: the Mac's tunnel stand-in, on its local network address, with a certificate from the run's test root that
 *   the PC's helper trusts.
 * - `ssh`: the kit's test SSH server on the Mac (on its loopback), reached through a forwarder on the Mac's local
 *   network address.
 *
 * tcp and ws pair by fixture, one way (1b §14): the Mac grants the PC, and the PC pins the Mac with the routes of
 * its invitation, the ticket handed over as `phase1a.pair-offline` hands it; the Mac never dials the PC. ssh pairs by
 * a real Add over SSH from the PC, one way. The PC then opens a remote thread on the Mac and a terminal
 * in it, which answers.
 *
 * `scripts/net-engine-check.mjs phase1b.routes-cross --role host --route <case>` on the Mac, and `--role caller
 * --route <case>` on the PC with `MOUSSE_NET_ENGINE_CHECK_HOST` and `MOUSSE_NET_TEST_EGRESS` the Mac's address, run
 * it with the real helper. It has no one-computer form.
 */
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { connect, createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { ensurePrivateDirectory } from '../../../src/mms/data/privateAcl'
import { readTicket } from '../../../src/mms/netEngine/ticket'
import type { NodeId } from '../../../src/shared/net'
import { PROJECT_SHELL_AGENT_ID } from '../../../src/shared/types'
import {
  CHECK_CLASS,
  CHECK_ROUTE,
  eventually,
  expectedRoute,
  Fabric,
  REAL_HELPER,
  recordedReason,
  step,
  terminalOutput,
  type Computer
} from './harness'
import {
  bothConnected,
  dialLink,
  hostAddress,
  hostSide,
  keepHostBuilds,
  linkRole,
  rowOf,
  serveLink,
  type Link
} from './link'

const ROLE = linkRole()
const RUN_MS = 40 * 60_000
/** The host's test SSH server, as its entry names it. */
const SSH_ALIAS = 'mousse-check-mac'

const fail = (reason: string, message: string) =>
  step(reason, () => {
    throw new Error(message)
  })

/** What the Mac tells the PC of its SSH route: its entry, through the forwarder, and the client key it accepts. */
interface SshEntry {
  alias: string
  selector: string
  port: number
  user: string
  key: string
}

describe('phase1b.routes-cross', () => {
  const fabric = new Fabric()
  const closers: Array<() => unknown> = []
  afterAll(async () => {
    for (const close of closers.splice(0).reverse()) await close()
    await fabric.close()
  }, 120_000)

  async function setup(): Promise<void> {
    if (!REAL_HELPER) await fail('no_helper', 'a cross-machine cell runs with MOUSSE_NET_HELPER')
    if (!CHECK_ROUTE) await fail('no_route', 'give --route tcp|ws|ssh')
  }

  it.runIf(ROLE === 'host')(
    `hosts the Mac over ${CHECK_ROUTE}`,
    async () => {
      await setup()
      const mac = await step(undefined, () => fabric.computer('mac'))
      const reason = await serveLink({
        ...hostSide(fabric, new Map([['mac', mac]]), false),
        grant: ({ endpoint }: { endpoint: string }) =>
          fabric.fixtureGrant(mac, endpoint, 'pc computer'),
        tcpRoute: ({ route, address }: { route: string; address: string }) =>
          fabric.crossTcp(mac, route, address),
        wsRoute: ({ address }: { address: string }) => fabric.crossTunnel(mac, address),
        sshRoute: async ({ address }: { address: string }): Promise<SshEntry> => {
          const ssh = await fabric.crossSsh(mac, SSH_ALIAS)
          const config = readFileSync(ssh.config, 'utf8')
          const port = Number(/^\s*Port\s+(\d+)\s*$/m.exec(config)?.[1])
          const user = /^\s*User\s+(\S+)\s*$/m.exec(config)?.[1] ?? 'tester'
          const relay = await forwarder(address, () => ({ host: '127.0.0.1', port }))
          closers.push(relay.close)
          return {
            alias: ssh.alias,
            selector: ssh.selector,
            port: relay.port,
            user,
            key: readFileSync(join(dirname(ssh.config), 'client_ed25519'), 'utf8')
          }
        },
        /** Whether a connection from `endpoint` came up on the Mac. */
        heard: ({ endpoint }: { endpoint: string }) =>
          fabric.announced.some((up) => up.identity === endpoint),
        /** Every connection the Mac's helper reported, by its route. */
        routes: () => fabric.routesSeen.map((seen) => seen.route)
      })
      if (reason) await fail(reason, `the caller failed: ${reason}`)
    },
    RUN_MS
  )

  it.runIf(ROLE === 'caller')(
    `dials the Mac over ${CHECK_ROUTE}, opens a thread and a terminal there`,
    async () => {
      await setup()
      const link = await step(undefined, () => dialLink())
      try {
        await routesCross(link)
      } finally {
        await link.done(recordedReason())
      }
    },
    RUN_MS
  )

  async function routesCross(link: Link): Promise<void> {
    const hello = await step(undefined, () => link.ask('hello'))
    keepHostBuilds(hello)
    if (hello.failed) await fail(hello.failed, `the host did not start: ${hello.failed}`)
    const mac = hello.endpoints.mac as string
    const address = hostAddress()
    const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'engine-check-cross-')))
    closers.push(() => rmSync(scratch, { recursive: true, force: true }))

    // The route, set up on the Mac, and what the PC's helper reads of it before it starts.
    let ssh: SshEntry | undefined
    if (CHECK_ROUTE === 'tcp') {
      let macPort: number | undefined
      const standIn = await forwarder('127.0.0.1', () =>
        macPort === undefined ? undefined : { host: address, port: macPort }
      )
      closers.push(standIn.close)
      // The PC's helper and app read the map once.
      process.env.MOUSSE_NET_TEST_CLASS_MAP = `${standIn.port}=${CHECK_CLASS}`
      macPort = await step(undefined, () =>
        link.ask<number>('tcpRoute', { route: `tcp://127.0.0.1:${standIn.port}`, address })
      )
    } else if (CHECK_ROUTE === 'ws') {
      const { root } = await step(undefined, () => link.ask('wsRoute', { address }))
      const file = join(scratch, 'root.der')
      writeFileSync(file, Buffer.from(root as string, 'base64'))
      process.env.MOUSSE_NET_TEST_EXTRA_ROOT = file
    } else {
      ssh = await step(undefined, () => link.ask<SshEntry>('sshRoute', { address }))
      // OpenSSH reads a key only from a folder the PC's other accounts cannot read.
      const keys = join(scratch, 'ssh')
      ensurePrivateDirectory(keys)
      const key = join(keys, 'client_ed25519')
      writeFileSync(key, ssh.key, { mode: 0o600 })
      const knownHosts = join(keys, 'known_hosts')
      writeFileSync(knownHosts, '')
      const config = join(keys, 'ssh_config')
      writeFileSync(
        config,
        [
          `Host ${ssh.alias}`,
          `  HostName ${address}`,
          `  Port ${ssh.port}`,
          `  User ${ssh.user}`,
          `  IdentityFile ${quoted(key)}`,
          '  IdentitiesOnly yes',
          '  IdentityAgent none',
          `  UserKnownHostsFile ${quoted(knownHosts)}`,
          ''
        ].join('\n')
      )
      process.env.MOUSSE_NET_TEST_SSH_CONFIG = config
    }

    const pc = await step(undefined, () => fabric.computer('pc'))
    let node: NodeId
    if (ssh) {
      await step('not_paired', () => addOverSsh(pc, ssh))
      node = rowOf(pc, mac)!.localId
    } else {
      const ticket = await step(undefined, () => link.ask<string>('invite', { name: 'mac' }))
      await step('not_paired', () => link.ask('grant', { endpoint: pc.endpoint }))
      node = await step('not_paired', () =>
        fabric.fixturePin(pc, mac, 'mac computer', readTicket(ticket).routes)
      )
      // One way: the PC is connected to the Mac and the Mac heard it (1a's Devices row wants both ways).
      await step('one_way_stuck', () => fabric.connect(pc, node))
      await step('one_way_stuck', () =>
        eventually(async () => {
          expect(pc.mms.netEngine.online(node)).toBe(true)
          expect(await link.ask('heard', { endpoint: pc.endpoint })).toBe(true)
        }, 60_000)
      )
    }
    if (ssh) await step('one_way_stuck', () => bothConnected(link, pc, node, 'mac'))
    await remoteTerminal(link, pc, node)

    // Every connection either helper reported came up on the route under test.
    const expected = expectedRoute()!
    await step('route_mismatch', async () => {
      expect(fabric.routesSeen.length).toBeGreaterThan(0)
      for (const { route } of fabric.routesSeen) expect(route).toMatchObject(expected)
      const there = await link.ask<Array<{ kind?: string } | null>>('routes')
      expect(there.length).toBeGreaterThan(0)
      for (const route of there) expect(route?.kind).toBe(expected.kind)
    })
  }

  /** The PC adds the Mac over SSH (1b §3.4), as its window does: resolve, probe, trust, connect. */
  async function addOverSsh(pc: Computer, ssh: SshEntry): Promise<void> {
    const resolved = await pc.dispatch('netEngine.ssh.resolve', { target: ssh.alias }, true)
    const host = { routeId: resolved.routeId, host: ssh.alias }
    const probe = await pc.dispatch('netEngine.ssh.probe', host, true)
    await pc.dispatch('netEngine.ssh.trust', { ...host, sha256: probe.sha256 }, true)
    await pc.dispatch(
      'netEngine.ssh.connect',
      { ...host, target: ssh.alias, user: resolved.user, selector: ssh.selector },
      true
    )
  }

  /** The PC opens a project and a thread on the Mac, and a terminal in it that answers a line. */
  async function remoteTerminal(link: Link, pc: Computer, node: NodeId): Promise<void> {
    await step(undefined, () => link.ask('allowTerminal', { name: 'mac', endpoint: pc.endpoint }))
    await step(undefined, () => fabric.connect(pc, node))
    const path = await step(undefined, () => link.ask('folder'))
    const project = await step(undefined, () => pc.dispatch('projects.open', { node, path }))
    const created = await step(undefined, () =>
      pc.dispatch('threads.create', {
        node,
        name: 'Cross',
        projectId: (project.project ?? project).id
      })
    )
    const threadId = (created.thread ?? created).id as string
    await step(undefined, () => pc.dispatch('thread.snapshot', { threadId }))
    const { ptyId } = await step(undefined, () =>
      pc.dispatch('pty.create', { threadId, agentId: `${PROJECT_SHELL_AGENT_ID}:tab-1` })
    )
    await step(undefined, () =>
      eventually(
        () =>
          expect(
            pc.mms.bridge.router.terminals
              .state()
              .some((term) => term.ptyId === ptyId && term.attached)
          ).toBe(true),
        20_000
      )
    )
    await step(undefined, async () => {
      await pc.dispatch('pty.write', { threadId, ptyId, data: 'over the route\r' })
      await eventually(
        () => expect(terminalOutput(pc.events, ptyId)).toContain('echo:over the route\r\n'),
        10_000
      )
    })
  }
})

/** A path as an ssh_config value, as the test server writes one: double quotes, `%` doubled. */
function quoted(path: string): string {
  return `"${path.replace(/%/g, '%%')}"`
}

/**
 * A plain TCP forwarder listening on `bind` (loopback, or else every interface): each connection goes on to
 * `target()` (none while it has none).
 */
async function forwarder(
  bind: string,
  target: () => { host: string; port: number } | undefined
): Promise<{ port: number; close: () => Promise<void> }> {
  const open = new Set<Socket>()
  const server = createServer((socket) => {
    const to = target()
    if (!to) return void socket.destroy()
    const onward = connect(to.port, to.host)
    for (const one of [socket, onward]) {
      open.add(one)
      one.on('close', () => open.delete(one))
      one.on('error', () => undefined)
    }
    socket.on('close', () => onward.destroy())
    onward.on('close', () => socket.destroy())
    socket.pipe(onward).pipe(socket)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    // Off loopback, every interface without naming one: the kit's egress guard refuses the lookup an address takes.
    if (/^127\./.test(bind)) server.listen(0, bind, () => resolve())
    else server.listen(0, () => resolve())
  })
  return {
    port: (server.address() as { port: number }).port,
    close: () =>
      new Promise<void>((done) => {
        for (const socket of open) socket.destroy()
        server.close(() => done())
      })
  }
}
