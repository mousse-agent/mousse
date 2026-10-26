import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { NodeId } from '../../../src/shared/net'

export type FakeSshMode =
  'forward' | 'slow' | 'hang' | 'denied' | 'banner' | 'prohibited' | 'refused'

export interface FakeSsh {
  binary: string
  /** One JSON argv per spawn. */
  log: string
  pid: string
}

/**
 * A stand-in for `ssh -W`: it checks the host against the `UserKnownHostsFile` option the way
 * `StrictHostKeyChecking=yes` would, then connects a TCP socket to the `-W` target and pipes stdio.
 * Other modes print what OpenSSH prints for the failure they name. It never reaches a real host.
 */
export async function fakeSsh(where: string, mode: FakeSshMode, name = 'ssh'): Promise<FakeSsh> {
  const binary = join(where, name),
    log = join(where, `${name}.log`),
    pid = join(where, `${name}.pid`)
  const code = `
const fs = require('fs'), net = require('net')
const args = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n')
fs.writeFileSync(${JSON.stringify(pid)}, String(process.pid))
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
if (mode === 'banner') fail('Please authenticate at https://login.example.com/a/abc123\\nPermission denied (keyboard-interactive).')
if (mode === 'prohibited') fail('channel 0: open failed: administratively prohibited: open failed\\nstdio forwarding failed')
if (mode === 'refused') fail('channel 0: open failed: connect failed: Connection refused\\nstdio forwarding failed')
if (mode === 'hang') setInterval(() => {}, 1000)
else setTimeout(() => {
  const socket = net.connect(Number(forward[1]), forward[0])
  socket.on('error', () => fail('channel 0: open failed: connect failed: Connection refused'))
  socket.on('close', () => process.exit(0))
  process.stdin.on('end', () => socket.end())
  process.stdin.pipe(socket)
  socket.pipe(process.stdout)
}, mode === 'slow' ? 3000 : 0)
`
  await writeFile(binary, `#!${process.execPath}\n${code}`, { mode: 0o700 })
  return { binary, log, pid }
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
