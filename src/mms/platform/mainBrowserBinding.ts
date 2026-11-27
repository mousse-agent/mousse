import type { ChatMode } from '../../shared/types'
import type { MmsProfileServices } from '../MmsProfileServices'
import { snapshotBrowserExecutionBinding, type BrowserExecutionBinding } from '../orchestrator/browser/binding'
import { BROWSER_AUTOMATION_TOOLS } from '../../shared/browser/automation'
import { browserToolCapability, browserToolReads } from '../orchestrator/browser/tools'
import { ExecutionPolicyService } from '../execution/ExecutionPolicyService'
import { BrowserTreeGrants, runEngineTreeFacts } from './browserTreeGrants'

export interface MainBrowserTurn {
  threadId: string
  turnId: string
  /** The run engine's run of the turn; without one only a person's turn is bound. */
  runId?: string
  source?: string
  mode: ChatMode
}

/** Each profile's grants, made on its first turn. */
const profileGrants = new WeakMap<MmsProfileServices, BrowserTreeGrants>()

function grantsOf(services: MmsProfileServices): BrowserTreeGrants {
  let grants = profileGrants.get(services)
  if (!grants) {
    const engine = (services as Partial<Pick<MmsProfileServices, 'runEngine'>>).runEngine
    grants = new BrowserTreeGrants(engine ? runEngineTreeFacts(engine) : undefined)
    profileGrants.set(services, grants)
  }
  return grants
}

/**
 * Called once for an admitted turn, never a shared mutable LLM default. A turn is bound only inside a live tree a person
 * started (`BrowserTreeGrants`): the person's own run, and the subagents, result wakes and continuations it caused.
 * Schedules, webhooks, remote origins and other agents' messages get no browser.
 */
export function mainBrowserBinding(services: MmsProfileServices, turn: MainBrowserTurn): BrowserExecutionBinding | undefined {
  const grant = grantsOf(services).admit(turn)
  if (!grant) return undefined
  const settings = services.settings.get().integrations.tools
  if (!settings.enabled) return undefined
  const thread = services.threads.getThread(turn.threadId)
  if (!thread || thread.archivedAt) return undefined
  const project = thread.projectId ? services.projects.getProject(thread.projectId) : undefined
  const descriptor = typeof turn.mode === 'string' ? services.modeRegistry.getModeSync(turn.mode, { projectPath: project?.path }) : undefined
  const workspace = (thread as { workspaceBinding?: { policy?: string; access?: string } }).workspaceBinding
  // A mode that denies edits or commands, and a read-only subagent, hold `browser.read` only: no tab of their
  // own, and no tool or argument that acts in a page.
  const readOnly = descriptor?.permission?.edit === 'deny' || descriptor?.permission?.bash === 'deny' ||
    (workspace?.policy === 'shared' && workspace.access === 'read-only')
  const tools = BROWSER_AUTOMATION_TOOLS.filter((tool) => settings.enabledTools.includes(tool) && (!readOnly || browserToolReads(tool)))
  if (!tools.length) return undefined
  const policy = new ExecutionPolicyService().snapshot(services.profileId, {
    allowedTools: tools,
    allowedCapabilities: [...new Set(tools.map(browserToolCapability))],
    allowedEffects: readOnly ? ['read'] : ['read', 'external'],
    maxToolCalls: 100,
    maxElapsedMs: 30 * 60_000,
    maxArtifactBytes: 16 * 1024 * 1024
  })
  return snapshotBrowserExecutionBinding({
    mode: 'structured', vision: false, policy,
    execution: {
      profileId: services.profileId, threadId: thread.id, projectId: thread.projectId,
      turnId: turn.turnId, actor: { kind: 'main' },
      // The backend is the tree's: the in-app browser for a tree a person started at the window, else the managed one.
      source: grant.rootSource,
      policySnapshotId: policy.id, cancellationId: turn.turnId,
      browserGrant: { grantId: grant.id, rootThreadId: grant.rootThreadId, lease: !readOnly }
    }
  })
}
