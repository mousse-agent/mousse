/**
 * What runs for a folder, read from the real computer (`RunningRegistry`): a quick action's dev server in a real Mousse
 * terminal, a background command an agent left running, a server started outside Mousse, and a bot's background
 * command. Each one is a real process listening on a real port, read with the system's own tools (`ps`, and `lsof` on
 * macOS or `ss` on Linux). Windows' listings are covered by the parser rows below, from recorded output shapes.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BotWatchers } from '../../src/mms/bots/watchers'
import {
  addressesOf,
  defaultRunningSystem,
  foregroundJob,
  processTree,
  RunningRegistry,
  runningLine,
  runningNote,
  type RunningSources,
  type RunningThreadInfo,
  type RunningWatcher
} from '../../src/mms/running/RunningRegistry'
import {
  elapsedSeconds,
  parseLsofCwds,
  parseLsofListeners,
  parseNetstatListeners,
  parsePosixProcessTable,
  parseSsListeners,
  parseWindowsProcessTable
} from '../../src/mms/running/snapshot'
import { PtyManager } from '../../src/mms/terminals/PtyManager'

const NODE = process.execPath
/** A dev server: listens on a free port and prints its address the way Vite does. */
const SERVER = `const http = require('node:http')
const server = http.createServer((_req, res) => res.end('ok'))
server.listen(0, '127.0.0.1', () => console.log('  \\u001b[32m➜\\u001b[39m  Local:   http://localhost:' + server.address().port + '/'))
setInterval(() => {}, 1000)
`

const until = async (check: () => boolean | Promise<boolean>, ms = 10_000): Promise<void> => {
  const deadline = Date.now() + ms
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('timed out')
    await new Promise((done) => setTimeout(done, 50))
  }
}

const posix = process.platform !== 'win32'

