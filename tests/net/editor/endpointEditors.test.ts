import { createHash, randomBytes } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer as createHttpServer } from 'node:http'
import { connect, createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { daemonBed, type DaemonBed } from '../helpers/editorDaemonBed'
import { alive, until } from '../helpers/endpointBed'

vi.mock('../../../src/mms/net/editor/sshConfig', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/mms/net/editor/sshConfig')>()),
  systemSshVerifier: () => async () => ({ ok: true as const })
}))

/**
 * What the editors do on the owner, replayed against the endpoint through the system `ssh`. No editor is
 * started. Each editor's own scripts were read from its installed files and their steps recorded in the spike
 * report; the scripts here do the same steps against local stand-ins (an update server on the loopback, a fake
 * server program), so the tests need neither an editor nor the internet.
 *
 * - **VS Code Remote-SSH, Linux owner:** `ssh -T -D <port> host sh` with an install script on standard input. It
 *   downloads the CLI from an update server, unpacks it, starts it in the background listening on a loopback
 *   port, prints where it listens, and the editor connects to that port through the SOCKS proxy (`-D`). A second
 *   connection finds the install and downloads nothing. If the extension is installed and
 *   `MOUSSE_VSCODE_REMOTE_SSH_DIR` names its folder, the extension's own installer script runs too.
 * - **Zed:** `uname -sm`, `echo $HOME`, an upload over SFTP, `gunzip` and `chmod` over exec, then the server's
 *   `proxy` over the exec channel's standard input and output, which starts a detached daemon that must outlive
 *   the channel.
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
async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}
const quote = (text: string): string => `'${text.replace(/'/gu, `'\\''`)}'`

function socksEcho(proxyPort: number, port: number, text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket: Socket = connect({ host: '127.0.0.1', port: proxyPort })
    socket.once('error', reject)
    socket.once('close', () => reject(new Error('closed before an answer')))
    let stage = 0
    socket.on('data', (chunk) => {
      if (stage === 0) {
        stage = 1
        socket.write(Buffer.from([5, 1, 0, 1, 127, 0, 0, 1, port >> 8, port & 255]))
      } else if (stage === 1) {
        stage = 2
        if (chunk[1] !== 0) return reject(new Error(`SOCKS refused: ${chunk[1]}`))
        socket.write(text)
      } else {
        socket.destroy()
        resolve(chunk.toString())
      }
    })
    socket.write(Buffer.from([5, 1, 0]))
  })
}

/** The stand-in for VS Code's CLI: `--version`, and `command-shell` that listens on a loopback port and echoes. */
const STUB_SERVER = `
const net = require('node:net')
const server = net.createServer((socket) => { socket.on('error', () => {}); socket.pipe(socket) })
require('node:fs').appendFileSync(process.argv[2], process.pid + '\\n')
server.listen(0, '127.0.0.1', () => {
  process.stdout.write('Listening on 127.0.0.1:' + server.address().port + '\\n')
})
`

function installScript(options: { updateUrl: string; folder: string }): string {
  return `#!/bin/sh
# The steps of Remote-SSH's Linux exec-server installer, as the spike recorded them, against local stand-ins.
FOLDER=${quote(options.folder)}
UPDATE_URL=${quote(options.updateUrl)}
mkdir -p "$FOLDER/cli"
echo "mousse-test: start"
if [ -x "$FOLDER/cli/code" ] && "$FOLDER/cli/code" --version > /dev/null 2>&1; then
  echo "Found existing installation"
else
  echo "mousse-test: downloading"
  if command -v wget > /dev/null 2>&1; then wget -q -O "$FOLDER/cli.tgz" "$UPDATE_URL/cli.tgz" || exit 3
  elif command -v curl > /dev/null 2>&1; then curl -fsSL -o "$FOLDER/cli.tgz" "$UPDATE_URL/cli.tgz" || exit 3
  else echo "no wget or curl"; exit 2; fi
  tar -xzf "$FOLDER/cli.tgz" -C "$FOLDER/cli" || exit 4
  "$FOLDER/cli/code" --version || exit 5
fi
LOG="$FOLDER/cli.$$.log"
nohup "$FOLDER/cli/code" command-shell --on-host=127.0.0.1 --on-port > "$LOG" 2>&1 < /dev/null &
i=0
while [ $i -lt 200 ]; do
  line=$(grep -m1 "Listening on" "$LOG" 2>/dev/null) && break
  i=$((i+1)); sleep 0.1
done
echo "mousse-test: $line"
exec sleep 3600
`
}

