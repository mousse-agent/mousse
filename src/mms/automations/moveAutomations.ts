import { offlineText, type AutomationMoveResult } from '../../shared/automations'
import { isWorkflowPrompt } from '../../shared/jobPermissionEdit'
import type { PermissionMode } from '../../shared/permissionMode'
import type { CreateScheduledJobInput, ScheduledJob } from '../../shared/types'
import { parseQualifiedId, qualifyId } from '../../shared/threadRef'
import { DomainRpcError } from '../protocol/domainRegistry'
import type { RemoteAutomationsPort } from '../protocol/remoteAutomationsPort'
import { jobPermissionRequest } from '../scheduled/jobPermission'
import type { MovedAutomation, MoveTransfer } from './MovedAutomations'

/** What Move to computer needs from this computer's profile and from Bridge. */
export interface MoveDeps {
  /** Absent while this computer is not connected to the person's other computers. */
  remote: RemoteAutomationsPort | undefined
  getJob(id: string): ScheduledJob | undefined
  project(id: string): { name: string; path: string } | undefined
  /** Holds the job still while it moves, so it does not run here and there at once. */
  pause(id: string, reason: string): void
  resume(id: string): void
  remove(id: string): boolean
  keepHistory(entry: MovedAutomation): void
  /** Unfinished moves, kept on disk so a lost answer or a restart is finished by moving it again. */
  transfers: {
    get(id: string): MoveTransfer | undefined
    begin(entry: MoveTransfer): void
    end(id: string): void
  }
  /** The mode a job with neither a mode nor a ceiling runs in here: the mode threads start in. */
  defaultMode(): PermissionMode
  now?: () => Date
}

/**
 * Why an automation cannot move, or undefined when it can. What it uses has to exist on the other computer as it is:
 * a bot's computer changes in its About; a saved agent, a workflow, a request URL and a thread are this computer's.
 * An agent's automation keeps its limits (its access, its end) only here.
 */
export function moveRefusal(job: ScheduledJob): string | undefined {
  if (job.bot) return 'A bot’s computer changes in its About.'
  if (job.draft) return 'It is a draft. Turn it on first.'
  if (job.agent) return 'Its saved agent is kept on this computer.'
  if (isWorkflowPrompt(job.prompt)) return 'Its workflow is kept on this computer.'
  if (job.trigger?.webhook) return 'Turn off its request URL first.'
  if (job.trigger?.threadEvent) return 'It wakes on a pull request of a thread on this computer.'
  if (job.threadId) return 'It runs in a thread of this computer.'
  if (job.createdBy || job.accessCap) return 'An agent added it, and its limits stay on this computer.'
  if (job.state === 'running' || job.runClaim || job.pendingOccurrence) return 'Wait for its run to end.'
  return undefined
}

/** The codes of a routed call that may have reached the other computer: it may have made the automation. */
const MAYBE_DONE = new Set(['outcome_uncertain', 'deadline_exceeded', 'cancelled', 'computer_offline'])

/** Whether `error` says for certain that the other computer did not make it (it refused, or was never asked). */
function notMade(error: unknown): boolean {
  return error instanceof DomainRpcError && !MAYBE_DONE.has(error.code)
}

/**
 * Move to computer. For each automation:
 * 1. It is held paused here, and the move is recorded on disk with whether it was on.
 * 2. The other computer makes it paused, in one step, with the mode it ran in here (never wider) and its saved keys.
 * 3. Once that computer confirmed it, it is removed here (its run history stays, read-only), and turned on there only
 *    if it was on here.
 * A refusal there leaves it here as it was. An answer that never came leaves it paused on both ("Check <computer>"):
 * moving it again to the same computer finishes the move, since the same request reaches the same result there.
 * Every automation is tried; the answer names each one that moved and each one that did not, with why.
 */
