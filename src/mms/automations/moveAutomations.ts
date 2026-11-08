import { offlineText, type AutomationMoveResult } from '../../shared/automations'
import { isWorkflowPrompt } from '../../shared/jobPermissionEdit'
import type { CreateScheduledJobInput, ScheduledJob } from '../../shared/types'
import { parseQualifiedId, qualifyId } from '../../shared/threadRef'
import { DomainRpcError } from '../protocol/domainRegistry'
import type { RemoteAutomationsPort } from '../protocol/remoteAutomationsPort'
import type { MovedAutomation } from './MovedAutomations'

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
  now?: () => Date
}

/**
 * Why an automation cannot move, or undefined when it can. What it uses has to exist on the other computer as it is:
 * a bot's computer changes in its About; a saved agent, a workflow, a request URL and a thread are this computer's.
 * An agent's automation with an end keeps its limits only here, so Keep it first.
 */
export function moveRefusal(job: ScheduledJob): string | undefined {
  if (job.bot) return 'A bot’s computer changes in its About.'
  if (job.agent) return 'Its saved agent is kept on this computer.'
  if (isWorkflowPrompt(job.prompt)) return 'Its workflow is kept on this computer.'
  if (job.trigger?.webhook) return 'Turn off its request URL first.'
  if (job.threadId) return 'It runs in a thread of this computer.'
  if (job.createdBy && job.expiresAt) return 'An agent added it with an end. Keep it first.'
  if (job.state === 'running' || job.runClaim || job.pendingOccurrence) return 'Wait for its run to end.'
  return undefined
}

/**
 * Move to computer: each automation is made on `node` first, and removed here only once that computer confirmed it;
 * its run history stays here, read-only. One that cannot move, or that the other computer refuses, stays here as it was.
 * Every automation is tried; the answer names each one that moved and each one that did not, with why.
 */
export async function moveAutomations(deps: MoveDeps, jobIds: readonly string[], node: string, signal?: AbortSignal): Promise<AutomationMoveResult> {
  const remote = deps.remote
  if (!remote) throw new DomainRpcError('computer_offline', 'Your other computers are not connected. Turn on working on threads of your other computers in Settings, Devices.')
  const computer = remote.computers()?.find((entry) => entry.node === node)
  if (!computer) throw new DomainRpcError('computer_not_found', 'That is not one of your computers.')
  if (!computer.online) throw new DomainRpcError('computer_offline', offlineText(computer), { node, name: computer.name })
  const result: AutomationMoveResult = { moved: [], failed: [] }
  for (const id of jobIds) {
    const job = parseQualifiedId(id) ? undefined : deps.getJob(id)
    if (!job) {
      result.failed.push({ id, error: parseQualifiedId(id) ? 'Move it from the computer that has it.' : 'This automation is gone.' })
      continue
    }
    const refusal = moveRefusal(job)
    if (refusal) {
      result.failed.push({ id, name: job.name, error: refusal })
      continue
    }
    const wasPaused = job.state === 'paused' || !job.enabled
    try {
      let projectId: string | undefined
      if (job.projectId) {
        const project = deps.project(job.projectId)
        if (!project) throw new Error('Its project is gone from this computer.')
        const match = await remote.matchProject(node, project.path, signal)
        if (!match) throw new Error(`${computer.name} has no copy of ${project.name}.`)
        projectId = match.projectId
      }
      if (!wasPaused) deps.pause(job.id, `Moving to ${computer.name}`)
      let created: ScheduledJob
      try {
        created = await remote.create(node, inputOf(job, projectId), { idem: `move:${job.id}`, ...(signal ? { signal } : {}) })
      } catch (error) {
        // Not made there: it stays here, as it was.
        if (!wasPaused) deps.resume(job.id)
        throw error
      }
      let warning: string | undefined
      if (wasPaused) {
        try {
          await remote.pause(node, created.id, job.resumeAt, { idem: `move-pause:${job.id}`, ...(signal ? { signal } : {}) })
        } catch {
          warning = `It is not paused on ${computer.name}.`
        }
      }
      // Confirmed there: from now on it is stored and run there, and only its history stays here.
      deps.keepHistory({
        id: job.id,
        name: job.name,
        schedule: job.schedule,
        ...(job.projectId ? { projectId: job.projectId } : {}),
        movedAt: (deps.now?.() ?? new Date()).toISOString(),
        movedTo: { node, name: computer.name, jobId: created.id },
        runHistory: job.runHistory ?? []
      })
      deps.remove(job.id)
      result.moved.push({ id: job.id, to: qualifyId(node, created.id), ...(warning ? { warning } : {}) })
    } catch (error) {
      result.failed.push({ id, name: job.name, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return result
}

/** The automation as the other computer makes it: what it does and when, in its project, with what is left of its repeats. */
function inputOf(job: ScheduledJob, projectId: string | undefined): CreateScheduledJobInput {
  const left = job.repeat?.times ? Math.max(1, job.repeat.times - (job.repeat.completed ?? 0)) : undefined
  return {
    name: job.name,
    prompt: job.prompt,
    schedule: job.schedule,
    ...(job.createThread !== undefined ? { createThread: job.createThread } : {}),
    ...(projectId ? { projectId } : {}),
    ...(job.selection ? { selection: job.selection } : {}),
    ...(job.mode ? { mode: job.mode } : {}),
    ...(job.permissionMode ? { permissionMode: job.permissionMode } : {}),
    ...(projectId && job.workspace && job.workspace.kind !== 'worktree' ? { workspace: job.workspace } : {}),
    ...(job.tellMe ? { tellMe: job.tellMe } : {}),
    ...(left ? { repeat: { times: left } } : {})
  }
}
