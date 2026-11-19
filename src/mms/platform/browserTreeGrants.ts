import { randomUUID } from 'node:crypto'
import type { RunEngine } from '../run/RunEngine'
import { TERMINAL_RUN_STATUSES, type DelegationStatus, type RunStatus } from '../run/types'

/**
 * Browser grants for person-started task trees (docs/plans/tool-api.md §2.6 "The grant"). A grant belongs to a tree,
 * not to a source label: a person's run (`gui`, `cli`) roots it, and it covers that run and every run caused by it — its
 * subagents' runs at any depth, the wakes that deliver their results, and the continuations of its runs (the timer's
 * resume after a usage limit, Resume now, a runtime's own continuation). A schedule, a webhook, a remote origin or
 * another agent's message starts none and joins none, and neither does a run caused by one of those, even on a thread
 * whose tree holds a live grant.
 *
 * A run joins only by its cause, and a cause can only start a run while the tree still has work (a running parent, a
 * paused run, an unacknowledged result), so a run that joins finds the grant alive. The grant lives until the tree has
 * no run that has not ended and no result still to deliver; Stop ends it that way. A person's later run on the same
 * root then starts a new grant.
 *
 * Grants live in memory: after a restart a tree's later runs find none, and the person's next run starts a new one.
 */

/** Sources whose run a person started: the only ones that root a grant. */
const ROOT_SOURCES: ReadonlySet<string> = new Set(['gui', 'cli'])
/** Sources that carry on an earlier run (`RunOutcome.continuationOf`): they join that run's grant. */
const CONTINUATION_SOURCES: ReadonlySet<string> = new Set(['resume', 'resume_now', 'provider-continuation'])
/** Delegations whose child still runs or whose result is not yet delivered. */
const OPEN_DELEGATIONS: ReadonlySet<DelegationStatus> = new Set<DelegationStatus>(['running', 'result_available'])
/** Cause chains deeper than this are treated as no cause, which only ever grants less. */
const MAX_DEPTH = 64

/** What the grants read of the run engine. */
export interface BrowserTreeFacts {
  run(runId: string): { threadId: string; source: string; status: RunStatus; continuationOf?: string } | undefined
  /** The run that delegated `childRunId`, or undefined when it was not delegated. */
  parentRunOf(childRunId: string): string | undefined
  /** The status of each delegation `runId` made. */
  delegationsOf(runId: string): DelegationStatus[]
  /** The runs whose delegations' results a wake run delivers. */
  wakeCauses(wakeRunId: string): string[]
  /** The thread has a run that has not ended (queued, active, waiting or paused). */
  threadBusy(threadId: string): boolean
}

export interface BrowserTreeGrant {
  readonly id: string
  /** The thread of the person's run that rooted the grant. */
  readonly rootThreadId: string
  /** How the tree's person's runs were started: any `gui` run gives it the in-app browser, `cli` alone the profile's managed one. */
  readonly rootSource: 'gui' | 'cli'
  /** The runs it covers. */
  readonly runs: ReadonlySet<string>
  /** The threads those runs are on. */
  readonly threads: ReadonlySet<string>
}

interface MutableGrant extends BrowserTreeGrant {
  rootSource: 'gui' | 'cli'
  runs: Set<string>
  threads: Set<string>
}

export interface BrowserTreeTurn {
  threadId: string
  runId?: string
  source?: string
}

export class BrowserTreeGrants {
  private readonly grants = new Map<string, MutableGrant>()

  constructor(private readonly facts: BrowserTreeFacts | undefined) {}

  /**
   * The grant `turn` runs under, or undefined. A person's run roots one on its thread, or joins the one that thread
   * already roots while it lives; any other run joins the grant of the run that caused it.
   */
  admit(turn: BrowserTreeTurn): BrowserTreeGrant | undefined {
    this.sweep()
    const source = turn.source ?? ''
    if (ROOT_SOURCES.has(source)) return this.root(turn.threadId, source as 'gui' | 'cli', turn.runId)
    if (!turn.runId || !this.facts) return undefined
    const grant = this.causeGrant(turn.runId)
    if (grant) this.join(grant, turn.threadId, turn.runId)
    return grant
  }

  /** The live grants (tests and diagnostics). */
  list(): BrowserTreeGrant[] {
    return [...this.grants.values()]
  }

