import { spawn } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'

export const MAX_OWNED_BROWSER_TREE_WALK = 256
export const DEFAULT_OWNED_PROCESS_STOP_TIMEOUT_MS = 8_000

export type OwnedTreeSignal = 'term' | 'kill'

export const DETACHED_GRANDCHILD_LIMIT =
  'Managed Chromium cannot recover a hostile detached grandchild after the launched parent handle has exited; numeric PIDs are never retargeted after that identity is gone.'

export interface OwnedProcessIdentity {
  pid: number
  creation?: string
  executablePath?: string
}

export interface OwnedProcessTree {
  root: OwnedProcessIdentity
  descendants: OwnedProcessIdentity[]
  capturedAt: string
  truncated: boolean
  platform: NodeJS.Platform
  parentHandleAlive: boolean
  inventoryError?: string
}

export class OwnedProcessStopError extends Error {
  readonly code = 'owned_process_stop_failed' as const

  constructor(
    message: string,
    readonly pid: number,
    readonly remaining: OwnedProcessIdentity[] = [],
    readonly limit?: string
  ) {
    super(message)
    this.name = 'OwnedProcessStopError'
  }
}

export function isOwnedPid(pid: unknown): pid is number {
  return typeof pid === 'number' && Number.isInteger(pid) && pid > 0
}

export function isOwnedPidAlive(pid: number): boolean {
  if (!isOwnedPid(pid) || pid === process.pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code) : ''
    return code === 'EPERM'
  }
}

export function windowsTaskkillArgs(pid: number, mode: OwnedTreeSignal): string[] {
  const args = ['/PID', String(pid), '/T']
  if (mode === 'kill') args.push('/F')
  return args
}

export function rootOnlyTree(pid: number, options: { parentHandleAlive?: boolean; executablePath?: string } = {}): OwnedProcessTree {
  return {
    root: { pid, ...(options.executablePath ? { executablePath: options.executablePath } : {}) },
    descendants: [],
    capturedAt: new Date().toISOString(),
    truncated: false,
    platform: process.platform,
    parentHandleAlive: options.parentHandleAlive !== false && isOwnedPidAlive(pid)
  }
}

let injectedStopFailure: { error: Error; once: boolean } | null = null

/** Test-only: fail the next owned stop without signaling so a live Chrome retains its lock. */
export function injectOwnedStopFailureForTests(error: Error | null, once = true): void {
  injectedStopFailure = error ? { error, once } : null
}

export function consumeInjectedStopFailureForTests(): Error | null {
  if (!injectedStopFailure) return null
  const failure = injectedStopFailure.error
  if (injectedStopFailure.once) injectedStopFailure = null
  return failure
}

export async function captureOwnedProcessTree(
  rootPid: number,
  options: { parentHandleAlive?: boolean; executablePath?: string } = {}
): Promise<OwnedProcessTree> {
  const capturedAt = new Date().toISOString()
  const parentHandleAlive = options.parentHandleAlive !== false && isOwnedPidAlive(rootPid)
  const root: OwnedProcessIdentity = {
    pid: rootPid,
    ...(options.executablePath ? { executablePath: options.executablePath } : {})
  }
  if (!isOwnedPid(rootPid) || rootPid === process.pid) {
    return {
      root,
      descendants: [],
      capturedAt,
      truncated: false,
      platform: process.platform,
      parentHandleAlive: false,
      inventoryError: 'Refusing to inventory the current process or an invalid PID'
    }
  }
  try {
    const descendants = await listDescendants(rootPid)
    return {
      root,
      descendants: descendants.slice(0, MAX_OWNED_BROWSER_TREE_WALK),
      capturedAt,
      truncated: descendants.length > MAX_OWNED_BROWSER_TREE_WALK,
      platform: process.platform,
      parentHandleAlive,
      ...(descendants.length > MAX_OWNED_BROWSER_TREE_WALK
        ? { inventoryError: `Owned descendant inventory exceeded ${MAX_OWNED_BROWSER_TREE_WALK} processes` }
        : {})
    }
  } catch (error) {
    return {
      root,
      descendants: [],
      capturedAt,
      truncated: false,
      platform: process.platform,
      parentHandleAlive,
      inventoryError: error instanceof Error ? error.message : String(error)
    }
  }
}

export function mergeOwnedProcessTrees(base: OwnedProcessTree | null, next: OwnedProcessTree): OwnedProcessTree {
  if (!base) return next
  const byPid = new Map<number, OwnedProcessIdentity>()
  for (const item of [...base.descendants, ...next.descendants]) byPid.set(item.pid, { ...byPid.get(item.pid), ...item })
  byPid.delete(next.root.pid)
  byPid.delete(base.root.pid)
  return {
    root: { ...base.root, ...next.root },
    descendants: [...byPid.values()],
    capturedAt: next.capturedAt,
    truncated: base.truncated || next.truncated,
    platform: next.platform,
    parentHandleAlive: next.parentHandleAlive,
    ...(next.inventoryError || base.inventoryError
      ? { inventoryError: next.inventoryError ?? base.inventoryError }
      : {})
  }
}