describe.skipIf(!posix)('the running list on this computer', () => {
  let base: string
  let project: string
  let elsewhere: string
  let pty: PtyManager
  let children: ChildProcess[]
  let threads: Record<string, RunningThreadInfo>
  let watchers: RunningWatcher[]

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'mousse-running-'))
    project = join(base, 'project')
    elsewhere = join(base, 'elsewhere')
    for (const folder of [project, elsewhere]) {
      mkdirSync(folder, { recursive: true })
      writeFileSync(join(folder, 'server.cjs'), SERVER)
    }
    pty = new PtyManager()
    children = []
    threads = {
      't-agent': { title: 'Fix the header', projectId: 'p1' },
      't-other': { title: 'Write the docs', projectId: 'p1' },
      't-far': { title: 'Another project', projectId: 'p2' }
    }
    watchers = []
  })

  afterEach(async () => {
    for (const child of children) {
      try { process.kill(child.pid!, 'SIGKILL') } catch { /* gone */ }
    }
    await pty.shutdown({ timeoutMs: 5_000 }).catch(() => undefined)
    rmSync(base, { recursive: true, force: true })
  })

  const sources = (): RunningSources => ({
    terminals: () => pty.runningTerminals(),
    terminalOutput: (ptyId) => pty.getScrollback(ptyId),
    watchers: () => watchers,
    thread: (threadId) => threads[threadId],
    botName: (botId) => (botId === 'alpha' ? 'Alpha' : undefined)
  })

  /** A shell in a Mousse terminal, as the Terminal panel opens one (a quick action names it). */
  const terminal = (threadId: string, label?: string): string => {
    const saved = process.env.SHELL
    // A plain interactive shell: no profile of the person running the tests.
    process.env.SHELL = '/bin/sh'
    try {
      return pty.create('project-shell', project, undefined, { threadId, ...(label ? { label } : {}) })
    } finally {
      process.env.SHELL = saved
    }
  }

  /** A command a runtime's shell runs in the background, under this process (as an agent's runtime is under the service). */
  const background = (command: string, cwd = project): ChildProcess => {
    const child = spawn('/bin/sh', ['-c', command], { cwd, env: { ...process.env, PATH: `${dirname(NODE)}:${process.env.PATH}` }, stdio: 'ignore' })
    children.push(child)
    return child
  }

  const portOf = (url: string | undefined) => Number(new URL(url ?? 'http://x:0').port)

  it('a quick action\'s dev server in a terminal is listed by its name, as the user\'s, with the address it listens on', async () => {
    const registry = new RunningRegistry(sources())
    const running = terminal('t-other', 'Dev server')
    const idle = terminal('t-other')
    await until(() => pty.getScrollback(running).length > 0 && pty.getScrollback(idle).length > 0)
    // A terminal waiting at its prompt runs nothing.
    expect(await registry.list({ threadId: 't-agent', folders: [project], projectId: 'p1' })).toEqual([])

    pty.write(running, `"${NODE}" server.cjs\n`)
    await until(() => /Local:\s+http/.test(pty.getScrollback(running)))
    const printed = /http:\/\/localhost:(\d+)\//.exec(pty.getScrollback(running))!
    let entries = await registry.list({ threadId: 't-agent', folders: [project], projectId: 'p1' })
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ label: 'Dev server', startedBy: { kind: 'person', via: 'quick_action' }, addresses: [printed[0]] })
    expect(entries[0]!.command).toContain('server.cjs')
    expect(entries[0]!.startedAt).toBeGreaterThan(Date.now() - 60_000)
    const note = runningNote(entries, { threadId: 't-agent', folder: project }, sources(), Date.now())
    expect(note).toContain(`Dev server (\`${entries[0]!.command}\`), started by the user with a quick action, up under a minute, at ${printed[0]}`)

    // A thread of another project, in another folder, is not told of it.
    expect(await registry.list({ threadId: 't-far', folders: [elsewhere], projectId: 'p2' })).toEqual([])

    // Stopped with Ctrl-C: the terminal is back at its prompt and the list is empty.
    pty.write(running, '\u0003')
    await until(async () => (await new RunningRegistry(sources()).list({ threadId: 't-agent', folders: [project], projectId: 'p1' })).length === 0)
    entries = await new RunningRegistry(sources()).list({ threadId: 't-agent', folders: [project], projectId: 'p1' })
    expect(entries).toEqual([])
    expect(portOf(printed[0])).toBeGreaterThan(0)
  })

  it('a command an agent left running is its thread\'s; one still in its tool call, or started before the call, is not', async () => {
    let offset = 0
    const system = { ...defaultRunningSystem(), now: () => Date.now() + offset }
    const registry = new RunningRegistry(sources(), system)

    // A command still in its call (a foreground command of a turn) is not a background one.
    registry.noteCommand({ threadId: 't-agent', callId: 'fg', command: 'node server.cjs', folder: project, ended: false })
    registry.noteCommand({ threadId: 't-agent', callId: 'bg', command: 'node server.cjs', folder: project, ended: false })
    // `exec`: the shell becomes the server, so the kill below ends it (a shell that keeps a child would leave it running).
    const server = background('exec node server.cjs')
    registry.noteCommand({ threadId: 't-agent', callId: 'bg', command: 'node server.cjs', folder: project, ended: true })
    await until(async () => (await registry.list({ threadId: 't-agent', folders: [project], projectId: 'p1' }))[0]?.addresses.length === 1)

    const mine = await registry.list({ threadId: 't-agent', folders: [project], projectId: 'p1' })
    expect(mine).toHaveLength(1)
    expect(mine[0]).toMatchObject({ id: 'command:t-agent:bg', command: 'node server.cjs', startedBy: { kind: 'thread', threadId: 't-agent' }, pid: server.pid })
    expect(mine[0]!.addresses[0]).toMatch(/^http:\/\/localhost:\d+$/)
    expect(runningNote(mine, { threadId: 't-agent', folder: project }, sources(), Date.now())).toContain('`node server.cjs`, started by this thread')
    // Another thread of the project sees it as that thread's, by name and link.
    const theirs = await registry.list({ threadId: 't-other', folders: [project], projectId: 'p1' })
    expect(runningNote(theirs, { threadId: 't-other', folder: project }, sources(), Date.now())).toContain('started by thread "Fix the header" (mousse://thread/t-agent)')
    // A subagent working in its parent's folder sees it as its parent's.
    threads['t-child'] = { title: 'Check the page', projectId: 'p1', parentThreadId: 't-agent' }
    const child = await registry.list({ threadId: 't-child', folders: [project], projectId: 'p1' })
    expect(runningNote(child, { threadId: 't-child', folder: project }, sources(), Date.now())).toContain('started by your parent thread')
    // A thread of another project, in another folder, is not told of it.
    expect(await registry.list({ threadId: 't-far', folders: [elsewhere], projectId: 'p2' })).toEqual([])

    // A command noted after the process started (its call came later) is not this process.
    offset = 60_000
    const late = new RunningRegistry(sources(), system)
    late.noteCommand({ threadId: 't-other', callId: 'late', command: 'node server.cjs', folder: project, ended: true })
    expect((await late.list({ threadId: 't-other', folders: [], projectId: 'p1' })).filter((entry) => entry.id.startsWith('command:'))).toEqual([])
    offset = 0

    // Once it ends, it leaves the list.
    process.kill(server.pid!, 'SIGKILL')
    await until(async () => (await registry.list({ threadId: 't-agent', folders: [project], projectId: 'p1' })).length === 0)
  })

  it('a server started with & in a terminal is listed; one in a folder the shell moved to belongs to that folder', async () => {
    const shell = terminal('t-other')
    await until(() => pty.getScrollback(shell).length > 0)
    pty.write(shell, `"${NODE}" server.cjs &\n`)
    await until(() => /Local:\s+http/.test(pty.getScrollback(shell)))
    let entries = await new RunningRegistry(sources()).list({ threadId: 't-agent', folders: [project], projectId: 'p1' })
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ startedBy: { kind: 'person', via: 'terminal' } })
    expect(entries[0]!.addresses[0]).toMatch(/^http:\/\/localhost:\d+\/$/)
    // Stopped; then the same terminal moves to another project's folder and starts its server there.
    pty.write(shell, 'kill %1\n')
    await until(async () => (await new RunningRegistry(sources()).list({ threadId: 't-agent', folders: [project], projectId: 'p1' })).length === 0)
    pty.write(shell, `cd "${elsewhere}" && "${NODE}" server.cjs\n`)
    await until(async () => (await new RunningRegistry(sources()).list({ threadId: 't-far', folders: [elsewhere], projectId: 'p2' })).length === 1)
    entries = await new RunningRegistry(sources()).list({ threadId: 't-far', folders: [elsewhere], projectId: 'p2' })
    expect(entries[0]!.folder).toBe(realpathSync(elsewhere))
    // The project the terminal opened in is not told of it.
    expect(await new RunningRegistry(sources()).list({ threadId: 't-agent', folders: [project], projectId: 'p1' })).toEqual([])
  })

  it('a server started outside Mousse that works in the folder is listed; one in another folder is not', async () => {
    // As seen from a service that started none of these processes.
    const registry = new RunningRegistry(sources(), { ...defaultRunningSystem(), selfPid: 2 ** 30 })
    const inside = background(`exec "${NODE}" server.cjs`)
    const outside = background(`exec "${NODE}" server.cjs`, elsewhere)
    await until(async () => (await registry.list({ folders: [project, elsewhere] })).length === 2)
    const entries = await registry.list({ threadId: 't-agent', folders: [project], projectId: 'p1' })
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ pid: inside.pid, startedBy: { kind: 'outside' } })
    expect(entries[0]!.addresses[0]).toMatch(/^http:\/\/localhost:\d+$/)
    expect(outside.pid).not.toBe(inside.pid)
    expect(runningNote(entries, { threadId: 't-agent', folder: project }, sources(), Date.now())).toContain('started outside Mousse')
  })

  it('a bot\'s background command is listed for that bot, by its title and the address it printed', async () => {
    const files = join(base, 'bots', 'files', 'alpha')
    mkdirSync(files, { recursive: true })
    writeFileSync(join(files, 'server.cjs'), SERVER)
    const ends: unknown[] = []
    const bots = new BotWatchers({ onEnd: (_spec, end) => ends.push(end) })
    watchers = bots.processes()
    bots.start({ id: 'rem_1', botId: 'alpha', title: 'Preview server', command: `"${NODE}" server.cjs`, limitMs: 60_000, cwd: files, env: process.env })
    try {
      const fresh = () => { watchers = bots.processes(); return watchers }
      await until(() => /Local:/.test(fresh()[0]?.output ?? ''))
      const registry = new RunningRegistry(sources())
      const entries = await registry.list({ threadId: 'bot-home', folders: [files], botId: 'alpha' })
      expect(entries).toHaveLength(1)
      const printed = /http:\/\/localhost:\d+\//.exec(fresh()[0]!.output)![0]
      expect(entries[0]).toMatchObject({ label: 'Preview server', startedBy: { kind: 'bot', botId: 'alpha' }, addresses: [printed] })
      expect(runningNote(entries, { threadId: 'bot-home', botId: 'alpha', folder: files }, sources(), Date.now())).toContain(`Preview server (\`"${NODE}" server.cjs\`), started by you (watch_start)`)
      // Another bot working in its own folder is not told of it; a thread whose folder holds it is, as that bot's.
      expect(await registry.list({ threadId: 'bot-other', folders: [join(base, 'bots', 'files', 'beta')], botId: 'beta' })).toEqual([])
      const seen = await registry.list({ threadId: 't-agent', folders: [base] })
      expect(runningNote(seen, { threadId: 't-agent', folder: base }, sources(), Date.now())).toContain('started by bot "Alpha"')
    } finally {
      bots.close()
    }
  })
})

