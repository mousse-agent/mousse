import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { NodeId } from '../../../src/shared/net'

export type FakeSshMode = 'forward' | 'slow' | 'hang' | 'denied' | 'prohibited' | 'refused'

export interface FakeSsh {
  binary: string
  /** One JSON argv per connecting spawn. */
  log: string
  /** One JSON argv per `-G` spawn, which prints configuration and never connects. */
  configLog: string
  pid: string
}

/**
 * A stand-in for `ssh -W`: it checks the host against the `UserKnownHostsFile` option the way
 * `StrictHostKeyChecking=yes` would, then connects a TCP socket to the `-W` target and pipes stdio.
 * `-G` prints `config` (what the user's `~/.ssh/config` resolves to) and exits. Other modes print
 * what OpenSSH prints for the failure they name. It never reaches a real host.
 */
export async function fakeSsh(
  where: string,
  mode: FakeSshMode,
  name = 'ssh',
  config: string[] = ['hostname box.example.com']
): Promise<FakeSsh> {
  const binary = join(where, name),
    log = join(where, `${name}.log`),
    configLog = join(where, `${name}.config.log`),
    pid = join(where, `${name}.pid`)
  const code = `
const fs = require('fs'), net = require('net')
const args = process.argv.slice(2)
if (args.includes('-G')) {
  fs.appendFileSync(${JSON.stringify(configLog)}, JSON.stringify(args) + '\\n')
  process.stdout.write(${JSON.stringify(config.join('\n') + '\n')})
  process.exit(0)
}
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n')
fs.writeFileSync(${JSON.stringify(pid)}, String(process.pid))
fs.writeFileSync(${JSON.stringify(log + '.env')}, JSON.stringify({ askpass: Object.keys(process.env).filter((key) => key.toUpperCase().startsWith('SSH_ASKPASS')) }))
const fail = (text) => { process.stderr.write(text + '\\n'); process.exit(255) }
const forward = args[args.indexOf('-W') + 1].split(':')
const target = args[args.length - 1]
const sshPort = args.includes('-p') ? args[args.indexOf('-p') + 1] : '22'
const lookup = sshPort === '22' ? target : '[' + target + ']:' + sshPort
const option = args.find((value) => value.startsWith('UserKnownHostsFile=')) || ''
const files = [...option.matchAll(/"([^"]*)"/g)].map((match) => match[1])
const known = files.some((file) => {
  try { return fs.readFileSync(file, 'utf8').split('\\n').some((line) => line.split(' ')[0] === lookup) } catch { return false }
})
if (!known) fail('Host key verification failed.')
const mode = ${JSON.stringify(mode)}
if (mode === 'denied') fail('me@box: Permission denied (publickey).')
// Like OpenSSH, the reason is logged at INFO; at LogLevel=ERROR only the fatal line survives.
const verbose = args.includes('LogLevel=INFO') || args.includes('LogLevel=DEBUG')
const refusal = (reason) => fail((verbose ? 'channel 0: open failed: ' + reason + '\\n' : '') + 'stdio forwarding failed')
if (mode === 'prohibited') refusal('administratively prohibited: open failed')
if (mode === 'refused') refusal('connect failed: Connection refused')
if (mode === 'hang') setInterval(() => {}, 1000)
else setTimeout(() => {
  const socket = net.connect(Number(forward[1]), forward[0])
  socket.on('error', () => refusal('connect failed: Connection refused'))
  socket.on('close', () => process.exit(0))
  process.stdin.on('end', () => socket.end())
  process.stdin.pipe(socket)
  socket.pipe(process.stdout)
}, mode === 'slow' ? 3000 : 0)
`
  await writeFile(binary, `#!${process.execPath}\n${code}`, { mode: 0o700 })
  return { binary, log, configLog, pid }
}

/** The line `StrictHostKeyChecking=yes` needs before the fake lets the connection through. */
export async function trustHost(file: string, host: string, port?: number): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(
    file,
    `${port && port !== 22 ? `[${host}]:${port}` : host} ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAItest\n`,
    { flag: 'a' }
  )
}

/** What setup writes: this device's approval of an endpoint for one peer. */
export async function approve(
  profileDir: string,
  approvals: Record<NodeId, string>
): Promise<void> {
  const file = join(profileDir, 'net', 'ssh', 'approvals.json')
  await mkdir(dirname(file), { recursive: true })
  await writeFile(
    file,
    JSON.stringify(
      Object.fromEntries(
        Object.entries(approvals).map(([node, endpoint]) => [
          node,
          { endpoint, fingerprint: 'SHA256:test', approvedAt: 1 }
        ])
      )
    )
  )
}
