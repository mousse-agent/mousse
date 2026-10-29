import { execFile, spawn, spawnSync } from 'node:child_process'
import { symlinkSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir, userInfo } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EditorEndpoint } from '../../../src/mms/net/editor/endpoint/endpoint'
import { scopeToken } from '../../../src/mms/net/editor/endpoint/scope'
import {
  createWindowsHost,
  jobName,
  type WindowsProcessHost
} from '../../../src/mms/net/editor/endpoint/windowsHost'
import {
  alive,
  endpointBed,
  NODE_A,
  NODE_B,
  run,
  sshdHelper,
  until,
  type Bed,
  type SshClient
} from '../helpers/endpointBed'

/**
 * The endpoint on a Windows owner: every session under the helper `sshd.exe`, every program of a device in the
 * device's Job object. `ssh2`'s own client is the peer over a pair of streams. The programs are real (cmd and
 * PowerShell of the user the tests run as, in a throwaway home); nothing reads the real home's files. These run on
 * Windows with the helper built (`node scripts/build-sshd-helper.mjs`), and are skipped elsewhere.
 */

const windows = process.platform === 'win32' && sshdHelper !== undefined
vi.setConfig({ testTimeout: 60_000 })
const cleanup: Array<() => Promise<unknown> | unknown> = []
afterEach(async () => {
  vi.unstubAllEnvs()
  for (const task of cleanup.splice(0).reverse()) await task()
})
async function bed(): Promise<Bed> {
  const b = await endpointBed()
  cleanup.push(() => b.close())
  return b
}

function channelOf(
  open: (callback: (error: Error | undefined, channel: any) => void) => unknown
): Promise<any> {
  return new Promise((resolve, reject) =>
    open((error, channel) => (error ? reject(error) : resolve(channel)))
  )
}

/** A PowerShell command line that runs `script`, with no quoting to get wrong. */
function powershell(script: string): string {
  return `powershell -NoLogo -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(script, 'utf16le').toString('base64')}`
}

/** Starts a program that detaches itself from the session, as `Start-Process` does, and returns its pid. */
async function detached(client: SshClient): Promise<number> {
  const result = await run(
    client,
    powershell(
      "(Start-Process -WindowStyle Hidden -PassThru powershell -ArgumentList '-NoProfile','-Command','Start-Sleep 300').Id"
    )
  )
  const pid = Number(/(\d+)\s*$/u.exec(result.stdout.toString())?.[1])
  expect(Number.isInteger(pid)).toBe(true)
  cleanup.push(() => {
    if (pid) spawnSync('taskkill', ['/PID', String(pid), '/F'], { windowsHide: true })
  })
  return pid
}