export async function moveAutomations(deps: MoveDeps, jobIds: readonly string[], node: string, signal?: AbortSignal): Promise<AutomationMoveResult> {
  const remote = deps.remote
  if (!remote) throw new DomainRpcError('computer_offline', 'Your other computers are not connected. Turn on working on threads of your other computers in Settings, Devices.')
  const computer = remote.computers()?.find((entry) => entry.node === node)
  if (!computer) throw new DomainRpcError('computer_not_found', 'That is not one of your computers.')
  if (!computer.online) throw new DomainRpcError('computer_offline', offlineText(computer), { node, name: computer.name })
  const result: AutomationMoveResult = { moved: [], failed: [] }
  const now = () => (deps.now?.() ?? new Date()).toISOString()
  for (const id of jobIds) {
    const job = parseQualifiedId(id) ? undefined : deps.getJob(id)
    if (!job) {
      result.failed.push({ id, error: parseQualifiedId(id) ? 'Move it from the computer that has it.' : 'This automation is gone.' })
      continue
    }
    const fail = (error: string) => result.failed.push({ id, name: job.name, error })
    const refusal = moveRefusal(job)
    if (refusal) {
      fail(refusal)
      continue
    }
    // A move that was not confirmed holds while the job is still paused by it; a person who resumed it ended it.
    const recorded = deps.transfers.get(job.id)
    const open = recorded && !job.enabled && recorded.pausedAt === job.pausedAt ? recorded : undefined
    if (recorded && !open) deps.transfers.end(job.id)
    if (open && open.node !== node) {
      fail(`Check ${open.name} first: its move there was not confirmed. Move it to ${open.name} again to finish.`)
      continue
    }
    const wasEnabled = open ? open.wasEnabled : job.enabled && job.state !== 'paused'
    try {
      let projectId: string | undefined
      if (job.projectId) {
        const project = deps.project(job.projectId)
        if (!project) throw new Error('Its project is gone from this computer.')
        const match = await remote.matchProject(node, project.path, signal)
        if (!match) throw new Error(`${computer.name} has no copy of ${project.name}.`)
        projectId = match.projectId
      }
      // Held still here first, so it never runs on both computers.
      if (job.enabled) deps.pause(job.id, `Moving to ${computer.name}`)
      const held = deps.getJob(job.id)
      if (!held) throw new Error('This automation is gone.')
      // A tick may have claimed it while the project was looked up: that run ends here first.
      if (held.state === 'running' || held.runClaim || held.pendingOccurrence) {
        if (job.enabled) deps.resume(job.id)
        throw new Error('Wait for its run to end.')
      }
      deps.transfers.begin({ id: job.id, node, name: computer.name, wasEnabled, ...(held.pausedAt ? { pausedAt: held.pausedAt } : {}), startedAt: open?.startedAt ?? now() })
      let created: ScheduledJob
      try {
        created = await remote.create(node, inputOf(held, projectId, deps.defaultMode(), wasEnabled), { idem: `move:${job.id}`, ...(signal ? { signal } : {}) })
      } catch (error) {
        if (notMade(error)) {
          // Refused there: it stays here, as it was.
          deps.transfers.end(job.id)
          if (wasEnabled) deps.resume(job.id)
          throw error
        }
        // It may have been made there, paused. It stays paused here until a move again finds out.
        if (wasEnabled) {
          deps.pause(job.id, `Check ${computer.name}: the move was not confirmed`)
          const paused = deps.getJob(job.id)?.pausedAt
          deps.transfers.begin({ id: job.id, node, name: computer.name, wasEnabled, ...(paused ? { pausedAt: paused } : {}), startedAt: open?.startedAt ?? now() })
        }
        throw new Error(`Check ${computer.name}: it did not confirm the move. It is paused here; move it to ${computer.name} again to finish.`)
      }
      // Confirmed there: from now on it is stored and run there, and only its history stays here.
      try {
        deps.keepHistory({
          id: job.id,
          name: job.name,
          schedule: job.schedule,
          ...(job.projectId ? { projectId: job.projectId } : {}),
          movedAt: now(),
          movedTo: { node, name: computer.name, jobId: created.id },
          runHistory: job.runHistory ?? []
        })
        deps.remove(job.id)
      } catch (error) {
        throw new Error(`It was made on ${computer.name}, paused, but not removed here (${error instanceof Error ? error.message : String(error)}). Move it again to finish.`)
      }
      deps.transfers.end(job.id)
      let warning: string | undefined
      if (wasEnabled) {
        try {
          await remote.resume(node, created.id, { idem: `move-resume:${job.id}`, ...(signal ? { signal } : {}) })
        } catch {
          warning = `${job.name} is paused on ${computer.name}. Resume it there.`
        }
      }
      result.moved.push({ id: job.id, to: qualifyId(node, created.id), ...(warning ? { warning } : {}) })
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error))
    }
  }
  return result
}

/**
 * The automation as the other computer makes it: paused, what it does and when, in its project, with what is left of
 * its repeats. Its mode is the one it ran in here (its own, bounded by its ceiling, else the mode threads start in);
 * the other computer refuses it when that is wider than it allows, so a move never widens it. Its saved keys and CLI
 * name go with it (a key's value is set on each computer).
 */
function inputOf(job: ScheduledJob, projectId: string | undefined, defaultMode: PermissionMode, wasEnabled: boolean): CreateScheduledJobInput {
  const left = job.repeat?.times ? Math.max(1, job.repeat.times - (job.repeat.completed ?? 0)) : undefined
  return {
    name: job.name,
    prompt: job.prompt,
    schedule: job.schedule,
    ...(job.createThread !== undefined ? { createThread: job.createThread } : {}),
    ...(projectId ? { projectId } : {}),
    ...(job.selection ? { selection: job.selection } : {}),
    ...(job.mode ? { mode: job.mode } : {}),
    permissionMode: jobPermissionRequest(job) ?? defaultMode,
    ...(projectId && job.workspace && job.workspace.kind !== 'worktree' ? { workspace: job.workspace } : {}),
    ...(job.tellMe ? { tellMe: job.tellMe } : {}),
    ...(job.keys?.length ? { keys: job.keys } : {}),
    ...(job.cliName ? { cliName: job.cliName } : {}),
    ...(left ? { repeat: { times: left } } : {}),
    // On here: paused there until this move turns it on. Paused here: paused there the same way, with the same end.
    paused: wasEnabled
      ? { reason: 'Moving here' }
      : { ...(job.pausedReason ? { reason: job.pausedReason } : {}), ...(job.resumeAt ? { until: job.resumeAt } : {}) }
  }
}
