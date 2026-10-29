import { execFile } from 'node:child_process'
import { descendantsOf, killProcessTree, readProcessTable, readStartTime } from './processTree.mjs'

/**
 * Stop's last resort for the commands an agent runs (issue #417). A runtime ends the command it is
 * running when its turn is interrupted, but not always: Codex keeps a command it runs as a
 * background terminal after `turn/interrupt`, and a Claude Code process that does not exit leaves
 * its shells. Stop gives the runtime `STOP_GRACE_MS` to end them, then kills what is left with
 * everything it started.
 */

/** How long Stop gives a runtime to end a running command after interrupting it, before the command is killed. */
export const STOP_GRACE_MS = 1_500
/** After a kill, how long the killed processes may take to be gone before they count as survivors. */
export const STOP_SETTLE_MS = 1_000

/** One process with its parent and full command line. */
export interface ListedProcess {
  pid: number
  ppid: number
  command: string
}

const WINDOWS_LIST_SCRIPT = [
  '$OutputEncoding = [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false',
  "$ErrorActionPreference = 'Stop'",
  "Get-CimInstance -ClassName Win32_Process | ForEach-Object { '{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, ($_.CommandLine -replace '[\\r\\n]+', ' ') }"
].join('; ')

/** The command that lists every process as `pid ppid command line`, one per line. */
export function processListCommand(platform: NodeJS.Platform = process.platform): { file: string; args: string[] } {
  if (platform === 'win32') return { file: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_LIST_SCRIPT] }
  // `-ww`: the whole command line, however long.
  return { file: 'ps', args: ['-A', '-ww', '-o', 'pid=,ppid=,args='] }
}

/** The command that ends `pid` and everything below it on Windows. */
export function windowsTreeKillCommand(pid: number): { file: string; args: string[] } {
  return { file: 'taskkill', args: ['/PID', String(pid), '/T', '/F'] }
}

export function parseProcessList(stdout: string): ListedProcess[] {
  const listed: ListedProcess[] = []
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s?(.*)$/.exec(line)
    if (!match) continue
    listed.push({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3]!.trim() })
  }
  return listed
}

function run(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout: 15_000, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' }, (error, stdout) => {
      if (error) reject(error)
      else resolve(stdout)
    })
  })
}

/** Every process with its command line, read without blocking the daemon's loop; undefined when it cannot be read. */
export async function listProcesses(platform: NodeJS.Platform = process.platform): Promise<ListedProcess[] | undefined> {
  const { file, args } = processListCommand(platform)
  try {
    const listed = parseProcessList(await run(file, args))
    return listed.length ? listed : undefined
  } catch {
    return undefined
  }
}

/** Letters and digits only: a command compares the same however a shell, `ps` or Windows quoted and escaped it. */
function comparable(text: string): string {
  return text.replace(/[^\p{L}\p{N}]+/gu, '')
}

/** POSIX shell words of `text` (quotes and backslashes resolved), or undefined when it does not parse. */
function shellWords(text: string): string[] | undefined {
  const words: string[] = []
  let current = ''
  let started = false
  let quote: "'" | '"' | undefined
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!
    if (quote === "'") {
      if (char === "'") quote = undefined
      else current += char
      continue
    }
    if (quote === '"') {
      if (char === '"') quote = undefined
      else if (char === '\\' && index + 1 < text.length && '"\\$`'.includes(text[index + 1]!)) current += text[++index]
      else current += char
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      started = true
    } else if (char === '\\' && index + 1 < text.length) {
      current += text[++index]
      started = true
    } else if (/\s/.test(char)) {
      if (started) words.push(current)
      current = ''
      started = false
    } else {
      current += char
      started = true
    }
  }
  if (quote) return undefined
  if (started) words.push(current)
  return words
}

/**
 * The script of a command a runtime reported: Codex reports `/bin/zsh -lc 'npm run dev'`, and the
 * shell it starts may differ in its flags (`-c` for `-lc`), so only the script is compared. A command
 * that is not a shell's `-c` (or PowerShell's `-Command`) is compared whole.
 */
export function commandScript(command: string): string {
  const words = shellWords(command.trim())
  if (words && words.length >= 3 && /^(-[A-Za-z]*c|-Command)$/i.test(words[words.length - 2]!)) return words[words.length - 1]!
  return command
}

/**
 * The processes below `roots` that run one of `commands`: those whose command line ends with the
 * command's script. Only the topmost match of a branch is returned; killing its tree covers the rest.
 */
export function findCommandProcesses(listed: readonly ListedProcess[], roots: readonly number[], commands: readonly string[], self = process.pid): ListedProcess[] {
  const scripts = [...new Set(commands.map((command) => comparable(commandScript(command))).filter(Boolean))]
  if (!scripts.length) return []
  const children = new Map<number, ListedProcess[]>()
  for (const entry of listed) {
    if (entry.pid === entry.ppid) continue
    const list = children.get(entry.ppid) ?? []
    list.push(entry)
    children.set(entry.ppid, list)
  }
  const found: ListedProcess[] = []
  const seen = new Set<number>(roots)
  const queue = [...roots]
  while (queue.length) {
    for (const child of children.get(queue.shift()!) ?? []) {
      if (seen.has(child.pid) || child.pid === self) continue
      seen.add(child.pid)
      const line = comparable(child.command)
      if (scripts.some((script) => line.endsWith(script))) found.push(child)
      else queue.push(child.pid)
    }
  }
  return found
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref?.())