describe.skipIf(!windows)('programs on a Windows owner', () => {
  it('runs a command through cmd with its exit code, its standard error and its input', async () => {
    const b = await bed()
    const { client } = await b.connect()
    expect(await run(client, 'exit 3')).toMatchObject({ code: 3, signal: null })
    const split = await run(client, 'echo out& (echo err)1>&2')
    expect(split.stdout.toString()).toBe('out\r\n')
    expect(split.stderr).toBe('err\r\n')
    const found = await run(client, 'findstr keep', { stdin: 'keep me\r\ndrop me\r\n' })
    expect(found.stdout.toString()).toBe('keep me\r\n')
    expect(await run(client, 'no-such-command-for-the-test')).toMatchObject({ code: 1 })
  })

  it('quotes a command as sshd does: cmd /c "<command>", so quotes, spaces and & reach cmd as written', async () => {
    const b = await bed()
    const { client } = await b.connect()
    const node = await run(
      client,
      `"${process.execPath}" -e "console.log(process.argv.slice(1).join('|'))" "a b" c`
    )
    expect(node.stdout.toString()).toBe('a b|c\n')
    expect((await run(client, 'echo a& echo b')).stdout.toString()).toBe('a\r\nb\r\n')
    // One program path with a space and no quotes: sshd's quotes around it make cmd run it as it is (with
    // `/s` it would not).
    const folder = join(b.home, 'with space')
    await mkdir(folder)
    await writeFile(join(folder, 'hello.cmd'), '@echo hello from a folder with a space\r\n')
    expect((await run(client, join(folder, 'hello.cmd'))).stdout.toString()).toBe(
      'hello from a folder with a space\r\n'
    )
  })

  it('follows a junction a user made, which Windows’s guard for programs named sshd.exe would refuse', async () => {
    const b = await bed()
    const real = join(b.home, 'real folder')
    await mkdir(real)
    await writeFile(join(real, 'file.txt'), 'through the junction\r\n')
    const junction = join(b.home, 'junction')
    symlinkSync(real, junction, 'junction')
    const { client } = await b.connect()
    const read = await run(client, `type "${junction}\\file.txt"`)
    expect(read.stderr).toBe('')
    expect(read.stdout.toString()).toBe('through the junction\r\n')
    // A program's program too, and the helper is still the ancestor VS Code looks for.
    const nested = await run(
      client,
      powershell(
        `Get-Content '${junction}\\file.txt'; $p = $PID; while ($p) { $q = (Get-CimInstance Win32_Process -Filter "ProcessId=$p").ParentProcessId; if ($q -and (Get-Process -Id $q -ea 0).Name -eq 'sshd') { 'sshd-ancestor'; break }; $p = $q }`
      )
    )
    expect(nested.stdout.toString()).toContain('through the junction')
    expect(nested.stdout.toString()).toContain('sshd-ancestor')
  })

  it('runs a command after a terminal of the same device, and a terminal after a command', async (context) => {
    const b = await bed()
    if (!b.host.terminals()) return context.skip()
    const { client } = await b.connect()
    const terminal = await channelOf((callback) =>
      client.exec('cmd', { pty: { rows: 24, cols: 80, term: 'xterm' } }, callback)
    )
    let text = ''
    terminal.on('data', (chunk: Buffer) => (text += chunk.toString('utf8')))
    terminal.write('echo terminal-up\r\n')
    await until(() => text.includes('terminal-up'))
    // The terminal is still open, and its job holds the device's programs.
    expect(await run(client, 'echo after-the-terminal')).toMatchObject({ code: 0 })
    expect((await run(client, 'echo again')).stdout.toString()).toBe('again\r\n')
    terminal.write('exit\r\n')
    await new Promise((resolve) => terminal.on('close', resolve))
    const second = await channelOf((callback) =>
      client.exec('cmd /c echo second-terminal', { pty: true }, callback)
    )
    let more = ''
    second.on('data', (chunk: Buffer) => (more += chunk.toString('utf8')))
    await new Promise((resolve) => second.on('close', resolve))
    expect(more).toContain('second-terminal')
  })

  it('runs from a helper whose path has a space, as under a profile name with one', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mousse helper '))
    cleanup.push(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
    const helper = join(root, 'with space', 'sshd.exe')
    await mkdir(dirname(helper))
    await copyFile(sshdHelper!, helper)
    const home = join(root, 'home')
    await mkdir(home)
    const host = createWindowsHost({ helper, account: { user: userInfo().username, home } })
    const b = await endpointBed({ host })
    cleanup.push(() => b.close())
    const { client } = await b.connect()
    expect((await run(client, 'echo spaced')).stdout.toString()).toBe('spaced\r\n')
    if (host.terminals()) {
      const channel = await channelOf((callback) =>
        client.exec('cmd /c echo spaced-terminal', { pty: true }, callback)
      )
      let text = ''
      channel.on('data', (chunk: Buffer) => (text += chunk.toString('utf8')))
      await new Promise((resolve) => channel.on('close', resolve))
      expect(text).toContain('spaced-terminal')
    }
  })

  it('starts in the throwaway home with a logon environment and none of the daemon’s', async () => {
    const planted = {
      ANTHROPIC_API_KEY: 'planted-anthropic',
      OPENAI_API_KEY: 'planted-openai',
      MOUSSE_DAEMON_TOKEN: 'planted-token',
      ELECTRON_RUN_AS_NODE: 'planted-electron-flag',
      NODE_OPTIONS: '--require=planted-hook.js'
    }
    for (const [name, value] of Object.entries(planted)) vi.stubEnv(name, value)
    vi.stubEnv('PATH', `${process.env.PATH};C:\\planted-daemon-path`)
    const b = await bed()
    const { client } = await b.connect()
    const output = (await run(client, 'cd& set')).stdout.toString()
    const lines = output.split('\r\n')
    // Only yes/no answers are compared, so a failure never prints the environment.
    expect(lines[0] === b.home).toBe(true)
    expect(Object.keys(planted).filter((name) => output.includes(`${name}=`))).toEqual([])
    expect(Object.values(planted).filter((value) => output.includes(value)).length).toBe(0)
    expect(output.includes('planted-daemon-path')).toBe(false)
    expect(lines.includes(`USERPROFILE=${b.home}`)).toBe(true)
    expect(lines.includes(`HOME=${b.home}`)).toBe(true)
    expect(lines.includes(`USERNAME=${b.user}`)).toBe(true)
    expect(lines.some((line) => /^Path=.+/iu.test(line))).toBe(true)
    expect(lines.some((line) => /^SystemRoot=.+/iu.test(line))).toBe(true)
    expect(
      lines.filter((line) => /^\w+=.*%\w+%/u.test(line)).map((line) => line.split('=')[0])
    ).toEqual([])
    expect(
      lines.some((line) => /^SSH_CONNECTION=127\.0\.0\.1 \d+ 127\.0\.0\.1 22$/u.test(line))
    ).toBe(true)
    expect(lines.some((line) => /^MOUSSE_EDITOR_SCOPE=[0-9a-f]{40}$/u.test(line))).toBe(true)
    expect(lines.some((line) => line.startsWith('MOUSSE_SSHD_ENV='))).toBe(false)
  })

  it('takes only the allow-listed variables a client sets', async () => {
    const b = await bed()
    const { client } = await b.connect()
    const output = (
      await run(client, 'echo [%LANG%][%FOO%]', { env: { LANG: 'de_DE.UTF-8', FOO: 'bar' } })
    ).stdout.toString()
    expect(output).toBe('[de_DE.UTF-8][%FOO%]\r\n')
  })

  it('reads a script on standard input for a shell request, as cmd does under sshd', async () => {
    const b = await bed()
    const { client } = await b.connect()
    const channel = await channelOf((callback) => client.shell(false, callback))
    const out: Buffer[] = []
    channel.on('data', (chunk: Buffer) => out.push(chunk))
    let code: number | undefined
    channel.on('exit', (status: number) => (code = status))
    channel.end('echo shell-ok\r\nexit 4\r\n')
    await new Promise((resolve) => channel.on('close', resolve))
    expect(Buffer.concat(out).toString()).toContain('shell-ok')
    expect(code).toBe(4)
  })

  it('gives a terminal that changes size', async (context) => {
    const b = await bed()
    if (!b.host.terminals()) return context.skip()
    const { client } = await b.connect()
    const channel = await channelOf((callback) =>
      client.exec('cmd', { pty: { rows: 30, cols: 100, term: 'xterm' } }, callback)
    )
    let text = ''
    channel.on('data', (chunk: Buffer) => (text += chunk.toString('utf8')))
    channel.write('mode con\r\n')
    await until(() => /Columns:\s+100/u.test(text), 20_000)
    channel.setWindow(40, 132, 0, 0)
    await new Promise((resolve) => setTimeout(resolve, 500))
    channel.write('mode con\r\n')
    await until(() => /Columns:\s+132/u.test(text), 20_000)
    channel.write('exit\r\n')
    await new Promise((resolve) => channel.on('close', resolve))
  })

  it('has an ancestor named sshd, which VS Code’s Windows server script looks for, and it is the session’s helper', async () => {
    const b = await bed()
    const { client } = await b.connect()
    // The check of Remote-SSH's Windows script: walk the parents until one is named sshd, or give up.
    const check = `
$current = $PID
while ($true) {
  $parent = (Get-CimInstance Win32_Process | Where-Object ProcessId -eq $current).ParentProcessId
  if (!$parent) { "no sshd parent proc"; exit 0 }
  if ((Get-Process -Id $parent).Name -eq 'sshd') { "sshd=$parent"; exit 0 }
  $current = $parent
}`
    const result = await run(client, powershell(check))
    const pid = Number(/sshd=(\d+)/u.exec(result.stdout.toString())?.[1])
    expect(result.stdout.toString()).not.toContain('no sshd parent proc')
    expect(Number.isInteger(pid)).toBe(true)
    // It ended with its session.
    await until(async () => !(await alive(pid)))
  })

  it('serves SFTP with Windows paths, and / lists the drives', async () => {
    const b = await bed()
    const { client } = await b.connect()
    const sftp = await channelOf((callback) => client.sftp(callback))
    const call = <T>(
      fn: (done: (error: Error | null | undefined, value?: T) => void) => unknown
    ): Promise<T> =>
      new Promise((resolve, reject) =>
        fn((error, value) => (error ? reject(error) : resolve(value as T)))
      )
    const remoteHome = `/${b.home.replace(/\\/gu, '/')}`
    expect(await call<string>((done) => sftp.realpath('.', done))).toBe(remoteHome)
    await call((done) => sftp.writeFile(`${remoteHome}/a.txt`, 'over sftp', done))
    expect(await readFile(join(b.home, 'a.txt'), 'utf8')).toBe('over sftp')
    const drives = await call<Array<{ filename: string }>>((done) => sftp.readdir('/', done))
    const system = (process.env.SystemDrive ?? 'C:').toUpperCase()
    expect(drives.map((entry) => entry.filename)).toContain(system)
  })
})

