import { spawn, type ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import {
  commandScript,
  findCommandProcesses,
  parseProcessList,
  processListCommand,
  reapProcessTree,
  stopCommandProcesses,
  windowsTreeKillCommand,
  type ListedProcess
} from '../../src/mms/harness/stopProcesses'

// Issue #417: what Stop does with a command an agent still runs after its interrupt.

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

const started: ChildProcess[] = []
afterEach(() => {
  for (const child of started.splice(0)) {
    try {
      if (child.pid) process.kill(-child.pid, 'SIGKILL')
    } catch {
      /* not a group */
    }
    child.kill('SIGKILL')
  }
})

/**
 * A stand-in for an agent process: it starts `/bin/sh -c <script>` in a process group of its own (as
 * Codex and Claude Code start their commands), prints the shell's pid, and stays up. With `stubborn`,
 * it ignores SIGTERM and the end of its input.
 */
async function agent(script: string, options: { stubborn?: boolean; detached?: boolean } = {}): Promise<{ child: ChildProcess; shell: number }> {
  const code = [
    "const { spawn } = require('node:child_process')",
    "const shell = spawn('/bin/sh', ['-c', process.argv[1]], { detached: true, stdio: 'ignore' })",
    'process.stdout.write(String(shell.pid) + "\\n")',
    options.stubborn ? "process.on('SIGTERM', () => {})" : '',
    'setInterval(() => {}, 1000)'
  ].join(';')
  const child = spawn(process.execPath, ['-e', code, script], { stdio: ['pipe', 'pipe', 'ignore'], detached: options.detached === true })
  started.push(child)
  const shell = await new Promise<number>((resolve, reject) => {
    child.stdout!.once('data', (chunk: Buffer) => resolve(Number(chunk.toString().trim())))
    child.once('error', reject)
  })
  started.push({ pid: shell, kill: () => true } as unknown as ChildProcess)
  return { child, shell }
}

describe('the commands Stop runs', () => {
  it('lists processes with ps on macOS and Linux, and with PowerShell on Windows', () => {
    expect(processListCommand('darwin')).toEqual({ file: 'ps', args: ['-A', '-ww', '-o', 'pid=,ppid=,args='] })
    expect(processListCommand('linux')).toEqual(processListCommand('darwin'))
    const windows = processListCommand('win32')
    expect(windows.file).toBe('powershell.exe')
    expect(windows.args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-Command'])
    expect(windows.args[3]).toContain('Get-CimInstance -ClassName Win32_Process')
    expect(windows.args[3]).toContain('$_.ProcessId, $_.ParentProcessId')
  })

  it('kills a Windows command with its whole tree, forcefully', () => {
    expect(windowsTreeKillCommand(4321)).toEqual({ file: 'taskkill', args: ['/PID', '4321', '/T', '/F'] })
  })

  it('parses the listing of either', () => {
    expect(parseProcessList('  10     1 /usr/bin/codex app-server\n  11    10 /bin/zsh -c sleep 300 ; echo done\r\n 12 11\nbad\n')).toEqual([
      { pid: 10, ppid: 1, command: '/usr/bin/codex app-server' },
      { pid: 11, ppid: 10, command: '/bin/zsh -c sleep 300 ; echo done' },
      { pid: 12, ppid: 11, command: '' }
    ])
  })
})

describe('finding a command among the processes', () => {
  it('compares only the script of a shell command', () => {
    expect(commandScript("/bin/zsh -lc 'sleep 237 ; echo done'")).toBe('sleep 237 ; echo done')
    expect(commandScript('/bin/bash -c "npm run dev -- --port \\"3000\\""')).toBe('npm run dev -- --port "3000"')
    expect(commandScript('powershell.exe -NoProfile -Command "Get-ChildItem"')).toBe('Get-ChildItem')
    expect(commandScript('npm test')).toBe('npm test')
    expect(commandScript("/bin/zsh -lc 'unterminated")).toBe("/bin/zsh -lc 'unterminated")
  })

  const listed: ListedProcess[] = [
    { pid: 1, ppid: 0, command: 'init' },
    { pid: 10, ppid: 1, command: 'codex app-server' },
    { pid: 11, ppid: 10, command: '/bin/zsh -c sleep 237 ; echo done' },
    { pid: 12, ppid: 11, command: 'sleep 237' },
    // An MCP server of the app-server, and the same command run by something else.
    { pid: 13, ppid: 10, command: 'npx -y some-mcp-server' },
    { pid: 20, ppid: 1, command: '/bin/zsh -c sleep 237 ; echo done' },
    // Windows: Codex runs PowerShell, which quotes the command line its own way.
    { pid: 30, ppid: 1, command: 'codex.exe app-server' },
    { pid: 31, ppid: 30, command: '"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -Command "npm run dev"' }
  ]

  it('finds the topmost process below the app-server that runs the script, and nothing else', () => {
    expect(findCommandProcesses(listed, [10], ["/bin/zsh -lc 'sleep 237 ; echo done'"]).map((entry) => entry.pid)).toEqual([11])
    expect(findCommandProcesses(listed, [10], ["/bin/zsh -lc 'npm test'"])).toEqual([])
    expect(findCommandProcesses(listed, [30], ['powershell.exe -Command "npm run dev"']).map((entry) => entry.pid)).toEqual([31])
    expect(findCommandProcesses(listed, [10], [''])).toEqual([])
  })

  it('finds a command below a wrapper the app-server runs under', () => {
    const wrapped: ListedProcess[] = [
      { pid: 5, ppid: 1, command: 'node /usr/lib/node_modules/@openai/codex/bin/codex.js app-server' },
      { pid: 10, ppid: 5, command: '/usr/lib/codex app-server' },
      { pid: 11, ppid: 10, command: '/usr/bin/sandbox-exec -p (policy) -- /bin/zsh -c npm run dev' },
      { pid: 12, ppid: 11, command: '/bin/zsh -c npm run dev' }
    ]
    expect(findCommandProcesses(wrapped, [5], ["/bin/zsh -lc 'npm run dev'"]).map((entry) => entry.pid)).toEqual([11])
  })
})

describe.skipIf(process.platform === 'win32')('stopping real processes', () => {
  it('kills a command that outlived its interrupt, with its children, and leaves the app-server running', async () => {
    const { child, shell } = await agent('sleep 300 ; echo done')
    await expect.poll(() => alive(shell)).toBe(true)
    const result = await stopCommandProcesses([child.pid!], ["/bin/zsh -lc 'sleep 300 ; echo done'"])
    expect(result.killed.map((entry) => entry.pid)).toEqual([shell])
    expect(result.survivors).toEqual([])
    expect(alive(shell)).toBe(false)
    expect(alive(child.pid!)).toBe(true)
  })

  it('says which command survived a kill that did nothing', async () => {
    const { child, shell } = await agent('sleep 300 ; echo stuck')
    const result = await stopCommandProcesses([child.pid!], ["sh -c 'sleep 300 ; echo stuck'"], { killTree: () => undefined, settleMs: 100 })
    expect(result.survivors.map((entry) => entry.pid)).toEqual([shell])
    expect(alive(shell)).toBe(true)
  })

  it('kills an agent that does not exit after it was closed, and the command group it started', async () => {
    const { child, shell } = await agent('sleep 300', { stubborn: true })
    child.stdin!.end()
    child.kill('SIGTERM')
    const startedAt = Date.now()
    expect(await reapProcessTree(child.pid!, { graceMs: 300 })).toBe('killed')
    expect(Date.now() - startedAt).toBeLessThan(3_000)
    await expect.poll(() => alive(child.pid!)).toBe(false)
    expect(alive(shell)).toBe(false)
  })

  it('kills the command group an agent left behind when it exited by itself', async () => {
    const { child, shell } = await agent('sleep 300')
    const reaped = reapProcessTree(child.pid!, { graceMs: 300 })
    // The agent exits at once; the shell it put in its own group is still running.
    child.kill('SIGKILL')
    expect(await reaped).toBe('killed')
    expect(alive(shell)).toBe(false)
  })

  it('kills nothing when the agent and its commands ended by themselves', async () => {
    const { child, shell } = await agent('exit 0')
    await expect.poll(() => alive(shell)).toBe(false)
    const reaped = reapProcessTree(child.pid!, { graceMs: 2_000 })
    child.kill('SIGTERM')
    expect(await reaped).toBe('ended')
  })
})
