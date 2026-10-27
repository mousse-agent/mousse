import { createHash, createHmac, randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { newId, type InviteId, type NodeId } from '../../../src/shared/net'
import {
  SshBootstrap,
  type SshBootstrapHost,
  type SshBootstrapOptions
} from '../../../src/mms/net/ssh/bootstrap'
import { sshKnownHostsPath } from '../../../src/mms/net/transports/ssh'

export const KEY_A = {
  type: 'ssh-ed25519',
  key: Buffer.from('mousse test host key A').toString('base64')
}
export const KEY_B = {
  type: 'ssh-ed25519',
  key: Buffer.from('mousse test host key B').toString('base64')
}
export const KEY_RSA = {
  type: 'ssh-rsa',
  key: Buffer.from('mousse test rsa host key').toString('base64')
}
export function fingerprint(key: { key: string }): string {
  return `SHA256:${createHash('sha256').update(Buffer.from(key.key, 'base64')).digest('base64').replace(/=+$/u, '')}`
}
/** A `HashKnownHosts yes` line for `name`, as OpenSSH writes it. */
export function hashedLine(name: string, key: { type: string; key: string }): string {
  const salt = randomBytes(20)
  return `|1|${salt.toString('base64')}|${createHmac('sha1', salt).update(name).digest('base64')} ${key.type} ${key.key}`
}

export interface HostState {
  [key: string]: unknown
}
export const defaultHost = (): HostState => ({
  hostKey: KEY_A,
  os: 'Linux x86_64',
  home: '/home/me',
  user: 'me',
  tools: ['curl', 'sha256sum', 'systemctl', 'loginctl'],
  linger: 'no',
  freeKb: 9_000_000,
  nextNode: newId('node')
})

export interface Bed {
  dir: string
  profileDir: string
  userKnownHosts: string
  mousseKnownHosts: string
  binary: string
  host(): Promise<HostState>
  patch(change: HostState): Promise<void>
  calls(): Promise<Array<Record<string, any>>>
  steps(): Promise<string[]>
  configChecks(): Promise<string[][]>
  stub: ReturnType<typeof hostStub>
  make(options?: Partial<SshBootstrapOptions>): SshBootstrap
  trusted(): Promise<SshBootstrap>
}

export function hostStub(profileDir: string, hostFile: string) {
  const state = {
    invites: [] as Array<{ name: string; id: InviteId }>,
    revokedInvites: [] as string[],
    revokedNodes: [] as NodeId[],
    adopted: [] as NodeId[],
    listeners: 0,
    closed: 0,
    overrides: new Map<
      string,
      | { state: 'consumed'; node: NodeId; name: string }
      | { state: 'active' | 'revoked' | 'missing' }
    >(),
    known: new Set<NodeId>(),
    onListener: undefined as undefined | (() => Promise<void> | void)
  }
  const host: SshBootstrapHost = {
    profileDir,
    inviteNode: async (name) => {
      const id = newId('invite')
      state.invites.push({ name, id })
      return { invite: `mj1_${id}`, inviteId: id }
    },
    inviteOutcome: (id) => {
      const forced = state.overrides.get(id)
      if (forced) return forced
      try {
        const current = JSON.parse(readFileSync(hostFile, 'utf8')) as HostState
        if (current.joinInvite === `mj1_${id}` && current.node)
          return { state: 'consumed', node: current.node as NodeId, name: String(current.joinedAs) }
      } catch {
        // No host file yet.
      }
      return state.revokedInvites.includes(id) ? { state: 'revoked' } : { state: 'active' }
    },
    revokeInvite: (id) => {
      state.revokedInvites.push(id)
    },
    revokeNode: async (node) => {
      state.revokedNodes.push(node)
    },
    openEnrollmentListener: async () => {
      state.listeners++
      await state.onListener?.()
      return {
        port: 4242,
        close: async () => {
          state.closed++
        }
      }
    },
    adoptRoutes: (_signed, node) => {
      state.adopted.push(node)
    },
    peerOpen: () => true,
    knownNode: (node) => state.known.has(node)
  }
  return Object.assign(state, { host })
}

/** A scripted machine behind a fake `ssh`, a profile directory and a user known_hosts file. */
export async function bed(
  cleanup: Array<() => Promise<unknown> | unknown>,
  binaries: Set<string>,
  overrides: HostState = {},
  config = [
    'hostname box.example.com',
    'port 22',
    'user me',
    'globalknownhostsfile /nonexistent/ssh_known_hosts'
  ]
): Promise<Bed> {
  // The directory name has a space on purpose: option paths are quoted.
  const dir = await mkdtemp(join(tmpdir(), 'mousse ssh bed '))
  cleanup.push(() => rm(dir, { recursive: true, force: true }))
  const profileDir = join(dir, 'profile'),
    userKnownHosts = join(dir, 'user', 'known_hosts'),
    hostFile = join(dir, 'host.json'),
    binary = join(dir, 'ssh')
  await mkdir(profileDir, { recursive: true })
  await mkdir(join(dir, 'user'), { recursive: true })
  await mkdir(join(dir, 'user', 'dotssh'), { recursive: true })
  await writeFile(join(dir, 'user', 'dotssh', 'id_ed25519'), 'key')
  await writeFile(hostFile, JSON.stringify({ ...defaultHost(), ...overrides }))
  await writeFile(join(dir, 'config.json'), JSON.stringify(config))
  const fake = resolve(dirname(fileURLToPath(import.meta.url)), 'fakeHostSsh.cjs')
  await writeFile(
    binary,
    `#!${process.execPath}\nprocess.env.FAKE_SSH_DIR = ${JSON.stringify(dir)}\nrequire(${JSON.stringify(fake)})\n`,
    { mode: 0o700 }
  )
  binaries.add(binary)
  process.env.FAKE_SSH_DIR = dir
  const stub = hostStub(profileDir, hostFile)
  const read = async () => JSON.parse(await readFile(hostFile, 'utf8')) as HostState
  const lines = async (name: string) =>
    existsSync(join(dir, name))
      ? (await readFile(join(dir, name), 'utf8'))
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : []
  const made: SshBootstrap[] = []
  const result: Bed = {
    dir,
    profileDir,
    userKnownHosts,
    mousseKnownHosts: sshKnownHostsPath(profileDir),
    binary,
    host: read,
    patch: async (change) => writeFile(hostFile, JSON.stringify({ ...(await read()), ...change })),
    calls: () => lines('calls.log'),
    steps: async () =>
      (await lines('calls.log'))
        .filter((call) => call.kind === 'run')
        .map((call) => call.step as string),
    configChecks: () => lines('config.log'),
    stub,
    make: (options = {}) => {
      const bootstrap = new SshBootstrap(stub.host, {
        binary: () => binary,
        userKnownHosts,
        sshAdd: join(dir, 'no-such-ssh-add'),
        sshDirectory: join(dir, 'user', 'dotssh'),
        version: () => '0.1.2',
        pollMs: 5,
        openWaitMs: 300,
        routesWaitMs: 300,
        serviceWaitMs: 300,
        fetch: (async (url: string) => {
          const version = /SHA256SUMS-(.+)\.txt$/u.exec(String(url))?.[1]
          if (version)
            return new Response(
              `${'a'.repeat(64)}  mousse-cli-${version}-linux-x86_64.AppImage\n${'b'.repeat(64)}  other\n`
            )
          return new Response('appimage-bytes')
        }) as unknown as typeof fetch,
        ...options
      })
      made.push(bootstrap)
      return bootstrap
    },
    trusted: async () => {
      const ssh = result.make()
      const first = await ssh.check('box')
      await ssh.trust({ host: 'box', fingerprint: first.hostKey!.fingerprint })
      return ssh
    }
  }
  cleanup.push(async () => {
    for (const bootstrap of made) await bootstrap.close()
  })
  return result
}