export async function stopOwnedProcessTree(
  tree: OwnedProcessTree,
  timeoutMs = DEFAULT_OWNED_PROCESS_STOP_TIMEOUT_MS
): Promise<void> {
  const rootPid = tree.root.pid
  if (!isOwnedPid(rootPid) || rootPid === process.pid) {
    throw new OwnedProcessStopError('Refusing to stop an invalid or self PID', rootPid)
  }
  if (tree.truncated) {
    throw new OwnedProcessStopError(
      tree.inventoryError ?? `Owned descendant inventory exceeded ${MAX_OWNED_BROWSER_TREE_WALK} processes`,
      rootPid,
      [tree.root, ...tree.descendants]
    )
  }

  const parentAliveAtStop = isOwnedPidAlive(rootPid)
  if (!parentAliveAtStop && !tree.parentHandleAlive) {
    const remaining = remainingAlive(tree)
    if (remaining.length === 0) return
    throw new OwnedProcessStopError(
      `${DETACHED_GRANDCHILD_LIMIT} Remaining owned PIDs: ${remaining.map((item) => item.pid).join(', ')}`,
      rootPid,
      remaining,
      DETACHED_GRANDCHILD_LIMIT
    )
  }

  const deadline = Date.now() + Math.max(250, timeoutMs)
  const gracefulDeadline = Math.min(deadline, Date.now() + Math.max(100, Math.min(2_000, Math.floor(timeoutMs / 2))))
  if (parentAliveAtStop) {
    // Windows taskkill without /F may report that Chromium refused graceful
    // termination. That is a reason to escalate, not to abandon the owned tree.
    try { await signalOwnedTree(rootPid, 'term') } catch { /* force below if still alive */ }
    await waitUntil(gracefulDeadline, () => remainingAlive(tree).length === 0)
  }
  let remaining = remainingAlive(tree)
  if (remaining.length > 0 && Date.now() < deadline && isOwnedPidAlive(rootPid)) {
    await signalOwnedTree(rootPid, 'kill')
    await waitUntil(deadline, () => remainingAlive(tree).length === 0)
    remaining = remainingAlive(tree)
  }
  if (remaining.length > 0) {
    throw new OwnedProcessStopError(
      `Owned Chromium tree did not exit (root ${rootPid}; remaining ${remaining.map((item) => item.pid).join(', ')})`,
      rootPid,
      remaining
    )
  }
}

function remainingAlive(tree: OwnedProcessTree): OwnedProcessIdentity[] {
  return [tree.root, ...tree.descendants].filter((item) => isOwnedPidAlive(item.pid))
}

async function signalOwnedTree(pid: number, mode: OwnedTreeSignal): Promise<void> {
  if (!isOwnedPid(pid) || pid === process.pid) return
  if (process.platform === 'win32') {
    await runTaskkill(pid, mode)
    return
  }
  try { process.kill(pid, mode === 'kill' ? 'SIGKILL' : 'SIGTERM') } catch { /* ESRCH / EPERM */ }
}

async function runTaskkill(pid: number, mode: OwnedTreeSignal): Promise<void> {
  const args = windowsTaskkillArgs(pid, mode)
  await new Promise<void>((resolve, reject) => {
    const child = spawn('taskkill', args, { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'] })
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* ignore */ }
      if (isOwnedPidAlive(pid)) reject(new Error(`taskkill timed out for owned PID ${pid}`))
      else resolve()
    }, 5_000)
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', async (code) => {
      clearTimeout(timer)
      if (code === 0 || code === 128 || !isOwnedPidAlive(pid)) return resolve()
      // taskkill can report a nonzero exit while the targeted tree is already
      // terminating. Prove exit for a bounded interval before treating it as a
      // retained-owner failure.
      try {
        await waitUntil(Date.now() + 1_000, () => !isOwnedPidAlive(pid))
        if (!isOwnedPidAlive(pid)) resolve()
        else reject(new Error(`taskkill exited with code ${code ?? 'unknown'} for owned PID ${pid}`))
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  })
}

async function listDescendants(rootPid: number): Promise<OwnedProcessIdentity[]> {
  if (process.platform === 'win32') return listWindowsDescendants(rootPid)
  if (process.platform === 'linux') return listLinuxDescendants(rootPid)
  if (process.platform === 'darwin') return listDarwinDescendants(rootPid)
  throw new Error(`Owned descendant inventory is unsupported on ${process.platform}`)
}