describe.skipIf(!windows)('ending on a Windows owner', () => {
  it('an ordinary end ends only the session’s helper; a detached server keeps running until a block', async () => {
    const b = await bed()
    const session = await b.connect()
    const server = await detached(session.client)
    session.connection.end(false)
    await new Promise((resolve) => setTimeout(resolve, 800))
    expect(await alive(server)).toBe(true)
    // The device is stopped from outside, as a block does, after its session ended.
    await b.endpoint.killDevice(NODE_A)
    await until(async () => !(await alive(server)), 10_000)
  })

  it('a forced end stops everything the device started, at once and without holding the thread', async () => {
    const b = await bed()
    const session = await b.connect()
    const server = await detached(session.client)
    let worst = 0
    let last = Date.now()
    const timer = setInterval(() => {
      const now = Date.now()
      worst = Math.max(worst, now - last)
      last = now
    }, 5)
    const before = Date.now()
    session.connection.end(true)
    expect(Date.now() - before).toBeLessThan(250)
    await until(async () => !(await alive(server)), 10_000)
    clearInterval(timer)
    expect(worst).toBeLessThan(500)
  })

  it('stops nothing of another device', async () => {
    const b = await bed()
    const first = await b.connect({ node: NODE_A })
    const other = await b.connect({ node: NODE_B })
    const mine = await detached(first.client)
    const theirs = await detached(other.client)
    await b.endpoint.killDevice(NODE_A)
    await until(async () => !(await alive(mine)), 10_000)
    expect(await alive(theirs)).toBe(true)
  })

  it('a daemon that started again still ends what the device started before', async () => {
    const b = await bed()
    const session = await b.connect()
    const server = await detached(session.client)
    session.connection.end(false)
    const scope = b.endpoint.scopeOf(NODE_A)
    // The daemon goes: its keepers are let go, as its exit closes their pipes. The job is still held.
    ;(b.host as WindowsProcessHost).release()
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(await alive(server)).toBe(true)
    // A new daemon knows nothing of the old one's sessions; it reaches the job by the device's name.
    const again = createWindowsHost({
      helper: sshdHelper!,
      account: { user: b.user, home: b.home }
    })
    await again.killScope(scope)
    expect(await alive(server)).toBe(false)
    again.release()
  })
})

