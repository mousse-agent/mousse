import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, vi } from 'vitest'
import { runSshProxy } from '../../../src/cli/fastpath/sshProxy'
import { MousseMainService } from '../../../src/mms/MousseMainService'
import type { ProcessHost } from '../../../src/mms/net/editor/endpoint/host'
import { NetService } from '../../../src/mms/net/NetService'
import { LocalMmsClient, MmsProtocolServer } from '../../../src/mms/protocol'
import type { NodeId } from '../../../src/shared/net'
import type { EditorSshResult } from '../../../src/shared/net/local'
import type { WindowsProcessHost } from '../../../src/mms/net/editor/endpoint/windowsHost'
import { testHost } from './endpointBed'

/**
 * Two computers on one machine, with nothing mocked in the path an editor's `ssh` takes: the real daemon of
 * "this computer" (`MousseMainService` behind the framed local protocol), the real Net service of "the owner"
 * paired with it over loopback TLS, a tunnel between them, the SSH endpoint on the owner's end, and the real
 * `runSshProxy` that `mousse-cli net ssh-proxy` runs. The only stand-ins are a one-line bridge that gives `ssh` a
 * `ProxyCommand` it can start (`proxyBridge.mjs`, plain `node`), and a throwaway home folder and account for the
 * programs the owner starts. Callers mock `editor/sshConfig`'s `systemSshVerifier`, as the other daemon tests do.
 */

const TOKEN = 'fixture-owner-token'

export interface DaemonBed {
  /** The owner's home folder: where its programs and SFTP start. */
  ownerHome: string
  /** The throwaway home of the person at this computer (their `~/.ssh`, `~/.mousse`). */
  userHome: string
  /** The login name the owner's endpoint accepts. */
  user: string
  host: ProcessHost
  /** The node id of the owner as this computer knows it. */
  owner: NodeId
  /** This computer, as the owner knows it: the device that opens the tunnels. */
  self: NodeId
  ownerNet: NetService
  /** The Net service of this computer, which opens the tunnels (the proxy asks it through the local protocol). */
  thisNet: NetService
  alias: string
  /** An ssh config file with one host, `mousse-owner`, that reaches the owner through the real proxy. */
  sshConfig: string
  /** Starts the system's `ssh`, `sftp` or `scp` with that config and returns what it did. */
  tool(
    command: 'ssh' | 'sftp' | 'scp',
    args: string[],
    options?: { stdin?: string | Buffer; timeoutMs?: number }
  ): Promise<{ code: number | null; stdout: Buffer; stderr: string }>
  /** The same, but a process that stays: a forward, or a connection for a multiplexing master. */
  start(
    command: 'ssh',
    args: string[],
    options?: { stdin?: boolean }
  ): ChildProcess & { output(): { stdout: string; stderr: string } }
  sshArgs: string[]
  allow(on: boolean): Promise<unknown>
  block(on: boolean): Promise<unknown>
  close(): Promise<void>
}

async function directory(prefix: string, cleanup: Array<() => unknown>): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), prefix)))
  cleanup.push(() => rm(path, { recursive: true, force: true }))
  return path
}

