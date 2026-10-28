/**
 * An ACP agent that accepts `session/prompt` and then says nothing at all, under the real
 * orchestrator and Run Engine.
 *
 * The turn's `turn.start` effect stays running for as long as the turn, so the reconciler's
 * silent-run window (rule 2, `heartbeatToleranceMs`, 6x for sparse event streams) never applies to
 * a live turn. The bound that ends it belongs to the ACP session core: a prompt that gets no
 * reply and no update for `promptSilenceMs` fails the turn and ends the agent's process.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { methods, PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentRegistry } from '../src/mms/agents/AgentRegistry'
import { ProjectManager } from '../src/mms/data/ProjectManager'
import { ThreadDataStore } from '../src/mms/data/ThreadDataStore'
import { acpDriver } from '../src/mms/harness/drivers/acp'
import { piDriver } from '../src/mms/harness/drivers/pi'
import { createHarnessGateway } from '../src/mms/harness/gateway'
import { OrchestratorService } from '../src/mms/orchestrator/OrchestratorService'
import { UserQuestionService } from '../src/mms/orchestrator/UserQuestionService'
import { ProviderInstanceService } from '../src/mms/harness/instanceMap'
import { ProfileDatabase } from '../src/mms/run/db/ProfileDatabase'
import { EffectWorker } from '../src/mms/run/EffectWorker'
import { Reconciler } from '../src/mms/run/Reconciler'
import { RunEngine } from '../src/mms/run/RunEngine'
import { RunStore } from '../src/mms/run/RunStore'
import { inProcessAgent } from '../src/mms/run/testkit/acpAgent'
import { TaskQueue } from '../src/mms/tasks/TaskQueue'
import { PtyManager } from '../src/mms/terminals/PtyManager'
import { WorktreeManager } from '../src/mms/worktree/WorktreeManager'
import { getDefaultSettings } from '../src/shared/settings'

const SILENCE_MS = 300
const HEARTBEAT_MS = 10

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

describe('an ACP agent that never answers session/prompt', () => {
  it('ends the run as a failed turn instead of leaving it running, and kills the agent process', async () => {
    const home = mkdtempSync(join(tmpdir(), 'mousse-acp-stall-'))
    cleanups.push(() => rmSync(home, { recursive: true, force: true }))
    const previousHome = process.env.MOUSSE_HOME
    process.env.MOUSSE_HOME = home
    cleanups.push(() => {
      if (previousHome === undefined) delete process.env.MOUSSE_HOME
      else process.env.MOUSSE_HOME = previousHome
    })

    // The agent opens a session, takes the prompt and never replies or sends an update.
    const prompts: string[] = []
    const agent = inProcessAgent((app) => {
      app
        .onRequest(methods.agent.initialize, () => ({ protocolVersion: PROTOCOL_VERSION, agentInfo: { name: 'silent-agent', version: '0.0.1' }, agentCapabilities: {}, authMethods: [] }))
        .onRequest(methods.agent.session.new, () => ({ sessionId: 'silent-session' }))
        .onRequest(methods.agent.session.prompt, (c) => {
          prompts.push(c.params.sessionId)
          return new Promise<never>(() => {})
        })
    })

    const projects = new ProjectManager()
    const store = new ThreadDataStore(projects)
    const selection = { instanceId: 'acp:silent', llmProvider: '', model: 'default' }
    // A generic ACP agent approves tools itself, so it runs only in Full access.
    const settings = { ...getDefaultSettings(), provider: { ...getDefaultSettings().provider, ...selection }, permissions: { defaultMode: 'full' as const } }
    const orch = new OrchestratorService(
      new AgentRegistry(), new TaskQueue(), new WorktreeManager(home), new PtyManager(),
      { get: () => settings } as never, {} as never, undefined, undefined, undefined, undefined, undefined, projects
    )
    orch.setThreadStore(store)
    const engine = new RunEngine({ store: new RunStore(new ProfileDatabase({ profileHome: home })), heartbeatMs: HEARTBEAT_MS })
    orch.setRunEngine(engine)
    orch.recoverRunEngineOnBoot()
    const worker = new EffectWorker({ outbox: engine.outbox, executors: orch.effectExecutors(), owner: engine.leaseOwner })
    worker.start()
    orch.attachEffectWorker(worker)
    const harness = createHarnessGateway({
      profileHome: home,
      installationHome: home,
      instanceMap: new ProviderInstanceService(),
      questions: new UserQuestionService(),
      shellPath: async () => ({ entries: [], source: 'failed' }),
      drivers: [
        piDriver(),
        acpDriver({ connect: (_context, request) => agent.connect(request), pty: { available: () => false }, promptSilenceMs: SILENCE_MS })
      ]
    })
    harness.instanceMap.setEntry('acp:silent', { driver: 'acp', enabled: true, config: { displayName: 'Silent agent', binaryPath: process.execPath } })
    orch.setHarness(harness)
    cleanups.push(async () => {
      await worker.stop()
      orch.attachEffectWorker(null)
      orch.setRunEngine(null)
      engine.store.db.close()
      harness.stop()
    })

    const workspace = join(home, 'workspace')
    mkdirSync(workspace)
    const project = projects.openProject(workspace)
    const thread = store.createThread('silent', project.id, workspace)

    // The reconciler runs throughout, with a silence window of 2 x 6 x HEARTBEAT_MS (120 ms) for this sparse adapter.
    const reconciler = new Reconciler({ store: engine.store, outbox: engine.outbox, tools: engine.tools, heartbeatMs: HEARTBEAT_MS, capabilitiesFor: (id) => orch.capabilitiesForThread(id) })
    const repaired: string[] = []
    const passes = setInterval(() => repaired.push(...reconciler.runOnce().staleRuns), 10)
    cleanups.push(() => clearInterval(passes))

    const startedAt = Date.now()
    const response = await orch.send('Do the thing', false, { threadId: thread.id, clientRequestId: 'stall-send' })
    const elapsed = Date.now() - startedAt

    const run = engine.listRuns(thread.id).find((entry) => entry.clientRequestId === 'stall-send')!
    expect(prompts).toEqual(['silent-session'])
    // The ACP bound ended it, after the silence window and well before any effect timeout.
    expect(elapsed).toBeGreaterThanOrEqual(SILENCE_MS - 50)
    expect(elapsed).toBeLessThan(5_000)
    expect(engine.getRun(run.runId)).toMatchObject({ status: 'failed' })
    expect(repaired).toEqual([])
    // A retryable timeout, said in the agent's name.
    expect(response.error).toMatchObject({ errorInfo: { retryable: true } })
    expect(response.message).toMatch(/Silent agent .*(timed out|did not answer)/i)
    expect(agent.connections.at(-1)?.killed).toBe(true)
  }, 20_000)
})
