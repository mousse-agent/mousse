import { mkdtemp, rm } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { NetService } from '../../../src/mms/net/NetService'
import { SshBootstrap } from '../../../src/mms/net/ssh/bootstrap'
import { RemoteHost } from '../../../src/mms/net/ssh/remote'
import { sshKnownHostsPath } from '../../../src/mms/net/transports/ssh'
import { newId, type NodeId } from '../../../src/shared/net'

/**
 * Opt-in checks with the real `ssh` against the developer's own sshd on localhost. They never reach
 * another machine, and they are not part of the branch test selection. Run with `MOUSSE_SSH_E2E=1`
 * and a localhost sshd that accepts your key (agent or key file) with TCP forwarding allowed. The
 * tests were written for the reviewer's and the author's machines and have not been run in CI.
 */
const enabled = process.env.MOUSSE_SSH_E2E === '1'
const cleanup: Array<() => Promise<unknown> | unknown> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

async function profile(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  cleanup.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

function bootstrapFor(profileDir: string, node: () => NodeId | undefined): SshBootstrap {
  const ssh = new SshBootstrap(
    {
      profileDir,
      inviteNode: async () => ({ invite: 'mj1_x', inviteId: newId('invite') }),
      inviteOutcome: () => ({ state: 'missing' }),
      revokeInvite: () => {},
      revokeNode: async () => {},
      openEnrollmentListener: async () => ({ port: 1, close: async () => {} }),
      adoptRoutes: () => {},
      peerOpen: () => false,
      knownNode: (candidate) => candidate === node()
    },
    { binary: () => undefined }
  )
  cleanup.push(() => ssh.close())
  return ssh
}

it.skipIf(!enabled)(
  'reads the host key and passes the forwarding probe against localhost',
  async () => {
    const ssh = bootstrapFor(await profile('mousse-ssh-e2e-'), () => undefined)
    const first = await ssh.check('localhost')
    expect(first.phase).toBe('untrusted')
    expect(first.hostKey?.fingerprint).toMatch(/^SHA256:/)
    const trusted = await ssh.trust({ host: 'localhost', fingerprint: first.hostKey!.fingerprint })
    expect(trusted.ok).toBe(true)
    const probed = await ssh.check('localhost')
    expect(probed.phase).toBe('probed')
    // `connect failed` (forwarding allowed, port 1 closed) is the pass signal, and it is only
    // logged at INFO, which the probe asks for.
    const forwarding = probed.prerequisites.find((item) => /TCP forwarding/.test(item.name))
    expect(forwarding?.ok).toBe(true)
    expect(forwarding?.indeterminate).toBeUndefined()
  },
  60_000
)

it.skipIf(!enabled)(
  'joins through a real reverse tunnel, then the authority dials the member over a real ssh -W',
  async () => {
    const authorityDir = await profile('mousse-ssh-e2e-a-'),
      memberDir = await profile('mousse-ssh-e2e-b-')
    const authority = new NetService({ profileDir: authorityDir })
    const member = new NetService({ profileDir: memberDir })
    cleanup.push(
      () => authority.shutdown(),
      () => member.shutdown()
    )
    await authority.request('net.init', { listen: true, port: 0 })
    await authority.request('net.protect', { passphrase: 'e2e authority passphrase' })

    // The authority trusts localhost's key in its own known_hosts, as the dialog would.
    let joinedNode: NodeId | undefined
    const ssh = bootstrapFor(authorityDir, () => joinedNode)
    const first = await ssh.check('localhost')
    await ssh.trust({ host: 'localhost', fingerprint: first.hostKey!.fingerprint })
    expect((await ssh.check('localhost')).phase).toBe('probed')

    // Real `ssh -R`: the member reaches the authority's enrollment listener through sshd.
    const listener = await (
      authority as unknown as {
        openEnrollmentListener(): Promise<{ port: number; close(): Promise<void> }>
      }
    ).openEnrollmentListener()
    cleanup.push(() => listener.close())
    const remotePort = 40000 + Math.floor(Math.random() * 20000)
    const tunnel = new AbortController()
    const remote = new RemoteHost(
      {
        binary: 'ssh',
        knownHosts: sshKnownHostsPath(authorityDir),
        userKnownHosts: join(tmpdir(), 'mousse-ssh-e2e-no-user-known-hosts')
      },
      'localhost',
      tunnel.signal
    )
    const running = remote
      .run('# mousse:e2e-tunnel\nsleep 60\n', {
        timeoutMs: 90_000,
        reverse: { remotePort, localPort: listener.port }
      })
      .catch(() => undefined)
    cleanup.push(async () => {
      tunnel.abort()
      await running
    })
    await vi.waitFor(
      () =>
        new Promise<void>((resolve, reject) => {
          const probe = createConnection(remotePort, '127.0.0.1', () => {
            probe.destroy()
            resolve()
          })
          probe.once('error', reject)
        }),
      { timeout: 20_000, interval: 250 }
    )
    const invite = (await authority.request('bridge.invite', {})) as { invite: string }
    const joined = (await member.request('bridge.join', {
      invite: invite.invite,
      via: `ws://127.0.0.1:${remotePort}/mousse-net`
    })) as { node: NodeId }
    joinedNode = joined.node
    tunnel.abort()
    await running

    // The member listens on a loopback port reachable only through sshd; the authority approves
    // that endpoint here and dials it with `ssh -W`.
    const daemonPort = 40000 + Math.floor(Math.random() * 20000)
    await member.request('net.transport.configure', {
      id: 'ssh',
      enabled: true,
      settings: { endpoint: 'localhost', port: daemonPort }
    })
    const approved = await ssh.approve(joined.node, 'localhost')
    expect(approved.approved).toBe(true)
    authority.adoptRoutes(member.signedRoutes(), joined.node)
    ;(authority as unknown as { refreshPeers(): void }).refreshPeers()
    await vi.waitFor(
      () =>
        expect(
          authority
            .status()
            .peers.some((peer) => peer.node === joined.node && peer.state === 'open')
        ).toBe(true),
      { timeout: 60_000, interval: 500 }
    )
  },
  180_000
)
