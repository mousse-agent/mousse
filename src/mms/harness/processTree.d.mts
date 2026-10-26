import type { spawnSync } from 'node:child_process'

export interface ProcessEntry {
  pid: number
  ppid: number
  pgid: number
}

export function readProcessTable(run?: typeof spawnSync): ProcessEntry[] | undefined

export function descendantsOf(table: readonly ProcessEntry[], root: number): ProcessEntry[]

export function killProcessTree(pid: number | undefined, options?: {
  platform?: NodeJS.Platform
  run?: typeof spawnSync
  kill?: (target: number, signal: NodeJS.Signals) => void
  table?: () => ProcessEntry[] | undefined
  /** Mousse's own pid: its group is never signalled. */
  self?: number
}): void
