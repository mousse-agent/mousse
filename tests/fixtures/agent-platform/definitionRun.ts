import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AssistantMessage, Context } from '@earendil-works/pi-ai'
import { AgentRegistry } from '../../../src/mms/agents/AgentRegistry'
import { ProjectManager } from '../../../src/mms/data/ProjectManager'
import { ThreadDataStore } from '../../../src/mms/data/ThreadDataStore'
import { OrchestratorService } from '../../../src/mms/orchestrator/OrchestratorService'
import { ProfileDatabase } from '../../../src/mms/run/db/ProfileDatabase'
import { RunEngine } from '../../../src/mms/run/RunEngine'
import { RunStore } from '../../../src/mms/run/RunStore'
import { TaskQueue } from '../../../src/mms/tasks/TaskQueue'
import { PtyManager } from '../../../src/mms/terminals/PtyManager'
import { WorktreeManager } from '../../../src/mms/worktree/WorktreeManager'
import type { AgentExecutionRequest, AgentExecutionResult } from '../../../src/shared/agents/execution'
import type { ResolvedAgentDefinition } from '../../../src/shared/agents/types'
import type { BrowserRuntimePort } from '../../../src/shared/browser/runtime'
import { getDefaultSettings } from '../../../src/shared/settings'
import { installExactDefinitionRuntime, type ExactRuntime } from './exactDefinitionRuntime'

/** The thread id the callers name; the run's real thread takes its place. */
const NAMED_THREAD = 'thread-1'
/** A running Mousse MCP server, as far as the gateway sees it: every turn gets a bearer. */
const mcpServer = { bearerForTurn: () => ({ url: 'http://127.0.0.1:9/mcp', token: 'fake-bearer', tokenHash: 'fake-hash' }), turnEnded: () => undefined, revokeThread: () => {} }

const cleanups: Array<() => void> = []

/** Undoes every `runDefinition` fixture (call from `afterEach`). */
export function disposeDefinitionRuns(): void {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
}

/**
 * One definition run through the real orchestrator, gateway and run engine, on the exact stand-in
 * for Pi RPC (`installExactDefinitionRuntime`), with the model's replies scripted. The snapshot's
 * model ref is put on the stand-in's instance (`pi:<provider>`) when it names none.
 */
export function runDefinition(
  snapshot: ResolvedAgentDefinition,
  outputs: AssistantMessage[],
  request: Partial<Omit<AgentExecutionRequest, 'resolved'>> & {
    captured?: Context[]
    /** The profile's own browser runtime (`OrchestratorService.setBrowserRuntime`). */
    profileBrowser?: BrowserRuntimePort
  } = {}
): { captured: Context[]; turns: ExactRuntime['turns']; threadId: string; pending: Promise<AgentExecutionResult> } {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'mousse-defrun-')))
  const previousHome = process.env.MOUSSE_HOME
  process.env.MOUSSE_HOME = home
  const store = new ThreadDataStore(new ProjectManager())
  const settings = getDefaultSettings()
  settings.integrations.skills.enabled = false
  const orch = new OrchestratorService(new AgentRegistry(), new TaskQueue(), new WorktreeManager(home), new PtyManager(), { get: () => settings } as never, {} as never)
  orch.setThreadStore(store)
  const engine = new RunEngine({ store: new RunStore(new ProfileDatabase({ profileHome: home })) })
  orch.setRunEngine(engine)
  orch.setMcpAttachment(mcpServer)
  if (request.profileBrowser) orch.setBrowserRuntime(request.profileBrowser)
  const ref = snapshot.settings.primaryModel.ref
  const instanceId = ref.instanceId ?? `pi:${ref.providerId}`
  snapshot.settings.primaryModel.ref = { ...ref, instanceId }
  snapshot.model.primary.ref = { ...snapshot.model.primary.ref, instanceId }
  const captured = request.captured ?? []
  const runtime = installExactDefinitionRuntime({ orchestrator: orch, providerId: ref.providerId, profileHome: home, captured, outputs })
  cleanups.push(() => {
    orch.setRunEngine(null)
    engine.store.db.close()
    runtime.harness.stop()
    rmSync(home, { recursive: true, force: true })
    if (previousHome === undefined) delete process.env.MOUSSE_HOME
    else process.env.MOUSSE_HOME = previousHome
  })
  const threadId = store.createThread('definition run').id
  const { captured: _captured, profileBrowser: _profileBrowser, context, ...rest } = request
  const named = (id: string | undefined) => (id === NAMED_THREAD ? threadId : id)
  const pending = orch.runAgentDefinition({
    profileId: snapshot.profileId,
    input: 'inspect',
    ...rest,
    resolved: snapshot,
    threadId,
    ...(context ? { context: { ...context, threadId: named(context.threadId) } as never } : {})
  } as AgentExecutionRequest)
  return { captured, turns: runtime.turns, threadId, pending }
}