describe.skipIf(!windows)('the sweep on a Windows owner', () => {
  /** A server that outlives everything that started it: its starting command has exited, and so has the connection. */
  async function leftBehind(b: Bed, node = NODE_A): Promise<number> {
    const session = await b.connect({ node })
    const server = await detached(session.client)
    session.connection.end(false)
    await until(() => b.host.scopes().length === 0)
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(await alive(server)).toBe(true)
    return server
  }

  it('stops a detached server whose starting command has exited and whose window has closed', async () => {
    const b = await bed()
    const server = await leftBehind(b)
    const bystander = await leftBehind(b, NODE_B)
    // Nothing here knows the device any more: no connection and no program. The jobs are the list.
    expect(b.host.scopes()).toEqual([])
    await b.endpoint.sweep([NODE_B])
    expect(await alive(server)).toBe(false)
    expect(await alive(bystander)).toBe(true)
    await b.endpoint.sweep([NODE_B])
    expect(await alive(bystander)).toBe(true)
    await b.endpoint.sweep([])
    expect(await alive(bystander)).toBe(false)
  })

  it('stops it after a restart too: a new endpoint on the same key store reaches the old jobs by their names', async () => {
    const b = await bed()
    const server = await leftBehind(b)
    // The daemon goes: its keepers are let go, as its exit closes their pipes, and hold the job while it is not empty.
    ;(b.host as WindowsProcessHost).release()
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(await alive(server)).toBe(true)
    const host = createWindowsHost({ helper: sshdHelper!, account: { user: b.user, home: b.home } })
    cleanup.push(() => host.release())
    const restarted = new EditorEndpoint({ keys: b.keys, host })
    await until(() => restarted.available())
    await restarted.sweep([NODE_A])
    expect(await alive(server)).toBe(true)
    await restarted.sweep([])
    expect(await alive(server)).toBe(false)
  })

  it('leaves the jobs of another key alone, and a job that holds the daemon itself', async () => {
    const b = await bed()
    const stray = await leftBehind(b)
    // Another profile's device: its own key, its own marker prefix.
    const foreign = scopeToken(Buffer.alloc(32, 9), NODE_A)
    const program = await b.host.start({
      command: powershell(
        "(Start-Process -WindowStyle Hidden -PassThru powershell -ArgumentList '-NoProfile','-Command','Start-Sleep 300').Id"
      ),
      requested: {},
      sshConnection: '127.0.0.1 1 127.0.0.1 22',
      scope: foreign
    })
    let text = ''
    program.output.on('data', (chunk: Buffer) => (text += chunk.toString('utf8')))
    await new Promise<void>((resolve) => program.onClose(resolve))
    const foreignPid = Number(/(\d+)\s*$/u.exec(text)?.[1])
    cleanup.push(() => b.host.killScope(foreign))
    await b.endpoint.sweep([])
    expect(await alive(stray)).toBe(false)
    expect(await alive(foreignPid)).toBe(true)

    // A daemon started from an editor's terminal is inside that device's job: the helper will not end that job.
    const { client } = await b.connect()
    const name = jobName(b.endpoint.scopeOf(NODE_A))
    const script =
      "const r=require('child_process').spawnSync(process.argv[1],['end',String(process.pid),process.argv[2]],{encoding:'utf8'});console.log(r.status+' '+r.stdout.trim())"
    const inside = await run(
      client,
      `"${process.execPath}" -e "${script}" "${sshdHelper}" "${name}"`
    )
    expect(inside.stdout.toString()).toMatch(/^4 0 [1-9]\d*\s*$/u)
  })
})