export async function daemonBed(
  options: {
    host?: ProcessHost
    /** Replaces the owner's tunnel options (a far end of the tests' own); the default is the endpoint on `host`. */
    editorTunnel?: ConstructorParameters<typeof NetService>[0]['editorTunnel']
  } = {}
): Promise<DaemonBed> {
  const cleanup: Array<() => unknown> = []
  const root = await directory('mousse-ep-', cleanup)
  const userHome = join(root, 'user')
  const ownerHome = join(root, 'owner-home')
  await mkdir(userHome, { recursive: true })
  await mkdir(ownerHome, { recursive: true })
  // The editor settings of the profile write under the home directory: a throwaway one.
  vi.stubEnv('USERPROFILE', userHome)
  vi.stubEnv('HOME', userHome)
  const host = options.host ?? testHost(ownerHome, root)

  const daemonHome = join(root, 'home')
  const main = await MousseMainService.create({
    homeDir: daemonHome,
    repoRoot: root,
    requireOwnership: false,
    headless: true
  })
  const server = new MmsProtocolServer({ mms: main, ownerToken: TOKEN })
  const endpoint = await server.start()
  const profileDir = await directory('mousse-ep-owner-', cleanup)
  const owner = new NetService({
    profileDir,
    editorTunnel: options.editorTunnel ?? { endpointHost: host }
  })
  cleanup.push(async () => {
    await owner.shutdown()
    await server.stop()
    await main.stop()
  })
  await writeFile(
    join(daemonHome, 'mms.owner.json'),
    JSON.stringify({
      pid: process.pid,
      processInstanceId: 'test',
      token: TOKEN,
      home: daemonHome,
      acquiredAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
      kind: 'daemon',
      protocolVersion: 1,
      endpoint
    })
  )
  const client = new LocalMmsClient({
    homeDir: daemonHome,
    endpoint,
    ownerToken: TOKEN,
    clientType: 'cli',
    requestedCapabilities: ['net.v1', 'profiles-v1']
  })
  await client.connect()
  cleanup.push(() => client.close())
  const status = await client.request<{ defaultProfileId: string }>('profiles.status')
  const profile = status.defaultProfileId
  await client.request('profiles.bind', { profile })
  const authority = (await main.getProfileServices(profile)).net
  await authority.request('net.init', { name: 'this computer', listen: true, port: 0 })
  await authority.request('net.protect', { passphrase: 'test-authority-protection' })
  const invite = ((await authority.request('bridge.invite', {})) as { invite: string }).invite
  const joined = (await owner.request('bridge.join', { invite, name: 'Computer B' })) as {
    node: NodeId
  }
  const self = authority.runtime().identity.self()!.node
  await vi.waitFor(
    () => expect(owner.status().peers).toContainEqual({ node: self, state: 'open' }),
    {
      timeout: 15_000
    }
  )
  await vi.waitFor(
    () => expect(authority.status().peers).toContainEqual({ node: joined.node, state: 'open' }),
    { timeout: 15_000 }
  )

  // "ssh-proxy" for each connection of the bridge: the real program's code, on the bridge's socket.
  const bridgeSockets = new Set<Socket>()
  const bridge: Server = createServer((socket) => {
    bridgeSockets.add(socket)
    // The bridge is TCP only because `ssh` needs a program to start: Nagle's algorithm must not delay its small packets.
    socket.setNoDelay(true)
    socket.on('close', () => bridgeSockets.delete(socket))
    socket.on('error', () => {})
    void runSshProxy(
      ['net', 'ssh-proxy', joined.node, '--profile', profile, '--home', daemonHome],
      {
        stdin: socket,
        stdout: {
          write(chunk, callback) {
            if (socket.destroyed) callback()
            else socket.write(chunk, () => callback())
            return true
          }
        },
        stderr: {
          write(text, callback) {
            process.stderr.write(`[proxy] ${text}`)
            callback?.()
            return true
          }
        },
        env: {},
        platform: process.platform,
        home: () => daemonHome
      }
    ).then(() => socket.end())
  })
  await new Promise<void>((resolve) => bridge.listen(0, '127.0.0.1', resolve))
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        // A bridge whose `ssh` was killed is an orphan with its connection still open.
        for (const socket of bridgeSockets) socket.destroy()
        bridge.close(() => resolve())
      })
  )
  const bridgePort = (bridge.address() as { port: number }).port

  await owner.request('bridge.policy', { node: self, editor: true })
  const prepared = (await client.request<EditorSshResult>('net.editor.ssh.prepare')) as Extract<
    EditorSshResult,
    { ok: true }
  >
  if (!prepared.ok)
    throw new Error(`editor settings: ${(prepared as { message?: string }).message}`)
  const computer = prepared.status.computers.find((entry) => entry.node === joined.node)
  if (!computer) throw new Error('no alias for the owner')

  const bridgeScript = fileURLToPath(new URL('./proxyBridge.mjs', import.meta.url))
  const sshConfig = join(root, 'ssh_config')
  await writeFile(
    sshConfig,
    [
      'Host mousse-owner',
      '  HostName 127.0.0.1',
      `  User ${host.user}`,
      `  ProxyCommand "${process.execPath}" "${bridgeScript}" ${bridgePort}`,
      `  HostKeyAlias ${computer.alias}`,
      `  UserKnownHostsFile "${prepared.status.knownHosts.replace(/^~/u, userHome)}"`,
      '  GlobalKnownHostsFile /dev/null',
      '  StrictHostKeyChecking yes',
      '  BatchMode yes',
      '  IdentityFile none',
      '  ForwardAgent no',
      '  ControlMaster no',
      '  LogLevel ERROR',
      ''
    ].join('\n')
  )
  // `~/.mousse/ssh/known_hosts` is where Mousse pinned the key (before any byte of the connection), so `ssh` is
  // told nothing about it here: the first connection already finds it.
  const sshArgs = ['-F', sshConfig]
  const environment = (): NodeJS.ProcessEnv => ({
    PATH: process.env.PATH,
    HOME: userHome,
    USERPROFILE: userHome,
    LANG: 'C',
    SystemRoot: process.env.SystemRoot,
    // Windows's ssh stops without a word when it cannot find its own folder under ProgramData.
    ...(process.platform === 'win32' ? { ProgramData: process.env.ProgramData } : {})
  })

  const spawned = new Set<ChildProcess>()
  // On Windows, the system's own client (Win32-OpenSSH), whatever else is first on the PATH.
  const program = (command: 'ssh' | 'sftp' | 'scp'): string => {
    if (process.platform !== 'win32') return command
    const system = join(
      process.env.SystemRoot ?? 'C:\\Windows',
      'System32',
      'OpenSSH',
      `${command}.exe`
    )
    return existsSync(system) ? system : command
  }
  const tool: DaemonBed['tool'] = (command, args, toolOptions = {}) =>
    new Promise((resolve, reject) => {
      const child = spawn(program(command), [...sshArgs, ...args], {
        env: environment(),
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      })
      spawned.add(child)
      const out: Buffer[] = []
      let stderr = ''
      child.stdout.on('data', (chunk: Buffer) => out.push(chunk))
      child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')))
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        reject(new Error(`${command} did not finish: ${stderr}`))
      }, toolOptions.timeoutMs ?? 60_000)
      child.on('error', reject)
      child.on('close', (code) => {
        clearTimeout(timer)
        spawned.delete(child)
        resolve({ code, stdout: Buffer.concat(out), stderr })
      })
      child.stdin.on('error', () => {})
      child.stdin.end(toolOptions.stdin)
    })

  return {
    ownerHome,
    userHome,
    user: host.user,
    host,
    owner: joined.node,
    thisNet: authority,
    self,
    ownerNet: owner,
    alias: computer.alias,
    sshConfig,
    sshArgs,
    tool,
    start(command, args, startOptions = {}) {
      const child = spawn(program(command), [...sshArgs, ...args], {
        env: environment(),
        stdio: [startOptions.stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        windowsHide: true
      })
      spawned.add(child)
      child.on('close', () => spawned.delete(child))
      let stdout = ''
      let stderr = ''
      child.stdout!.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')))
      child.stderr!.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')))
      return Object.assign(child, { output: () => ({ stdout, stderr }) })
    },
    allow: (on) => owner.request('bridge.policy', { node: self, editor: on }),
    block: (on) => owner.request('bridge.policy', { node: self, blocked: on }),
    async close() {
      for (const child of spawned) child.kill('SIGKILL')
      const windows = host as Partial<WindowsProcessHost>
      for (const scope of new Set([...host.scopes(), ...(windows.held?.() ?? [])]))
        await host.killScope(scope).catch(() => undefined)
      windows.release?.()
      for (const task of cleanup.splice(0).reverse()) await task()
      vi.unstubAllEnvs()
    }
  }
}
