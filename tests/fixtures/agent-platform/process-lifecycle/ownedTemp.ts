import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isOwnedPid, isOwnedPidAlive } from '../../../../src/mms/terminals/processLifecycle'

const fixtureDir = dirname(fileURLToPath(import.meta.url))
export const HEARTBEAT_CHILD_SCRIPT = join(fixtureDir, 'heartbeat-child.mjs')
const REMOVE_SCRIPT = join(fixtureDir, 'remove-owned-temp.ps1')

function assertAbsoluteUnderTemp(root: string, tmp: string): string {
  if (!isAbsolute(root) || !isAbsolute(tmp)) {
    throw new Error(`owned temp paths must be absolute: root=${root} tmp=${tmp}`)
  }
  const resolvedRoot = resolve(root)
  const resolvedTmp = resolve(tmp)
  const rel = relative(resolvedTmp, resolvedRoot)
  if (rel === '') throw new Error('owned temp root must be a unique subdirectory of temp')
  if (isAbsolute(rel) || rel.split(/[/\\]/).includes('..')) {
    throw new Error(`owned temp root escapes temp: root=${resolvedRoot} tmp=${resolvedTmp}`)
  }
  return resolvedRoot
}

export function makeLifecycleTempRoot(): string {
  const tmp = realpathSync.native(tmpdir())
  const root = mkdtempSync(join(tmp, 'mousse-process-lifecycle-'))
  return assertAbsoluteUnderTemp(root, tmp)
}

export function removeOwnedTempRoot(root: string): void {
  const tmp = realpathSync.native(tmpdir())
  const resolved = assertAbsoluteUnderTemp(resolve(root), tmp)
  if (process.platform === 'win32') {
    try {
      execFileSync(
        'powershell.exe',
        ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', REMOVE_SCRIPT, resolved, tmp],
        { timeout: 30_000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
      )
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      if (!existsSync(resolved)) return
      throw new Error(`PowerShell owned-temp cleanup failed for ${resolved}: ${detail}`)
    }
    if (!existsSync(resolved)) return
  }
  rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}

export function quoteForShell(value: string): string {
  if (process.platform === 'win32') return `'${value.replace(/'/g, "''")}'`
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export function nodeHeartbeatCommand(): string {
  return `& ${quoteForShell(process.execPath)} ${quoteForShell(HEARTBEAT_CHILD_SCRIPT)}`
}

export function posixNodeHeartbeatCommand(): string {
  return `${quoteForShell(process.execPath)} ${quoteForShell(HEARTBEAT_CHILD_SCRIPT)}`
}

export function heartbeatCommand(): string {
  return process.platform === 'win32' ? nodeHeartbeatCommand() : posixNodeHeartbeatCommand()
}

export function heartbeatPath(root: string, role: 'child' | 'grandchild'): string {
  return join(root, `${role}.heartbeat`)
}

export function pidPath(root: string, role: 'child' | 'grandchild' | 'grandchild.spawn'): string {
  return role === 'grandchild.spawn' ? join(root, 'grandchild.spawn-pid') : join(root, `${role}.pid`)
}

export function heartbeatLineCount(file: string): number {
  if (!existsSync(file)) return 0
  return readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean).length
}

export async function waitForHeartbeat(
  file: string,
  minLines = 2,
  timeoutMs = 12_000
): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (heartbeatLineCount(file) >= minLines) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`${file} did not reach ${minLines} heartbeat lines`)
}

export function readOwnedPidFile(file: string): number {
  if (!existsSync(file)) throw new Error(`missing pid file ${file}`)
  const parsed = Number(readFileSync(file, 'utf8').trim().split(/\s+/)[0])
  if (!isOwnedPid(parsed)) throw new Error(`invalid pid in ${file}`)
  if (parsed === process.pid) throw new Error(`pid file ${file} reused the test runner pid`)
  return parsed
}

export function expectPidGone(pid: number, label: string): void {
  if (isOwnedPidAlive(pid)) {
    throw new Error(`${label} pid ${pid} is still alive`)
  }
}

export async function waitUntilPidGone(
  pid: number,
  label: string,
  timeoutMs = 8_000
): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (!isOwnedPidAlive(pid)) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`${label} pid ${pid} is still alive after ${timeoutMs}ms`)
}