  private root(threadId: string, source: 'gui' | 'cli', runId: string | undefined): BrowserTreeGrant {
    // Without the run engine nothing says whether the tree still works: each person's run roots a grant of its own.
    let grant = this.facts ? this.grants.get(threadId) : undefined
    if (!grant) {
      grant = { id: randomUUID(), rootThreadId: threadId, rootSource: source, runs: new Set(), threads: new Set([threadId]) }
      this.grants.set(threadId, grant)
    }
    // A person's run at the window gives the tree the in-app browser, even when it joins a tree a command-line run
    // rooted (a command-line run on the same thread, or one that just ended and still counts as live because
    // this run keeps the thread busy).
    if (source === 'gui') grant.rootSource = 'gui'
    if (runId) grant.runs.add(runId)
    return grant
  }

  private join(grant: MutableGrant, threadId: string, runId: string): void {
    grant.runs.add(runId)
    grant.threads.add(threadId)
  }

  /** The grant of the run that caused `runId`, walking delegations, wakes and continuations up to a covered run. */
  private causeGrant(runId: string): MutableGrant | undefined {
    const facts = this.facts!
    let frontier = [runId]
    const seen = new Set<string>()
    for (let depth = 0; depth < MAX_DEPTH && frontier.length; depth += 1) {
      const next: string[] = []
      for (const current of frontier) {
        if (seen.has(current)) continue
        seen.add(current)
        // The run being admitted is not its own cause.
        if (current !== runId) {
          const covered = this.grantOfRun(current)
          if (covered) return covered
        }
        const run = safe(() => facts.run(current))
        if (!run) continue
        if (run.source === 'delegation') {
          const parent = safe(() => facts.parentRunOf(current))
          if (parent) next.push(parent)
        } else if (CONTINUATION_SOURCES.has(run.source) && run.continuationOf) {
          next.push(run.continuationOf)
        } else if (run.source === 'wake') {
          next.push(...(safe(() => facts.wakeCauses(current)) ?? []))
        }
      }
      frontier = next
    }
    return undefined
  }

  private grantOfRun(runId: string): MutableGrant | undefined {
    for (const grant of this.grants.values()) if (grant.runs.has(runId)) return grant
    return undefined
  }

  /** Drops the grants whose tree has ended. */
  private sweep(): void {
    if (!this.facts) return
    for (const [threadId, grant] of this.grants) if (!this.live(grant)) this.grants.delete(threadId)
  }

  /** The tree has a run that has not ended, or a result not yet delivered. An unreadable fact keeps it. */
  private live(grant: MutableGrant): boolean {
    const facts = this.facts!
    for (const threadId of grant.threads) if (safe(() => facts.threadBusy(threadId)) ?? true) return true
    for (const runId of grant.runs) {
      const run = safe(() => facts.run(runId))
      if (run && !TERMINAL_RUN_STATUSES.has(run.status)) return true
      if ((safe(() => facts.delegationsOf(runId)) ?? ['running']).some((status) => OPEN_DELEGATIONS.has(status))) return true
    }
    return false
  }
}

function safe<T>(read: () => T): T | undefined {
  try {
    return read()
  } catch {
    return undefined
  }
}

/** The facts of a profile's run engine. */
export function runEngineTreeFacts(engine: RunEngine): BrowserTreeFacts {
  return {
    run: (runId) => {
      const run = engine.getRun(runId)
      return run ? { threadId: run.threadId, source: run.source, status: run.status, ...(run.outcome?.continuationOf ? { continuationOf: run.outcome.continuationOf } : {}) } : undefined
    },
    parentRunOf: (childRunId) => engine.delegations.getByChildRun(childRunId)?.parentRunId,
    delegationsOf: (runId) => engine.delegations.listForParentRun(runId).map((delegation) => delegation.status),
    wakeCauses: (wakeRunId) => {
      const inboxIds = engine.outbox.listForRun(wakeRunId)
        .filter((effect) => effect.kind === 'turn.start')
        .flatMap((effect) => (effect.payload as { inboxIds?: unknown }).inboxIds)
        .filter((id): id is string => typeof id === 'string')
      return engine.inbox.getMany(inboxIds).flatMap((row) => {
        const delegationId = (row.payload as { delegationId?: unknown } | null)?.delegationId
        const parentRunId = typeof delegationId === 'string' ? engine.delegations.get(delegationId)?.parentRunId : undefined
        return parentRunId ? [parentRunId] : []
      })
    },
    threadBusy: (threadId) => engine.store.hasNonTerminalRun(threadId)
  }
}