/** A server that gives `files` by path, or, with `any`, the same body for every path. */
async function updateServer(
  files: Record<string, Buffer>,
  any?: Buffer
): Promise<{ url: string; requests: string[] }> {
  const requests: string[] = []
  const server = createHttpServer((request, response) => {
    requests.push(request.url ?? '')
    const body = any ?? files[(request.url ?? '').replace(/^\//u, '')]
    if (!body) {
      response.statusCode = 404
      return void response.end()
    }
    response.setHeader('content-length', body.length)
    response.end(body)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, requests }
}

describe.skipIf(!unix)('what the editors do on the owner', () => {
  it('runs VS Code Remote-SSH’s install and exec-server steps, reaches the server through -D, and a block ends it', async () => {
    const b = await bed()
    const work = join(tmpdir(), `ep-vscode-${process.pid}`)
    await mkdir(join(work, 'pack'), { recursive: true })
    cleanup.push(() => rm(work, { recursive: true, force: true }))
    const stub = join(work, 'stub.cjs')
    await writeFile(stub, STUB_SERVER)
    await writeFile(
      join(work, 'pack', 'code'),
      `#!/bin/sh\ncase "$1" in --version) echo "code 0.0.0-test"; exit 0;; esac\nexec ${quote(process.execPath)} ${quote(stub)} ${quote(join(work, 'pids'))}\n`,
      { mode: 0o755 }
    )
    const packed = spawnSync('tar', [
      '-czf',
      join(work, 'cli.tgz'),
      '-C',
      join(work, 'pack'),
      'code'
    ])
    expect(packed.status).toBe(0)
    const update = await updateServer({ 'cli.tgz': await readFile(join(work, 'cli.tgz')) })
    const folder = join(b.ownerHome, '.vscode-server')
    const script = installScript({ updateUrl: update.url, folder })

    const connect = async (): Promise<{
      port: number
      close(): void
      output(): string
      ssh: number
    }> => {
      const socks = await freePort()
      const ssh = b.start('ssh', ['-T', '-D', `127.0.0.1:${socks}`, 'mousse-owner', 'sh'], {
        stdin: true
      })
      cleanup.push(() => ssh.kill('SIGKILL'))
      ssh.stdin!.on('error', () => {})
      ssh.stdin!.write(script)
      await until(
        () => /mousse-test: Listening on 127\.0\.0\.1:\d+/u.test(ssh.output().stdout),
        30_000
      )
      const port = Number(/Listening on 127\.0\.0\.1:(\d+)/u.exec(ssh.output().stdout)![1])
      // The editor reaches the server through the SOCKS proxy that ssh opened (-D).
      await until(
        async () => (await socksEcho(socks, port, 'hello').catch(() => '')) === 'hello',
        20_000
      )
      return {
        port,
        close: () => ssh.kill('SIGKILL'),
        output: () => ssh.output().stdout,
        ssh: ssh.pid!
      }
    }

    const first = await connect()
    expect(first.output()).toContain('mousse-test: downloading')
    expect(update.requests).toEqual(['/cli.tgz'])
    // The pid each stand-in server recorded when it started.
    const pids = async (): Promise<number[]> =>
      (await readFile(join(work, 'pids'), 'utf8').catch(() => ''))
        .split('\n')
        .filter(Boolean)
        .map(Number)
    const [serverPid] = await pids()
    expect(await alive(serverPid!)).toBe(true)

    // The window closes: an ordinary end. The server the script started keeps running, for a reconnection.
    first.close()
    await new Promise((resolve) => setTimeout(resolve, 800))
    expect(await alive(serverPid!)).toBe(true)

    // Reconnecting finds the install and downloads nothing.
    const second = await connect()
    expect(second.output()).toContain('Found existing installation')
    expect(update.requests).toEqual(['/cli.tgz'])

    // The owner blocks the device: every server it started goes, the detached one included.
    const all = await pids()
    expect(all.length).toBe(2)
    await b.block(true)
    await until(async () => !(await Promise.all(all.map(alive))).some(Boolean), 15_000)
  })

  const extension = process.env.MOUSSE_VSCODE_REMOTE_SSH_DIR
  it.skipIf(
    !extension ||
      !existsSync(
        join(extension, 'out', 'install-script', 'scripts', 'linux-exec-server-installer.sh')
      )
  )(
    'runs the installed Remote-SSH extension’s own Linux exec-server installer unchanged',
    async () => {
      const b = await bed()
      const work = join(tmpdir(), `ep-vscode-real-${process.pid}`)
      await mkdir(join(work, 'pack'), { recursive: true })
      cleanup.push(() => rm(work, { recursive: true, force: true }))
      const stub = join(work, 'stub.cjs')
      await writeFile(stub, STUB_SERVER)
      await writeFile(
        join(work, 'pack', 'code'),
        `#!/bin/sh\ncase "$1" in --version) echo "code 0.0.0-test"; exit 0;; esac\nexec ${quote(process.execPath)} ${quote(stub)} ${quote(join(work, 'pids'))}\n`,
        { mode: 0o755 }
      )
      spawnSync('tar', ['-czf', join(work, 'cli.tgz'), '-C', join(work, 'pack'), 'code'])
      // Whatever path the installer asks for gets the archive.
      const update = await updateServer({}, await readFile(join(work, 'cli.tgz')))
      const url = update.url
      const folder = join(b.ownerHome, '.vscode-server')
      const values: Record<string, string> = {
        uuid: 'test-uuid-0001',
        commitId: '0123456789abcdef0123456789abcdef01234567',
        quality: 'stable',
        token: 'testtoken',
        vscodeAgentFolder: folder,
        allowClientDownload: '0',
        forceClientDownload: '0',
        cliNameInArchive: 'code',
        ignoreWgetConfigFlag: '',
        ignoreCurlConfigFlag: '',
        wgetTriesSegment: '--tries=1',
        listenArgs: '--on-host=127.0.0.1 --on-port',
        verbose: '0',
        httpProxy: '',
        httpsProxy: '',
        reconnectionGraceTime: '',
        updateUrl: url,
        getDownloadServerStartTrigger: 'test-dl-start',
        getDownloadServerEndTrigger: 'test-dl-end',
        getProgressDownloading: 'test-progress-downloading',
        getProgressInstalling: 'test-progress-installing',
        printVars: ''
      }
      const text = (
        await readFile(
          join(extension!, 'out', 'install-script', 'scripts', 'linux-exec-server-installer.sh'),
          'utf8'
        )
      ).replace(/#<<([\w.]+)>>/gu, (all, key: string) =>
        key in values
          ? values[key]!
          : key.startsWith('ExitCode.')
            ? '1'
            : key.startsWith('InstallUnpackCode.')
              ? key.split('.')[1]!.toLowerCase()
              : all
      )
      const socks = await freePort()
      const ssh = b.start('ssh', ['-T', '-D', `127.0.0.1:${socks}`, 'mousse-owner', 'sh'], {
        stdin: true
      })
      cleanup.push(() => ssh.kill('SIGKILL'))
      ssh.stdin!.write(text)
      await until(() => /listeningOn==127\.0\.0\.1:\d+==/u.test(ssh.output().stdout), 40_000)
      const port = Number(/listeningOn==127\.0\.0\.1:(\d+)==/u.exec(ssh.output().stdout)![1])
      await until(
        async () => (await socksEcho(socks, port, 'real').catch(() => '')) === 'real',
        20_000
      )
      expect(update.requests.length).toBeGreaterThan(0)
    },
    120_000
  )

  it('replays Zed’s probe, SFTP upload, unpack and proxy round trip, and keeps its daemon until a block', async () => {
    const b = await bed()
    const work = join(tmpdir(), `ep-zed-${process.pid}`)
    await mkdir(work, { recursive: true })
    cleanup.push(() => rm(work, { recursive: true, force: true }))

    const probe = await b.tool('ssh', ['mousse-owner', 'uname -sm; echo $HOME'])
    expect(probe.stdout.toString()).toMatch(
      new RegExp(
        `^(Linux|Darwin) \\S+\\n${b.ownerHome.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\n$`,
        'u'
      )
    )

    // The "server": starts a detached daemon once, as Zed's does, and then relays its standard input and output.
    const daemonPid = join(b.ownerHome, '.zed_server', 'daemon.pid')
    const server = `#!/bin/sh
if [ "$1" = proxy ]; then
  if [ ! -f "$HOME/.zed_server/daemon.pid" ] || ! kill -0 "$(cat "$HOME/.zed_server/daemon.pid")" 2>/dev/null; then
    ${quote(process.execPath)} -e ${quote(`const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});require('node:fs').writeFileSync(process.argv[1],String(c.pid));c.unref()`)} "$HOME/.zed_server/daemon.pid"
  fi
  exec cat
fi
`
    const { gzipSync } = await import('node:zlib')
    const archive = join(work, 'zed-remote-server.gz')
    await writeFile(archive, gzipSync(Buffer.from(server)))
    expect((await b.tool('ssh', ['mousse-owner', 'mkdir -p ~/.zed_server'])).code).toBe(0)
    const upload = await b.tool('sftp', ['-b', '-', 'mousse-owner'], {
      stdin: `put ${archive} .zed_server/zed-remote-server.gz\n`
    })
    expect(upload.code, upload.stderr).toBe(0)
    const unpack = await b.tool('ssh', [
      'mousse-owner',
      'set -e; gunzip -f ~/.zed_server/zed-remote-server.gz; chmod 755 ~/.zed_server/zed-remote-server; echo unpacked'
    ])
    expect(unpack.stdout.toString()).toBe('unpacked\n')

    // 4 MiB through the proxy's standard input and output, byte for byte.
    const payload = randomBytes(4 * 1024 * 1024)
    const started = Date.now()
    const child = spawn(
      'ssh',
      [...b.sshArgs, 'mousse-owner', '~/.zed_server/zed-remote-server proxy --identifier test'],
      {
        env: { PATH: process.env.PATH, HOME: b.userHome },
        stdio: ['pipe', 'pipe', 'pipe']
      }
    )
    cleanup.push(() => child.kill('SIGKILL'))
    const closed = new Promise((resolve) => child.once('close', resolve))
    const hash = createHash('sha256')
    let received = 0
    child.stdout.on('data', (chunk: Buffer) => {
      hash.update(chunk)
      received += chunk.length
    })
    child.stdin.on('error', () => {})
    child.stdin.end(payload)
    await until(() => received >= payload.length, 120_000)
    const seconds = (Date.now() - started) / 1000
    expect(hash.digest('hex')).toBe(createHash('sha256').update(payload).digest('hex'))
    console.info(`zed-style round trip: 4 MiB each way in ${seconds.toFixed(1)} s`)
    await closed

    // The proxy channel is over; the daemon it started is not, and it dies with a block.
    const pid = Number((await readFile(daemonPid, 'utf8')).trim())
    expect(await alive(pid)).toBe(true)
    await b.block(true)
    await until(async () => !(await alive(pid)), 15_000)
  }, 180_000)
})