describe('reading the system\'s listings (output shapes of ps, lsof, ss, netstat and PowerShell; hand-authored)', () => {
  it('ps elapsed times', () => {
    const rows: Array<[string, number | undefined]> = [['05', undefined], ['00:07', 7], ['12:34', 754], ['01:00:00', 3600], ['2-03:04:05', 183_845], ['x', undefined]]
    for (const [text, seconds] of rows) expect(elapsedSeconds(text)).toBe(seconds)
  })

  it('ps rows, with the whole command line and when each started', () => {
    const now = 1_000_000_000
    const rows = parsePosixProcessTable('  501   1   501   501 01:00 /bin/zsh -l\n  777 501   777   501    00:05 node /work/app/node_modules/.bin/vite --port 5173\nnot a row\n', now)
    expect(rows).toEqual([
      { pid: 501, ppid: 1, pgid: 501, tpgid: 501, startedAt: now - 60_000, command: '/bin/zsh -l' },
      { pid: 777, ppid: 501, pgid: 777, tpgid: 501, startedAt: now - 5_000, command: 'node /work/app/node_modules/.bin/vite --port 5173' }
    ])
  })

  it('PowerShell\'s process rows', () => {
    expect(parseWindowsProcessTable('4120 900 1763300000000 "C:\\Program Files\\nodejs\\node.exe" server.js\r\n4 0 0 \r\n')).toEqual([
      { pid: 4120, ppid: 900, startedAt: 1_763_300_000_000, command: '"C:\\Program Files\\nodejs\\node.exe" server.js' },
      { pid: 4, ppid: 0, command: '' }
    ])
  })

  it('listening ports on macOS (lsof), Linux (ss) and Windows (netstat, whatever language it prints states in)', () => {
    expect(parseLsofListeners('p414\nf10\nn*:49171\nf11\nn[::1]:5173\np900\nf3\nn127.0.0.1:3000\n')).toEqual([
      { pid: 414, host: '*', port: 49171 }, { pid: 414, host: '::1', port: 5173 }, { pid: 900, host: '127.0.0.1', port: 3000 }
    ])
    expect(parseSsListeners([
      'LISTEN 0      511        127.0.0.1:5173      0.0.0.0:*    users:(("node",pid=1234,fd=23))',
      'LISTEN 0      4096   127.0.0.53%lo:53        0.0.0.0:*',
      'LISTEN 0      511             [::]:3000         [::]:*    users:(("node",pid=88,fd=20),("node",pid=89,fd=20))'
    ].join('\n'))).toEqual([
      { pid: 1234, host: '127.0.0.1', port: 5173 }, { pid: 88, host: '::', port: 3000 }, { pid: 89, host: '::', port: 3000 }
    ])
    expect(parseNetstatListeners([
      '  Proto  Lokale Adresse         Remoteadresse          Status           PID',
      '  TCP    0.0.0.0:5173           0.0.0.0:0              ABHÖREN          4120',
      '  TCP    127.0.0.1:5173         127.0.0.1:50000        HERGESTELLT      4120',
      '  TCP    [::1]:3000             [::]:0                 LISTENING        88',
      '  UDP    0.0.0.0:5353           *:*                                     77'
    ].join('\r\n'))).toEqual([{ pid: 4120, host: '0.0.0.0', port: 5173 }, { pid: 88, host: '::1', port: 3000 }])
  })

  it('working folders from lsof', () => {
    expect([...parseLsofCwds('p12\nfcwd\nn/Users/me/app\np13\nfcwd\nn/tmp/x y\n')]).toEqual([[12, '/Users/me/app'], [13, '/tmp/x y']])
  })
})

