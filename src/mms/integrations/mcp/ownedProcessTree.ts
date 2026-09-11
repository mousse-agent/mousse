import { spawn, type ChildProcess } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'

export const MAX_OWNED_MCP_TREE_WALK = 256

export interface OwnedProcessIdentity {
  pid: number
  /** Linux starttime or Windows CreationDate. Compared to avoid PID-reuse kills. */
  startKey: string
}

export class McpProcessTreeError extends Error {
  readonly code = 'mcp_tree_unsupported' as const

  constructor(message: string) {
    super(message)
    this.name = 'McpProcessTreeError'
  }
}

export function isOwnedPid(pid: unknown): pid is number {
  return typeof pid === 'number' && Number.isInteger(pid) && pid > 0 && pid !== process.pid
}

export function supportsOwnedMcpTree(platform = process.platform): boolean {
  return platform === 'win32' || platform === 'linux'
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function readLinuxStartKey(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const close = stat.lastIndexOf(')')
    if (close < 0) return undefined
    const rest = stat.slice(close + 2).trim().split(/\s+/)
    return rest[19]
  } catch {
    return undefined
  }
}

export function listLinuxDirectChildPids(pid: number): number[] {
  if (!isOwnedPid(pid)) return []
  const found = new Set<number>()
  try {
    for (const tid of readdirSync(`/proc/${pid}/task`)) {
      try {
        const raw = readFileSync(`/proc/${pid}/task/${tid}/children`, 'utf8')
        for (const part of raw.trim().split(/\s+/)) {
          if (!part) continue
          const child = Number(part)
          if (isOwnedPid(child)) found.add(child)
        }
      } catch {
        /* task disappeared */
      }
    }
  } catch {
    /* pid already gone */
  }
  return [...found]
}

function parseWindowsCreationLines(stdout: string): OwnedProcessIdentity[] {
  const identities: OwnedProcessIdentity[] = []
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.replace(/\u0000/g, '').trim()
    if (!trimmed) continue
    const match = trimmed.match(/(\d+)\s+(\S+)/)
    if (!match) continue
    const pid = Number(match[1])
    if (!isOwnedPid(pid)) continue
    identities.push({ pid, startKey: match[2] })
  }
  return identities
}

function decodeCaptured(buffer: Buffer): string {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.subarray(2).toString('utf16le')
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    return buffer.subarray(2).swap16().toString('utf16le')
  }
  if (buffer.includes(0) && buffer.length > 2) {
    return buffer.toString('utf16le').replace(/\u0000/g, '')
  }
  return buffer.toString('utf8')
}

function runCaptured(command: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout?.on('data', (chunk) => stdout.push(Buffer.from(chunk)))
    child.stderr?.on('data', (chunk) => stderr.push(Buffer.from(chunk)))
    child.once('error', reject)
    child.once('exit', (code) => {
      resolve({
        code,
        stdout: decodeCaptured(Buffer.concat(stdout)),
        stderr: decodeCaptured(Buffer.concat(stderr))
      })
    })
  })
}

const POWERSHELL_UTF8 = '$OutputEncoding = [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false'

