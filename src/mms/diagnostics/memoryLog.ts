/**
 * The memory log: `<home>/diagnostics/memory.jsonl`, one JSON object per line, append only. It rotates at about
 * 1.5 MB and keeps three older files, and a rotated file older than a week is deleted, so it never holds more than
 * about 6 MB or more than a few days. Lines hold numbers and fixed names only (see `shared/diagnostics/memory.ts`).
 */
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { RotatingFileLog } from '../log/rotatingFileLog'
import { MEMORY_LOG_RELATIVE_PATH, type BreachKind, type MemoryBreach, type MemoryDetail, type MemorySample } from '../../shared/diagnostics/memory'

export const MEMORY_LOG_MAX_BYTES = 1_500_000
export const MEMORY_LOG_KEEP = 3
export const MEMORY_LOG_MAX_AGE_MS = 7 * 24 * 3_600_000

export type MemoryLogLine =
  | ({ type: 'sample' } & MemorySample)
  | { type: 'breach'; t: number; breaches: MemoryBreach[]; sample: MemorySample; detail: MemoryDetail }
  | { type: 'heap-snapshot'; t: number; kind: BreachKind; file: string; mb: number }
  | { type: 'start'; t: number; version: string; pid: number }

export function memoryLogPath(homeDir: string): string {
  return join(homeDir, MEMORY_LOG_RELATIVE_PATH)
}

/** The active file and its rotations, oldest first. */
export function memoryLogFiles(path: string): string[] {
  const files: string[] = []
  for (let i = MEMORY_LOG_KEEP + 2; i >= 1; i--) if (existsSync(`${path}.${i}`)) files.push(`${path}.${i}`)
  if (existsSync(path)) files.push(path)
  return files
}

/** Deletes rotated files last written more than `maxAgeMs` ago. The active file is kept. */
export function pruneMemoryLog(path: string, now = Date.now(), maxAgeMs = MEMORY_LOG_MAX_AGE_MS): number {
  let removed = 0
  const dir = dirname(path)
  const name = basename(path)
  let entries: string[] = []
  try { entries = readdirSync(dir) } catch { return 0 }
  for (const entry of entries) {
    if (!entry.startsWith(`${name}.`) || !/^\d+$/.test(entry.slice(name.length + 1))) continue
    const file = join(dir, entry)
    try {
      if (now - statSync(file).mtimeMs > maxAgeMs) {
        rmSync(file, { force: true })
        removed += 1
      }
    } catch {
      // Already gone.
    }
  }
  return removed
}

export class MemoryLog {
  readonly path: string
  private readonly file: RotatingFileLog

  constructor(homeDir: string, options: { maxBytes?: number; keep?: number; flushIntervalMs?: number } = {}) {
    this.path = memoryLogPath(homeDir)
    this.file = new RotatingFileLog({
      path: this.path,
      maxBytes: options.maxBytes ?? MEMORY_LOG_MAX_BYTES,
      keep: options.keep ?? MEMORY_LOG_KEEP,
      flushIntervalMs: options.flushIntervalMs ?? 1_000
    })
  }

  append(line: MemoryLogLine): void {
    this.file.write(JSON.stringify(line))
  }

  flush(): Promise<void> {
    return this.file.flush()
  }

  flushSync(): void {
    this.file.flushSync()
  }

  prune(now = Date.now()): number {
    return pruneMemoryLog(this.path, now)
  }
}

/** Every readable line of the log and its rotations, oldest first. A damaged line is skipped. */
export function readMemoryLog(path: string): MemoryLogLine[] {
  const lines: MemoryLogLine[] = []
  for (const file of memoryLogFiles(path)) {
    let text = ''
    try { text = readFileSync(file, 'utf8') } catch { continue }
    for (const raw of text.split('\n')) {
      if (!raw.trim()) continue
      try {
        const line = JSON.parse(raw) as MemoryLogLine
        if (line && typeof line === 'object' && typeof line.t === 'number' && typeof line.type === 'string') lines.push(line)
      } catch {
        // A line cut short by a crash.
      }
    }
  }
  return lines.sort((a, b) => a.t - b.t)
}

export function samplesOf(lines: MemoryLogLine[]): MemorySample[] {
  return lines.filter((line): line is { type: 'sample' } & MemorySample => line.type === 'sample').map(({ type: _type, ...sample }) => sample)
}
