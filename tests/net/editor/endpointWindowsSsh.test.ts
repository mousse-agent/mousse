import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { connect, createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { daemonBed, type DaemonBed } from '../helpers/editorDaemonBed'
import { alive, sshdHelper, until } from '../helpers/endpointBed'

vi.mock('../../../src/mms/net/editor/sshConfig', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/mms/net/editor/sshConfig')>()),
  systemSshVerifier: () => async () => ({ ok: true as const })
}))

/**
 * Windows's own `ssh`, `sftp` and `scp` (Win32-OpenSSH) against the endpoint on a Windows owner, through the real
 * path an editor takes: ssh starts a ProxyCommand, the proxy asks the daemon for a tunnel, the tunnel crosses a
 * Mousse Net session, and the owner's endpoint answers with every session under the helper `sshd.exe`. Loopback
 * only, a temporary home and a config of its own; nothing in `~/.ssh` is read. Runs on Windows with the helper
 * built.
 */

const windows = process.platform === 'win32' && sshdHelper !== undefined
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 })
const cleanup: Array<() => Promise<unknown> | unknown> = []
afterEach(async () => {
  for (const task of cleanup.splice(0).reverse()) await task()
})
let shared: DaemonBed | undefined
beforeAll(async () => {
  if (windows) shared = await daemonBed()
}, 240_000)
afterAll(async () => {
  await shared?.close()
})
async function bed(): Promise<DaemonBed> {
  const b = shared!
  await b.block(false)
  await b.allow(true)
  return b
}
async function echoServer(): Promise<number> {
  const server = createServer((socket) => {
    socket.on('error', () => {})
    socket.pipe(socket)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
  return (server.address() as { port: number }).port
}
async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}
function exchange(port: number, text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port })
    socket.once('error', reject)
    socket.once('data', (chunk) => {
      socket.destroy()
      resolve(chunk.toString())
    })
    socket.write(text)
  })
}
/** `text` to an IPv4 address and port through the SOCKS5 proxy of `ssh -D`; `''` when the owner refused it. */
function socksExchange(
  proxyPort: number,
  address: string,
  port: number,
  text: string
): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket: Socket = connect({ host: '127.0.0.1', port: proxyPort })
    let stage = 0
    let echoed = ''
    const finish = (): void => {
      clearTimeout(timer)
      socket.destroy()
      resolve(echoed)
    }
    const timer = setTimeout(finish, 6_000)
    socket.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    socket.on('close', finish)
    socket.on('data', (chunk) => {
      if (stage === 0) {
        stage = 1
        socket.write(
          Buffer.from([5, 1, 0, 1, ...address.split('.').map(Number), port >> 8, port & 255])
        )
      } else if (stage === 1) {
        stage = 2
        if (chunk[1] !== 0) return finish()
        socket.write(text)
      } else {
        echoed += chunk.toString()
        if (echoed.length >= text.length) finish()
      }
    })
    socket.write(Buffer.from([5, 1, 0]))
  })
}