async function listWindowsDirectChildren(pid: number): Promise<OwnedProcessIdentity[]> {
  const script = [
    POWERSHELL_UTF8,
    `$ErrorActionPreference = 'Stop'`,
    `Get-CimInstance -ClassName Win32_Process -Filter "ParentProcessId=${pid}" | ForEach-Object { '{0} {1}' -f $_.ProcessId, $_.CreationDate }`
  ].join('; ')
  const result = await runCaptured('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script])
  if (result.code !== 0) {
    throw new McpProcessTreeError(
      `Failed to enumerate owned MCP descendants for PID ${pid}: ${result.stderr.trim() || `exit ${result.code}`}`
    )
  }
  return parseWindowsCreationLines(result.stdout)
}

async function readWindowsStartKey(pid: number): Promise<string | undefined> {
  const script = [
    POWERSHELL_UTF8,
    `$ErrorActionPreference = 'Stop'`,
    `$p = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId=${pid}"`,
    `if ($p) { '{0} {1}' -f $p.ProcessId, $p.CreationDate }`
  ].join('; ')
  const result = await runCaptured('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script])
  if (result.code !== 0) return undefined
  return parseWindowsCreationLines(result.stdout)[0]?.startKey
}

export async function readOwnedStartKey(pid: number): Promise<string | undefined> {
  if (!isOwnedPid(pid)) return undefined
  if (process.platform === 'linux') return readLinuxStartKey(pid)
  if (process.platform === 'win32') return readWindowsStartKey(pid)
  throw new McpProcessTreeError(`Owned MCP descendant termination is unsupported on ${process.platform}`)
}

export async function listDirectOwnedChildren(pid: number): Promise<OwnedProcessIdentity[]> {
  if (!isOwnedPid(pid)) return []
  if (process.platform === 'linux') {
    const children: OwnedProcessIdentity[] = []
    for (const child of listLinuxDirectChildPids(pid)) {
      const startKey = readLinuxStartKey(child)
      if (startKey) children.push({ pid: child, startKey })
    }
    return children
  }
  if (process.platform === 'win32') return listWindowsDirectChildren(pid)
  throw new McpProcessTreeError(`Owned MCP descendant termination is unsupported on ${process.platform}`)
}

export async function snapshotOwnedProcessTree(rootPid: number): Promise<OwnedProcessIdentity[]> {
  if (!supportsOwnedMcpTree()) {
    throw new McpProcessTreeError(`Owned MCP descendant termination is unsupported on ${process.platform}`)
  }
  const ordered: OwnedProcessIdentity[] = []
  const seen = new Set<number>([rootPid, process.pid])
  const queue = [rootPid]
  while (queue.length > 0 && ordered.length < MAX_OWNED_MCP_TREE_WALK) {
    const current = queue.shift()!
    for (const child of await listDirectOwnedChildren(current)) {
      if (seen.has(child.pid)) continue
      seen.add(child.pid)
      ordered.push(child)
      queue.push(child.pid)
    }
  }
  if (queue.length > 0 || ordered.length > MAX_OWNED_MCP_TREE_WALK) {
    throw new McpProcessTreeError(
      `Owned MCP process tree exceeds the ${MAX_OWNED_MCP_TREE_WALK}-process safety limit`
    )
  }
  return ordered
}

function mergeIdentities(
  current: OwnedProcessIdentity[],
  extra: OwnedProcessIdentity[]
): OwnedProcessIdentity[] {
  const byPid = new Map<number, OwnedProcessIdentity>()
  for (const identity of [...current, ...extra]) {
    if (!byPid.has(identity.pid)) byPid.set(identity.pid, identity)
  }
  return [...byPid.values()]
}

export async function isOwnedIdentityAlive(identity: OwnedProcessIdentity): Promise<boolean> {
  if (!isOwnedPid(identity.pid)) return false
  const current = await readOwnedStartKey(identity.pid)
  return current !== undefined && current === identity.startKey
}

async function awaitedWindowsTaskkill(pid: number): Promise<void> {
  const result = await runCaptured('taskkill', ['/PID', String(pid), '/T', '/F'])
  if (result.code === 0 || result.code === 128) return
  const stderr = result.stderr.trim()
  if (/not found/i.test(stderr)) return
  throw new Error(`taskkill /PID ${pid} /T exited ${result.code ?? 'unknown'}${stderr ? `: ${stderr}` : ''}`)
}

function posixSignal(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal)
  } catch {
    /* ESRCH / EPERM */
  }
}