describe('what is told of each entry', () => {
  it('a terminal\'s running command: its foreground group on macOS and Linux, its first child on Windows', () => {
    const rows = [
      { pid: 10, ppid: 1, pgid: 10, tpgid: 20, command: '/bin/zsh' },
      // A prompt helper in its own group never counts.
      { pid: 11, ppid: 10, pgid: 11, tpgid: 20, command: 'gitstatusd' },
      { pid: 20, ppid: 10, pgid: 20, tpgid: 20, command: 'npm run dev' },
      { pid: 21, ppid: 20, pgid: 20, tpgid: 20, command: 'node vite' },
      { pid: 30, ppid: 1, pgid: 30, tpgid: 30, command: '/bin/zsh' },
      { pid: 31, ppid: 30, pgid: 31, tpgid: 30, command: 'gitstatusd' }
    ]
    const tree = processTree(rows)
    expect(foregroundJob(tree, 10, 'darwin')?.pid).toBe(20)
    expect(foregroundJob(tree, 30, 'linux')).toBeUndefined()
    const windows = processTree([
      { pid: 5, ppid: 1, command: 'powershell.exe' },
      { pid: 6, ppid: 5, command: '\\??\\C:\\Windows\\system32\\conhost.exe 0x4' },
      { pid: 7, ppid: 5, command: 'node.exe server.js' }
    ])
    expect(foregroundJob(windows, 5, 'win32')?.pid).toBe(7)
  })

  it('addresses: the ports it listens on, what it printed for one of them in its place; what it printed when no port could be read', () => {
    const own = [{ pid: 1, host: '127.0.0.1', port: 5173 }, { pid: 2, host: '::1', port: 5173 }, { pid: 2, host: '*', port: 24678 }]
    const printed = '\u001b[32m➜\u001b[39m  Local:   \u001b[36mhttp://localhost:\u001b[1m5173\u001b[22m/app/\u001b[39m\n'
    expect(addressesOf(own, own, 'Local: http://localhost:5173/app/\n')).toEqual(['http://localhost:5173/app/', 'http://localhost:24678'])
    // Colored the way Vite prints it: the port inside its own color codes.
    expect(addressesOf(own, own, printed)).toEqual(['http://localhost:5173/app/', 'http://localhost:24678'])
    // A printed address of a port nothing listens on is old output: not told.
    expect(addressesOf([], own, 'ready on http://127.0.0.1:9999')).toEqual([])
    // Ports could not be read: what it printed, with 0.0.0.0 as localhost.
    expect(addressesOf([], undefined, 'Listening on http://0.0.0.0:8000')).toEqual(['http://localhost:8000'])
  })

  it('a label that already holds its command is not followed by it again', () => {
    const entry = { id: 'watcher:w', label: 'Site server · node server.mjs', command: 'node server.mjs', pid: 1, startedBy: { kind: 'bot' as const, botId: 'alpha' }, addresses: [] }
    expect(runningLine(entry, { botId: 'alpha' }, { thread: () => undefined }, 0)).toBe('- Site server · node server.mjs, started by you (watch_start)')
  })

  it('nothing running: no note', () => {
    expect(runningNote([], { threadId: 't' }, { thread: () => undefined }, 0)).toBe('')
  })
})