describe.skipIf(!windows)('Windows’s ssh against the endpoint on a Windows owner', () => {
  it('runs a command with its exit code, its standard error and its input, and asks nothing', async () => {
    const b = await bed()
    const out = await b.tool('ssh', ['mousse-owner', 'echo 42& (echo oops)1>&2& exit 5'])
    expect(out.stdout.toString()).toBe('42\r\n')
    expect(out.stderr).toBe('oops\r\n')
    expect(out.code).toBe(5)
    const found = await b.tool('ssh', ['mousse-owner', 'findstr keep'], {
      stdin: 'keep\r\ndrop\r\n'
    })
    expect(found.stdout.toString()).toBe('keep\r\n')
    expect(out.stderr).not.toMatch(/authenticity|password|passphrase/iu)
  })

  it('runs a shell that reads its script from standard input, in the owner’s home', async () => {
    const b = await bed()
    const out = await b.tool('ssh', ['-T', 'mousse-owner'], {
      stdin: 'cd\r\necho shell-ok\r\nexit\r\n'
    })
    expect(out.stdout.toString()).toContain(b.ownerHome)
    expect(out.stdout.toString()).toContain('shell-ok')
  })

  it('runs sftp batches on the real file system, lists the drives at /, and ends with exit 0', async () => {
    const b = await bed()
    const source = join(tmpdir(), `ep-win-sftp-${process.pid}`)
    await mkdir(source, { recursive: true })
    cleanup.push(() => rm(source, { recursive: true, force: true }))
    const local = join(source, 'local.bin')
    const payload = Buffer.from(Array.from({ length: 2_000_000 }, (_, i) => (i * 7) % 256))
    await writeFile(local, payload)
    const batch = [
      'mkdir work',
      `put "${local}" work/remote.bin`,
      'rename work/remote.bin work/renamed.bin',
      'ls work',
      `get work/renamed.bin "${join(source, 'back.bin')}"`,
      'ls /',
      'rm work/renamed.bin',
      'rmdir work',
      'bye'
    ].join('\n')
    const run = await b.tool('sftp', ['-b', '-', 'mousse-owner'], { stdin: batch })
    expect(run.code, run.stderr).toBe(0)
    expect(run.stdout.toString()).toMatch(/renamed\.bin/u)
    expect(run.stdout.toString()).toMatch(
      new RegExp(`/${(process.env.SystemDrive ?? 'C:').toUpperCase()}`, 'u')
    )
    const sum = (data: Buffer): string => createHash('sha256').update(data).digest('hex')
    expect(sum(await readFile(join(source, 'back.bin')))).toBe(sum(payload))
    expect(await readdir(b.ownerHome)).not.toContain('work')
  })

  it('forwards -L to the loopback, and carries SOCKS (-D) the same way', async () => {
    const b = await bed()
    const echo = await echoServer()
    const local = await freePort()
    const forward = b.start('ssh', [
      '-N',
      '-o',
      'ExitOnForwardFailure=yes',
      '-L',
      `127.0.0.1:${local}:127.0.0.1:${echo}`,
      'mousse-owner'
    ])
    cleanup.push(() => forward.kill())
    await until(async () => (await exchange(local, 'ping').catch(() => '')) === 'ping', 30_000)
    const socks = await freePort()
    const proxy = b.start('ssh', ['-N', '-D', `127.0.0.1:${socks}`, 'mousse-owner'])
    cleanup.push(() => proxy.kill())
    await until(
      async () =>
        (await socksExchange(socks, '127.0.0.1', echo, 'socks').catch(() => '')) === 'socks',
      30_000
    )
    expect(await socksExchange(socks, '192.0.2.1', 80, 'socks')).toBe('')
  })

  it('replays VS Code’s Windows server start: the sshd ancestor is found, the server outlives a dropped connection, and a block ends it', async () => {
    const b = await bed()
    const work = join(b.ownerHome, '.vscode-server-test')
    await mkdir(work, { recursive: true })
    const stub = join(work, 'stub.cjs')
    const pids = join(work, 'pids')
    await writeFile(
      stub,
      `const net = require('node:net')
require('node:fs').appendFileSync(process.argv[2], process.pid + '\\n')
const server = net.createServer((socket) => { socket.on('error', () => {}); socket.pipe(socket) })
server.listen(0, '127.0.0.1', () => console.log('Listening on 127.0.0.1:' + server.address().port))
`
    )
    // The steps of Remote-SSH's Windows exec-server script, as the spike recorded them: find the sshd ancestor or
    // stop, start the server hidden with Start-Process, wait for where it listens, print it, then stay until the
    // sshd ancestor is gone. The script arrives on standard input of `powershell`, as the editor sends it.
    const node = realpathSync(process.execPath)
    const script = `
$ProgressPreference = 'SilentlyContinue'
function getSshdParentPid {
  $current = $PID
  while ($true) {
    $parent = (Get-CimInstance Win32_Process | Where-Object ProcessId -eq $current).ParentProcessId
    if (!$parent) { "no sshd parent proc"; exit 0 }
    if ((Get-Process -Id $parent).Name -eq 'sshd') { return $parent }
    $current = $parent
  }
}
$sshdPID = getSshdParentPid
"sshd ancestor: $sshdPID"
$log = Join-Path '${work}' "server.$PID.log"
$cmd = "& '${node}' '${stub}' '${pids}' *> '$log'"
$null = Start-Process -FilePath powershell.exe -WindowStyle Hidden -PassThru -ArgumentList @('-NoLogo','-NoProfile','-NonInteractive','-c',$cmd)
$port = $null
$deadline = (Get-Date).AddSeconds(30)
while (!$port -and (Get-Date) -lt $deadline) {
  if (Test-Path $log) { $m = (Select-String -Path $log -Pattern 'Listening on \\S+:(\\d+)').Matches; if ($m) { $port = $m[0].Groups[1].Value } }
  Start-Sleep -Milliseconds 50
}
"listeningOn==$port=="
"script pid==$PID=="
while ($true) { if (!(Get-Process -Id $sshdPID -ErrorAction SilentlyContinue)) { exit 0 }; Start-Sleep -Milliseconds 200 }
`
    const socks = await freePort()
    const ssh = b.start('ssh', ['-T', '-D', `127.0.0.1:${socks}`, 'mousse-owner', 'powershell'], {
      stdin: true
    })
    cleanup.push(() => ssh.kill())
    ssh.stdin!.on('error', () => {})
    // PowerShell reads a piped script as typed input, where a blank line closes a block; the editor adds one after
    // each closing brace before it sends the script, and so does this.
    ssh.stdin!.write(`${script.replace(/\}\n/gu, '}\n\n')}\n`)
    await until(() => /listeningOn==\d+==/u.test(ssh.output().stdout), 60_000).catch(() => {
      const { stdout, stderr } = ssh.output()
      throw new Error(`the script did not start the server:\n${stdout}\n${stderr.slice(-2000)}`)
    })
    const output = ssh.output().stdout
    // PowerShell echoes what it reads, so the script's own text is in the output too: only a line it printed counts.
    expect(output).not.toMatch(/^no sshd parent proc\r?$/mu)
    const sshd = Number(/sshd ancestor: (\d+)/u.exec(output)![1])
    const scriptPid = Number(/script pid==(\d+)==/u.exec(output)![1])
    const port = Number(/listeningOn==(\d+)==/u.exec(output)![1])
    // The editor reaches the server through the SOCKS proxy of the same connection.
    await until(
      async () =>
        (await socksExchange(socks, '127.0.0.1', port, 'hello').catch(() => '')) === 'hello',
      30_000
    )
    const [server] = (await readFile(pids, 'utf8')).split('\n').filter(Boolean).map(Number)
    expect(await alive(server!)).toBe(true)

    // The connection drops (the window closes, or the network goes): the session's helper ends, the script that
    // watched it exits by itself, and the server stays for the editor's reconnection.
    ssh.kill()
    await until(async () => !(await alive(sshd)) && !(await alive(scriptPid)), 20_000)
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(await alive(server!)).toBe(true)
    expect(await exchange(port, 'still there')).toBe('still there')

    // The owner blocks the device: the server goes, though its session ended before.
    await b.block(true)
    await until(async () => !(await alive(server!)), 20_000)
  })
})
