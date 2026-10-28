import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { connect, createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { daemonBed, type DaemonBed } from '../helpers/editorDaemonBed'
import { alive, until } from '../helpers/endpointBed'

// The editor settings must not read the real ssh: the check that `~/.ssh/config` can still be read is replaced by
// one that always passes (the tests below run the real `ssh` against a config of their own).
vi.mock('../../../src/mms/net/editor/sshConfig', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/mms/net/editor/sshConfig')>()),
  systemSshVerifier: () => async () => ({ ok: true as const })
}))

/**
 * The system's own `ssh`, `sftp` and `scp` against the endpoint, through the real path an editor takes: ssh starts
 * a ProxyCommand, the proxy asks the daemon for a tunnel, the tunnel crosses a Mousse Net session to the owner, and
 * the owner's endpoint answers. Loopback only; a temporary home and a config of its own are used, and nothing in
 * `~/.ssh` is read. Programs that run on the owner are real programs of the user the tests run as.
 */

const unix = process.platform !== 'win32'
// Each test starts real programs and processes over a real tunnel; the first run of a pair of computers is slow.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 })
const cleanup: Array<() => Promise<unknown> | unknown> = []
afterEach(async () => {
  for (const task of cleanup.splice(0).reverse()) await task()
})
let shared: DaemonBed | undefined
beforeAll(async () => {
  if (unix) shared = await daemonBed()
}, 240_000)
afterAll(async () => {
  await shared?.close()
})
/** The pair of computers of this file, with the owner's switch on and no block. */
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
const quote = (text: string): string => `'${text.replace(/'/gu, `'\\''`)}'`

/** Sends `text` to `port` on the loopback and returns what comes back first. */
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

/**
 * Sends `text` to an IPv4 address and port through the SOCKS5 proxy of `ssh -D` and returns what came back. OpenSSH
 * answers a SOCKS request before the far end has accepted the connection, so a refused target shows as a connection
 * that closes with nothing back: `''`. Rejects while nothing listens on the proxy port yet.
 */
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

describe.skipIf(!unix)('the system ssh against the endpoint', () => {
  it('runs a command, carries its exit code and its standard error, and reads standard input', async () => {
    const b = await bed()
    const out = await b.tool('ssh', ['mousse-owner', 'echo $((20+22)); echo oops >&2; exit 5'])
    expect(out.stdout.toString()).toBe('42\n')
    expect(out.stderr).toBe('oops\n')
    expect(out.code).toBe(5)
    const counted = await b.tool('ssh', ['mousse-owner', 'wc -c'], { stdin: 'abcdefgh' })
    expect(counted.stdout.toString().trim()).toBe('8')
    // No question was asked: the first connection finds the key pinned and needs no password.
    expect(out.stderr).not.toMatch(/authenticity|password|passphrase/iu)
  })

  it('starts in the owner’s home with a clean login environment', async () => {
    const b = await bed()
    const out = await b.tool('ssh', ['mousse-owner', 'pwd; echo "u=$USER s=$SSH_CONNECTION"'])
    expect(out.stdout.toString().split('\n')[0]).toBe(b.ownerHome)
    expect(out.stdout.toString()).toContain(`u=${b.user} s=127.0.0.1`)
  })

  it('gives a terminal with -tt', async (context) => {
    const b = await bed()
    if (!b.host.terminals()) return context.skip()
    const out = await b.tool('ssh', ['-tt', 'mousse-owner', 'tty; exit 0'])
    expect(out.stdout.toString()).toMatch(/\/dev\/(pts\/\d+|tty\w*)/u)
    expect(out.code).toBe(0)
  })

  it('forwards -L to the loopback, and carries -W and SOCKS (-D) the same way', async () => {
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
    cleanup.push(() => forward.kill('SIGKILL'))
    await until(async () => {
      try {
        return (await exchange(local, 'ping')) === 'ping'
      } catch {
        return false
      }
    }, 20_000)

    // -D: a SOCKS proxy; a loopback target connects, anything else is refused by the owner.
    const socks = await freePort()
    const proxy = b.start('ssh', ['-N', '-D', `127.0.0.1:${socks}`, 'mousse-owner'])
    cleanup.push(() => proxy.kill('SIGKILL'))
    await until(async () => {
      try {
        return (await socksExchange(socks, '127.0.0.1', echo, 'socks')) === 'socks'
      } catch {
        return false
      }
    }, 20_000)
    expect(await socksExchange(socks, '192.0.2.1', 80, 'socks')).toBe('')

    // -W: standard input and output to a host and port, which only works for the loopback.
    const wanted = await b.tool('ssh', ['-W', `127.0.0.1:${echo}`, 'mousse-owner'], {
      stdin: 'through -W'
    })
    expect(wanted.stdout.toString()).toBe('through -W')
    const refusedW = await b.tool('ssh', ['-W', '192.0.2.1:80', 'mousse-owner'], { stdin: 'no' })
    expect(refusedW.code).not.toBe(0)
    expect(refusedW.stderr).toMatch(/forwarding failed|refused|administratively/iu)
  })

  it('binds -R to the loopback and refuses every other address', async () => {
    const b = await bed()
    const echo = await echoServer()
    const remote = await freePort()
    const forward = b.start('ssh', [
      '-N',
      '-o',
      'ExitOnForwardFailure=yes',
      '-R',
      `127.0.0.1:${remote}:127.0.0.1:${echo}`,
      'mousse-owner'
    ])
    cleanup.push(() => forward.kill('SIGKILL'))
    await until(async () => {
      try {
        return (await exchange(remote, 'back')) === 'back'
      } catch {
        return false
      }
    }, 20_000)

    const wildcard = await b.tool(
      'ssh',
      [
        '-N',
        '-o',
        'ExitOnForwardFailure=yes',
        '-R',
        `0.0.0.0:${await freePort()}:127.0.0.1:${echo}`,
        'mousse-owner'
      ],
      { timeoutMs: 30_000 }
    )
    expect(wildcard.code).not.toBe(0)
    expect(wildcard.stderr).toMatch(/remote port forwarding failed/iu)
    // The refusal is in the owner’s audit, with the device and the kind of request, and no address.
    const rows = b.ownerNet.runtime().audit.recent(100, b.self)
    expect(
      rows.filter((row) => row.method === 'editor.refused' && row.outcome === 'tcpip-forward')
    ).toHaveLength(1)
  })

  it('refuses agent forwarding, X11 and a subsystem other than sftp, and the session carries on', async () => {
    const b = await bed()
    const out = await b.tool('ssh', [
      '-o',
      'ForwardX11=yes',
      '-o',
      'ForwardAgent=yes',
      '-s',
      'netconf',
      'mousse-owner'
    ])
    expect(out.code).not.toBe(0)
    expect(out.stderr).toMatch(/subsystem request failed|netconf/iu)
    // A normal command still works on a new connection of the same tunnel owner.
    expect((await b.tool('ssh', ['mousse-owner', 'echo fine'])).stdout.toString()).toBe('fine\n')
  })

  it('runs sftp batches on the real file system and ends with exit 0', async () => {
    const b = await bed()
    const source = join(tmpdir(), `ep-sftp-${process.pid}`)
    await mkdir(source, { recursive: true })
    cleanup.push(() =>
      import('node:fs/promises').then(({ rm }) => rm(source, { recursive: true, force: true }))
    )
    const local = join(source, 'local.bin')
    const payload = Buffer.from(Array.from({ length: 3_000_000 }, (_, i) => (i * 7) % 256))
    await writeFile(local, payload)
    const batch = [
      'mkdir work',
      `put ${local} work/remote.bin`,
      'chmod 640 work/remote.bin',
      'rename work/remote.bin work/renamed.bin',
      'ls -l work',
      `get work/renamed.bin ${join(source, 'back.bin')}`,
      'df',
      'rm work/renamed.bin',
      'rmdir work',
      'bye'
    ].join('\n')
    const run = await b.tool('sftp', ['-b', '-', 'mousse-owner'], { stdin: batch })
    expect(run.code, run.stderr).toBe(0)
    expect(run.stdout.toString()).toMatch(/renamed\.bin/u)
    expect((await readFile(join(source, 'back.bin'))).equals(payload)).toBe(true)
    expect(await readdir(b.ownerHome)).not.toContain('work')
  })

  it('copies with scp in both directions, in its SFTP mode and its legacy mode, with exit 0', async () => {
    const b = await bed()
    const source = join(tmpdir(), `ep-scp-${process.pid}`)
    await mkdir(source, { recursive: true })
    cleanup.push(() =>
      import('node:fs/promises').then(({ rm }) => rm(source, { recursive: true, force: true }))
    )
    const local = join(source, 'a.bin')
    const payload = Buffer.from(Array.from({ length: 1_500_000 }, (_, i) => (i * 13) % 256))
    await writeFile(local, payload)
    const sum = (data: Buffer): string => createHash('sha256').update(data).digest('hex')

    for (const mode of [[], ['-O']]) {
      const up = await b.tool('scp', [...mode, local, `mousse-owner:up${mode.length}.bin`])
      expect(up.code, up.stderr).toBe(0)
      expect(sum(await readFile(join(b.ownerHome, `up${mode.length}.bin`)))).toBe(sum(payload))
      const down = await b.tool('scp', [
        ...mode,
        `mousse-owner:up${mode.length}.bin`,
        join(source, `down${mode.length}.bin`)
      ])
      expect(down.code, down.stderr).toBe(0)
      expect(sum(await readFile(join(source, `down${mode.length}.bin`)))).toBe(sum(payload))
    }
    expect((await stat(join(b.ownerHome, 'up0.bin'))).size).toBe(payload.length)
  })

  it('serves ten sessions over one connection (a ControlMaster), as Zed uses it', async () => {
    const b = await bed()
    const control = join(tmpdir(), `cm-${process.pid}`)
    const master = b.start('ssh', [
      '-o',
      'ControlMaster=yes',
      '-o',
      `ControlPath=${control}`,
      '-o',
      'ControlPersist=no',
      '-N',
      'mousse-owner'
    ])
    cleanup.push(() => master.kill('SIGKILL'))
    await until(
      async () =>
        (
          await b
            .tool('ssh', ['-o', `ControlPath=${control}`, '-O', 'check', 'mousse-owner'])
            .catch(() => ({ code: 1 }))
        ).code === 0,
      20_000
    )
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        b.tool('ssh', ['-o', `ControlPath=${control}`, 'mousse-owner', `echo m${i}`])
      )
    )
    expect(results.map((result) => result.stdout.toString().trim())).toEqual(
      Array.from({ length: 10 }, (_, i) => `m${i}`)
    )
    expect(b.ownerNet.editorTunnelList()).toHaveLength(1)
  })

  it('ends an editor’s programs when the owner blocks the device, and refuses the next login', async () => {
    const b = await bed()
    const pidFile = join(b.ownerHome, 'blocked.pid')
    const running = b.start('ssh', ['mousse-owner', `echo $$ > ${quote(pidFile)}; exec sleep 300`])
    cleanup.push(() => running.kill('SIGKILL'))
    await until(async () => (await readFile(pidFile, 'utf8').catch(() => '')).length > 0, 20_000)
    const pid = Number((await readFile(pidFile, 'utf8')).trim())
    expect(await alive(pid)).toBe(true)
    await b.block(true)
    await until(async () => !(await alive(pid)), 15_000)
    const refused = await b.tool('ssh', ['mousse-owner', 'echo unreachable'])
    expect(refused.code).not.toBe(0)
    expect(refused.stdout.toString()).toBe('')
  })
})
