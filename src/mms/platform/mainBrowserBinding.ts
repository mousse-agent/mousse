import type { ChatMode } from '../../shared/types'
import type { MmsProfileServices } from '../MmsProfileServices'
import type { BrowserExecutionBinding } from '../orchestrator/browser/binding'
import { BROWSER_AUTOMATION_TOOLS } from '../../shared/browser/automation'
import { browserToolCapability, browserToolEffect } from '../orchestrator/browser/tools'
import { ExecutionPolicyService } from '../execution/ExecutionPolicyService'

export interface MainBrowserTurn {
  threadId: string
  turnId: string
  source?: string
  mode: ChatMode
}

/** Called once for an admitted turn, never a shared mutable LLM default. */
export function mainBrowserBinding(services: MmsProfileServices, turn: MainBrowserTurn): BrowserExecutionBinding | undefined {
  // These ingress labels are derived from the authenticated connection. Internal
  // wakes, channels and schedules cannot inherit an earlier GUI turn's browser.
  if (turn.source !== 'gui' && turn.source !== 'cli') return undefined
  const settings = services.settings.get().integrations.tools
  if (!settings.enabled) return undefined
  const thread = services.threads.getThread(turn.threadId)
  if (!thread || thread.settledAt) return undefined
  if (turn.source === 'gui' && !services.platform.browser.selectedTarget(turn.threadId)) return undefined
  const project = thread.projectId ? services.projects.getProject(thread.projectId) : undefined
  const descriptor = typeof turn.mode === 'string' ? services.modeRegistry.getModeSync(turn.mode, { projectPath: project?.path }) : undefined
  const readOnly = turn.mode === 'plan' || descriptor?.permission?.edit === 'deny' || descriptor?.permission?.bash === 'deny'
  const tools = BROWSER_AUTOMATION_TOOLS.filter((tool) => settings.enabledTools.includes(tool) && (!readOnly || browserToolEffect(tool) === 'read'))
  if (!tools.length) return undefined
  const policy = new ExecutionPolicyService().snapshot(services.profileId, {
    allowedTools: tools,
    allowedCapabilities: [...new Set(tools.map(browserToolCapability))],
    allowedEffects: readOnly ? ['read'] : ['read', 'external'],
    maxToolCalls: 100,
    maxElapsedMs: 30 * 60_000,
    maxArtifactBytes: 16 * 1024 * 1024
  })
  return {
    mode: 'structured', vision: false, policy,
    execution: {
      profileId: services.profileId, threadId: thread.id, projectId: thread.projectId,
      turnId: turn.turnId, actor: { kind: 'main' }, source: turn.source,
      policySnapshotId: policy.id, cancellationId: turn.turnId
    }
  }
}