async function listWindowsDescendants(rootPid: number): Promise<OwnedProcessIdentity[]> {
  const script = [
    `$ErrorActionPreference = 'SilentlyContinue'`,
    `$root = ${rootPid}`,
    `$seen = New-Object 'System.Collections.Generic.HashSet[int]'`,
    `[void]$seen.Add($root)`,
    `$queue = New-Object System.Collections.Queue`,
    `$queue.Enqueue($root)`,
    `$n = 0`,
    `while ($queue.Count -gt 0 -and $n -lt ${MAX_OWNED_BROWSER_TREE_WALK}) {`,
    `  $current = [int]$queue.Dequeue()`,
    `  foreach ($child in (Get-CimInstance Win32_Process -Filter "ParentProcessId=$current")) {`,
    `    if ($seen.Add([int]$child.ProcessId)) {`,
    `      $queue.Enqueue([int]$child.ProcessId)`,
    `      $n++`,
    `      '{0}|{1}|{2}' -f $child.ProcessId, $child.CreationDate, (($child.ExecutablePath -replace '[\\r\\n\\|]', ' '))`,
    `    }`,
    `  }`,
    `}`
  ].join('; ')
  const stdout = await spawnUtf8('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script
  ], 3_000)
  const descendants: OwnedProcessIdentity[] = []
  for (const line of stdout.split(/\r?\n/)) {
    const [pidRaw, creation, ...rest] = line.split('|')
    const pid = Number(pidRaw)
    if (!isOwnedPid(pid) || pid === rootPid || pid === process.pid) continue
    descendants.push({
      pid,
      ...(creation?.trim() ? { creation: creation.trim() } : {}),
      ...(rest.join('|').trim() ? { executablePath: rest.join('|').trim() } : {})
    })
  }
  return descendants
}

function listLinuxDescendants(rootPid: number): OwnedProcessIdentity[] {
  const descendants: OwnedProcessIdentity[] = []
  const seen = new Set<number>([rootPid, process.pid])
  const queue = [rootPid]
  while (queue.length && descendants.length < MAX_OWNED_BROWSER_TREE_WALK) {
    const current = queue.shift()!
    try {
      for (const tid of readdirSync(`/proc/${current}/task`)) {
        try {
          const raw = readFileSync(`/proc/${current}/task/${tid}/children`, 'utf8')
          for (const part of raw.trim().split(/\s+/)) {
            const child = Number(part)
            if (!isOwnedPid(child) || seen.has(child)) continue
            seen.add(child)
            let executablePath: string | undefined
            let creation: string | undefined
            try {
              const stat = readFileSync(`/proc/${child}/stat`, 'utf8')
              const close = stat.indexOf(')')
              const rest = close >= 0 ? stat.slice(close + 2).split(/\s+/) : []
              creation = rest[19]
              executablePath = readFileSync(`/proc/${child}/cmdline`, 'utf8').split('\0')[0] || undefined
            } catch { /* ignore */ }
            descendants.push({ pid: child, ...(creation ? { creation } : {}), ...(executablePath ? { executablePath } : {}) })
            queue.push(child)
          }
        } catch { /* task gone */ }
      }
    } catch { /* pid gone */ }
  }
  return descendants
}

async function listDarwinDescendants(rootPid: number): Promise<OwnedProcessIdentity[]> {
  const descendants: OwnedProcessIdentity[] = []
  const seen = new Set<number>([rootPid, process.pid])
  const queue = [rootPid]
  while (queue.length && descendants.length < MAX_OWNED_BROWSER_TREE_WALK) {
    const current = queue.shift()!
    const stdout = await spawnUtf8('pgrep', ['-P', String(current)], 2_000).catch(() => '')
    for (const line of stdout.split(/\r?\n/)) {
      const child = Number(line.trim())
      if (!isOwnedPid(child) || seen.has(child)) continue
      seen.add(child)
      descendants.push({ pid: child })
      queue.push(child)
    }
  }
  return descendants
}

function spawnUtf8(file: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* ignore */ }
      if (process.platform === 'win32' && child.pid) {
        spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      }
      reject(new Error(`${file} inventory timed out after ${timeoutMs}ms: ${stderr}`))
    }, timeoutMs)
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      if (code === 0 || stdout) resolve(stdout)
      else reject(new Error(`${file} exited ${code ?? 'unknown'}: ${stderr}`))
    })
  })
}

async function waitUntil(deadline: number, done: () => boolean | Promise<boolean>): Promise<void> {
  while (Date.now() < deadline) {
    if (await done()) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}