describe.skipIf(!windows)('a daemon that is a process of its own', () => {
  /**
   * The Windows host bundled into one file, so that a plain `node` process (a stand-in daemon, with the job Node
   * gives its children) can run it.
   */
  async function bundledHost(folder: string): Promise<string> {
    const { build } = (await import('esbuild')) as typeof import('esbuild')
    const outfile = join(folder, 'host.mjs')
    await build({
      entryPoints: [
        fileURLToPath(
          new URL('../../../src/mms/net/editor/endpoint/windowsHost.ts', import.meta.url)
        )
      ],
      bundle: true,
      platform: 'node',
      format: 'esm',
      outfile,
      external: ['node-pty'],
      logLevel: 'silent'
    })
    return outfile
  }

  it('survives the daemon’s death: a detached server keeps running, and a new daemon’s sweep ends it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mousse daemon '))
    cleanup.push(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
    const home = join(root, 'home')
    await mkdir(home)
    const host = await bundledHost(root)
    const scope = 'cd'.repeat(20)
    const script = join(root, 'daemon.mjs')
    await writeFile(
      script,
      `import { createWindowsHost } from ${JSON.stringify(pathToFileURL(host).href)}
const [helper, home, scope, server] = process.argv.slice(2)
setInterval(() => {}, 1000)
const host = createWindowsHost({ helper, account: { user: ${JSON.stringify(userInfo().username)}, home } })
const program = await host.start({ command: server, requested: {}, sshConnection: '127.0.0.1 1 127.0.0.1 22', scope })
let text = ''
program.output.on('data', (chunk) => (text += chunk))
program.onClose(() => console.log('server=' + text.trim()))
`
    )
    const daemon = spawn(
      process.execPath,
      [
        script,
        sshdHelper!,
        home,
        scope,
        powershell(
          "(Start-Process -WindowStyle Hidden -PassThru powershell -ArgumentList '-NoProfile','-Command','Start-Sleep 300').Id"
        )
      ],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
    )
    let said = ''
    daemon.stdout.on('data', (chunk: Buffer) => (said += chunk.toString('utf8')))
    daemon.stderr.on('data', (chunk: Buffer) => (said += chunk.toString('utf8')))
    cleanup.push(() => daemon.kill())
    await until(() => /server=\d+/u.test(said), 30_000).catch(() => {
      throw new Error(`the stand-in daemon did not start the server: ${said}`)
    })
    const server = Number(/server=(\d+)/u.exec(said)![1])
    cleanup.push(() => spawnSync('taskkill', ['/PID', String(server), '/F'], { windowsHide: true }))
    // The daemon process is killed: its own job, which Node made for its children, ends with it.
    daemon.kill()
    await new Promise((resolve) => daemon.once('exit', resolve))
    await new Promise((resolve) => setTimeout(resolve, 2_000))
    expect(await alive(server)).toBe(true)
    // A new daemon, which never knew the device, reaches the job by its name: the device still has its right...
    const again = createWindowsHost({
      helper: sshdHelper!,
      account: { user: userInfo().username, home }
    })
    cleanup.push(() => again.release())
    expect(await again.sweep(() => true)).toBe(0)
    expect(await alive(server)).toBe(true)
    // ...until it is blocked.
    expect(await again.sweep((theirs) => theirs !== scope)).toBeGreaterThan(0)
    expect(await alive(server)).toBe(false)
  })
})

