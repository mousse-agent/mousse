import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { RuntimeFacts } from '../../shared/harness/types'
import { atomicWriteJsonSync } from '../data/AtomicFs'
import { instanceStateDir } from './instances'

/**
 * Runtime facts per instance, kept in memory and in `<stateDir>/runtime-facts.json`. Each stored
 * set has a revision that moves on whenever the facts change (not when only `capturedAt` does), so a binding can name the facts its
 * caps snapshot came from.
 */

interface FactsFile {
  version: 1
  revision: number
  facts?: RuntimeFacts
}

function decode(raw: unknown): FactsFile | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const value = raw as Record<string, unknown>
  const revision = typeof value.revision === 'number' && Number.isInteger(value.revision) && value.revision >= 0 ? value.revision : 0
  const facts = value.facts as RuntimeFacts | undefined
  const binary = facts?.binary as Partial<RuntimeFacts['binary']> | undefined
  const valid = facts && typeof facts === 'object' && typeof facts.instanceId === 'string' &&
    typeof facts.configRevision === 'number' && typeof facts.accountGeneration === 'number' &&
    binary && typeof binary.path === 'string' && typeof binary.size === 'number' && typeof binary.mtimeMs === 'number'
  return { version: 1, revision, ...(valid ? { facts } : {}) }
}

export class RuntimeFactsStore {
  private readonly cache = new Map<string, FactsFile>()

  constructor(private readonly profileHome: string) {}

  private path(instanceId: string): string {
    return join(instanceStateDir(this.profileHome, instanceId), 'runtime-facts.json')
  }

  private read(instanceId: string): FactsFile {
    const cached = this.cache.get(instanceId)
    if (cached) return cached
    let file: FactsFile = { version: 1, revision: 0 }
    try {
      file = decode(JSON.parse(readFileSync(this.path(instanceId), 'utf8'))) ?? file
    } catch {
      // Missing or unreadable: no facts yet.
    }
    this.cache.set(instanceId, file)
    return file
  }

  get(instanceId: string): RuntimeFacts | undefined {
    return this.read(instanceId).facts
  }

  /** The revision of the instance's current facts (0 before any). */
  revision(instanceId: string): number {
    return this.read(instanceId).revision
  }

  /** Stores new facts; true when they differ from the stored ones (the revision moves on). */
  set(instanceId: string, facts: RuntimeFacts): boolean {
    const current = this.read(instanceId)
    // When they were captured is not a change: a turn that learned nothing new keeps the revision.
    const same = (a: RuntimeFacts, b: RuntimeFacts) => JSON.stringify({ ...a, capturedAt: '' }) === JSON.stringify({ ...b, capturedAt: '' })
    if (current.facts && same(current.facts, facts)) return false
    this.write(instanceId, { version: 1, revision: current.revision + 1, facts })
    return true
  }

  /** Drops the facts (config, account or executable changed); the revision still moves on. */
  drop(instanceId: string): void {
    const current = this.read(instanceId)
    if (!current.facts) return
    this.write(instanceId, { version: 1, revision: current.revision + 1 })
  }

  /** The instance is gone; its directory goes with it. */
  forget(instanceId: string): void {
    this.cache.delete(instanceId)
    try {
      rmSync(this.path(instanceId), { force: true })
    } catch {
      /* the state directory is removed with the instance */
    }
  }

  private write(instanceId: string, file: FactsFile): void {
    this.cache.set(instanceId, file)
    try {
      atomicWriteJsonSync(this.path(instanceId), file)
    } catch (error) {
      console.warn('[harness] could not save runtime facts', { instanceId, error: error instanceof Error ? error.message : String(error) })
    }
  }
}