export async function waitForOwnedIdentitiesGone(
  identities: OwnedProcessIdentity[],
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + Math.max(1, timeoutMs)
  while (Date.now() < deadline) {
    const live: OwnedProcessIdentity[] = []
    for (const identity of identities) {
      if (await isOwnedIdentityAlive(identity)) live.push(identity)
    }
    if (live.length === 0) return
    await sleep(50)
  }
  const remaining: number[] = []
  for (const identity of identities) {
    if (await isOwnedIdentityAlive(identity)) remaining.push(identity.pid)
  }
  if (remaining.length > 0) {
    throw new Error(`Owned MCP descendants still live after drain: ${remaining.join(', ')}`)
  }
}

function waitForHandleExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off('exit', onExit)
      reject(new Error(`Owned MCP stdio process ${child.pid ?? 'unknown'} did not exit before close deadline`))
    }, Math.max(1, timeoutMs))
    const onExit = (): void => {
      clearTimeout(timer)
      resolve()
    }
    child.once('exit', onExit)
  })
}

/**
 * Terminate one exact spawned stdio child and its snapshotted descendants.
 * Never signals a PID after that ChildProcess handle has exited.
 */
export async function terminateOwnedStdioTree(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error('Invalid MCP stdio close timeout')
  }
  const startedAt = Date.now()
  const remaining = (): number => Math.max(1, timeoutMs - (Date.now() - startedAt))
  const pid = child.pid
  const alreadyExited = child.exitCode !== null || child.signalCode !== null

  if (!alreadyExited && !isOwnedPid(pid)) {
    await waitForHandleExit(child, remaining())
    return
  }

  let descendants: OwnedProcessIdentity[] = []
  if (!alreadyExited && isOwnedPid(pid)) {
    descendants = await snapshotOwnedProcessTree(pid)
  }

  if (!alreadyExited) {
    try {
      child.kill('SIGTERM')
    } catch {
      /* already gone */
    }
    const gracefulMs = Math.min(2_000, remaining())
    const gracefulDeadline = Date.now() + gracefulMs
    while (Date.now() < gracefulDeadline && child.exitCode === null && child.signalCode === null) {
      await sleep(50)
    }
  }

  const handleStillLive = child.exitCode === null && child.signalCode === null
  if (handleStillLive && isOwnedPid(pid)) {
    descendants = mergeIdentities(descendants, await snapshotOwnedProcessTree(pid))
  }

  if (handleStillLive) {
    if (!isOwnedPid(pid)) {
      throw new Error('Owned MCP stdio process lost its spawned identity while still live')
    }
    if (!supportsOwnedMcpTree()) {
      throw new McpProcessTreeError(`Owned MCP descendant termination is unsupported on ${process.platform}`)
    }
    if (process.platform === 'win32') {
      await awaitedWindowsTaskkill(pid)
    } else if (process.platform === 'linux') {
      posixSignal(pid, 'SIGKILL')
      for (const descendant of descendants) {
        if (await isOwnedIdentityAlive(descendant)) posixSignal(descendant.pid, 'SIGKILL')
      }
    } else {
      throw new McpProcessTreeError(`Owned MCP descendant termination is unsupported on ${process.platform}`)
    }
  } else if (descendants.length > 0) {
    if (!supportsOwnedMcpTree()) {
      throw new McpProcessTreeError(`Owned MCP descendant termination is unsupported on ${process.platform}`)
    }
    if (process.platform === 'linux') {
      for (const descendant of descendants) {
        if (await isOwnedIdentityAlive(descendant)) posixSignal(descendant.pid, 'SIGKILL')
      }
    } else if (process.platform === 'win32') {
      for (const descendant of descendants) {
        if (!(await isOwnedIdentityAlive(descendant))) continue
        await awaitedWindowsTaskkill(descendant.pid)
      }
    } else {
      throw new McpProcessTreeError(`Owned MCP descendant termination is unsupported on ${process.platform}`)
    }
  }

  await waitForHandleExit(child, remaining())
  await waitForOwnedIdentitiesGone(descendants, remaining())
}