describe('where working folders cannot be read (Windows)', () => {
  /** A registry on a Windows-shaped system that counts its process table reads. */
  function windowsRegistry(sources: Partial<RunningSources> = {}) {
    let reads = 0
    const registry = new RunningRegistry(
      { terminals: () => [], terminalOutput: () => '', watchers: () => [], thread: () => undefined, ...sources },
      {
        processes: async () => {
          reads++
          return [{ pid: 7, ppid: 5, command: 'node.exe server.js' }]
        },
        listeners: async () => [],
        workingFolders: async () => new Map(),
        selfPid: 1,
        now: () => 0,
        platform: 'win32'
      }
    )
    return { registry, reads: () => reads }
  }
  const scope = { threadId: 't-bot', folders: ['C:\bots\pip'], botId: 'pip' }

  it('nothing that could be listed for the scope: the list is empty without reading the process table', async () => {
    // A terminal of another thread in another folder, and an agent's command still in its call.
    const { registry, reads } = windowsRegistry({ terminals: () => [{ ptyId: 'p1', pid: 5, threadId: 't-far', cwd: 'C:\elsewhere' }] })
    registry.noteCommand({ threadId: 't-bot', callId: 'c1', command: 'node server.js', ended: false })
    expect(await registry.list(scope)).toEqual([])
    expect(reads()).toBe(0)
  })

  it.each([
    ['a terminal in its folder', (registry: RunningRegistry) => registry, { terminals: () => [{ ptyId: 'p1', pid: 5, threadId: '__unbound__', cwd: 'C:\bots\pip' }] }],
    ['an agent command of its thread that ended', (registry: RunningRegistry) => {
      registry.noteCommand({ threadId: 't-bot', callId: 'c1', command: 'node server.js', ended: true })
      return registry
    }, {}]
  ] as const)('%s: the process table is read', async (_name, prepare, sources) => {
    const { registry, reads } = windowsRegistry(sources)
    await prepare(registry).list(scope)
    expect(reads()).toBe(1)
  })
})