describe.skipIf(!windows)('the helper', () => {
  const runHelper = (
    args: string[]
  ): Promise<{ code: number | null; stdout: string; stderr: string }> =>
    new Promise((resolve) =>
      execFile(sshdHelper!, args, { windowsHide: true }, (error, stdout, stderr) =>
        resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, stdout, stderr })
      )
    )

  it('acts only for the process that started it, and only on a device’s job', async () => {
    const name = jobName('0'.repeat(32))
    const stranger = await runHelper(['end', '4', name])
    expect(stranger.code).toBe(2)
    expect(stranger.stderr).toMatch(/only runs for the Mousse daemon/u)
    expect((await runHelper(['end', String(process.pid), 'Local\\SomethingElse'])).code).toBe(2)
    expect((await runHelper(['nonsense'])).code).toBe(2)
    // A job that does not exist has nothing to end.
    expect(await runHelper(['end', String(process.pid), name])).toMatchObject({
      code: 0,
      stdout: '0 0\n'
    })
  })

  it('stays small: a session’s helper uses less than 1 MB of private memory', async () => {
    const b = await bed()
    const { client } = await b.connect()
    // PowerShell's parent is cmd, whose parent is the helper.
    const result = await run(
      client,
      powershell(
        '$cmd = (Get-CimInstance Win32_Process -Filter "ProcessId=$PID").ParentProcessId; $helper = (Get-CimInstance Win32_Process -Filter "ProcessId=$cmd").ParentProcessId; (Get-Process -Id $helper).Name; (Get-Process -Id $helper).PrivateMemorySize64'
      )
    )
    const [name, bytes] = result.stdout.toString().trim().split(/\r?\n/u)
    expect(name).toBe('sshd')
    console.info(`helper private memory: ${(Number(bytes) / 1024).toFixed(0)} KiB`)
    expect(Number(bytes)).toBeLessThan(1024 * 1024)
  })

  it('makes the endpoint unavailable when it cannot run, and tries again later', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mousse retry '))
    cleanup.push(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
    const helper = join(root, 'sshd.exe')
    const missing = createWindowsHost({ helper, retryDelays: [300] })
    cleanup.push(() => missing.release())
    await until(() => missing.ready?.() === false)
    // The helper turns up (an antivirus scan let it go): the next try finds it.
    await copyFile(sshdHelper!, helper)
    await until(() => missing.ready?.() === true, 10_000)
    const { systemProcessHost } = await import('../../../src/mms/net/editor/endpoint/systemHost')
    expect(systemProcessHost('win32', () => undefined)).toBeUndefined()
  })
})