/** Waits up to `ms` for `done`, checking every 50 ms. */
async function until(done: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  for (;;) {
    if (done()) return true
    if (Date.now() >= deadline) return false
    await sleep(Math.min(50, Math.max(1, deadline - Date.now())))
  }
}

export interface TreeKillPorts {
  platform?: NodeJS.Platform
  /** Kills `pid` and everything it started (POSIX: across process groups; Windows: `taskkill /T /F`). */
  killTree?: (pid: number) => Promise<void> | void
  alive?: (pid: number) => boolean
  settleMs?: number
}

/** Kills `pid` and everything it started. Never throws: what survives is read afterwards. */
async function killTree(pid: number, platform: NodeJS.Platform = process.platform): Promise<void> {
  try {
    if (platform === 'win32') {
      const { file, args } = windowsTreeKillCommand(pid)
      await run(file, args)
    } else killProcessTree(pid, { platform })
  } catch {
    /* already gone, or not ours to end: the caller checks what is left */
  }
}

/**
 * Kills every process below `roots` that runs one of `commands`, with everything it started, and
 * returns those still running afterwards. Throws when the process list cannot be read.
 */
export async function stopCommandProcesses(
  roots: readonly number[],
  commands: readonly string[],
  ports: TreeKillPorts & { list?: () => Promise<ListedProcess[] | undefined> } = {}
): Promise<{ killed: ListedProcess[]; survivors: ListedProcess[] }> {
  const platform = ports.platform ?? process.platform
  const listed = await (ports.list ?? (() => listProcesses(platform)))()
  if (!listed) throw new Error('the running processes could not be listed')
  const killed = findCommandProcesses(listed, roots, commands)
  const isAlive = ports.alive ?? alive
  for (const entry of killed) await (ports.killTree ?? ((pid: number) => killTree(pid, platform)))(entry.pid)
  await until(() => killed.every((entry) => !isAlive(entry.pid)), ports.settleMs ?? STOP_SETTLE_MS)
  return { killed, survivors: killed.filter((entry) => isAlive(entry.pid)) }
}

/**
 * Ends the process `pid` a runtime was asked to close, if it has not ended by itself `graceMs` from
 * now: it and everything it started are killed. On POSIX the process groups below it are noted at
 * the call, so a command group the process left behind when it exited is killed too (its parent link
 * is gone by then). Resolves `ended` when nothing had to be killed, `killed` when everything was, and
 * `survived` when something is still running after the kill.
 */
export async function reapProcessTree(pid: number, options: TreeKillPorts & { graceMs?: number } = {}): Promise<'ended' | 'killed' | 'survived'> {
  const platform = options.platform ?? process.platform
  const isAlive = options.alive ?? alive
  /** POSIX: the groups below `pid` now (its own, when it leads one), with their leader's start time when the leader is one of them. */
  const groups = new Map<number, string | undefined>()
  if (platform !== 'win32' && isAlive(pid)) {
    const table = readProcessTable()
    const own = table?.find((entry) => entry.pid === process.pid)?.pgid
    const root = table?.find((entry) => entry.pid === pid)
    for (const entry of table ? [...(root ? [root] : []), ...descendantsOf(table, pid)] : []) {
      if (entry.pgid <= 1 || entry.pgid === own || groups.has(entry.pgid)) continue
      groups.set(entry.pgid, entry.pgid === entry.pid ? readStartTime(entry.pid) : undefined)
    }
  }
  // Cheap checks while waiting; the start times are read once, after the grace.
  await until(() => !isAlive(pid) && [...groups.keys()].every((pgid) => !groupAlive(pgid)), options.graceMs ?? STOP_GRACE_MS)
  // A group whose leader runs with another start time is someone else's now.
  const leftGroups = (): number[] =>
    [...groups].filter(([pgid, started]) => groupAlive(pgid) && (started === undefined || !isAlive(pgid) || readStartTime(pgid) === started)).map(([pgid]) => pgid)
  const rootLeft = isAlive(pid)
  const groupsLeft = platform === 'win32' ? [] : leftGroups()
  if (!rootLeft && groupsLeft.length === 0) return 'ended'
  if (rootLeft) await (options.killTree ?? ((target: number) => killTree(target, platform)))(pid)
  for (const pgid of groupsLeft) {
    try {
      process.kill(-pgid, 'SIGKILL')
    } catch {
      /* gone meanwhile */
    }
  }
  const gone = await until(() => !isAlive(pid) && (platform === 'win32' || groupsLeft.every((pgid) => !groupAlive(pgid))), options.settleMs ?? STOP_SETTLE_MS)
  return gone ? 'killed' : 'survived'
}
