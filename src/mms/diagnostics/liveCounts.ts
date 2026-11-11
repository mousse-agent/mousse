/**
 * Live resources the memory monitor counts and that have no registry of their own: file watchers, and the provider
 * and tool processes the service started. Only fixed kind names are kept, never a command line or a path.
 */
import type { FSWatcher } from 'node:fs'

let fileWatchers = 0

/** Counts `watcher` until it closes. Returns it, so a call site can wrap the `watch()` call. */
export function trackFileWatcher<T extends FSWatcher>(watcher: T): T {
  fileWatchers += 1
  let open = true
  watcher.once('close', () => {
    if (!open) return
    open = false
    fileWatchers -= 1
  })
  return watcher
}

export function liveFileWatchers(): number {
  return fileWatchers
}

const KNOWN_KINDS = ['claude', 'codex', 'cursor', 'gemini', 'opencode', 'copilot', 'qwen', 'goose', 'amp', 'pi']

/** A fixed kind for a provider command (`C:\\...\\claude.exe` is `claude`); anything unknown is `fallback`. */
export function childKindOf(command: string, fallback = 'provider'): string {
  const base = command.replace(/\\/g, '/').split('/').pop()?.toLowerCase().replace(/\.(exe|cmd|bat|js|mjs|cjs)$/, '') ?? ''
  return KNOWN_KINDS.find((kind) => base === kind || base.startsWith(`${kind}-`)) ?? fallback
}

const children = new Map<number, string>()

/**
 * Records a process the service started, by kind, until it exits. `child` may be a pid when only the pid is known
 * (the Claude SDK reports one); such a pid is dropped once the process is gone (`liveChildProcesses`).
 */
export function trackChildProcess(child: { pid?: number; once?: (event: 'exit', listener: () => void) => unknown } | number | undefined, kind: string): void {
  const pid = typeof child === 'number' ? child : child?.pid
  if (!pid || !Number.isInteger(pid)) return
  children.set(pid, kind)
  if (typeof child === 'object' && typeof child.once === 'function') {
    child.once('exit', () => {
      if (children.get(pid) === kind) children.delete(pid)
    })
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: it exists, but is not ours to signal.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Stops counting `pid` (its process ended). */
export function untrackChildProcess(pid: number): void {
  children.delete(pid)
}

/** The tracked processes still running, as `{ pid, kind }`. */
export function liveChildProcesses(): Array<{ pid: number; kind: string }> {
  const out: Array<{ pid: number; kind: string }> = []
  for (const [pid, kind] of children) {
    if (alive(pid)) out.push({ pid, kind })
    else children.delete(pid)
  }
  return out
}

/** Tests only. */
export function resetLiveCounts(): void {
  fileWatchers = 0
  children.clear()
}
