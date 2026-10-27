/**
 * Replay scenario runner (docs/run-engine/SPEC.md §13.6). Boots a real `OrchestratorService`, Run
 * Engine and effect worker, installs one adapter's real provider client with its boundary replaced
 * by a `ReplayTransport`, sends the scenario's prompt and performs the transcript's cues (steer,
 * stop) through the engine's run-targeted commands.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Message } from '@earendil-works/pi-ai'
import { AgentRegistry } from '../../../src/mms/agents/AgentRegistry'
import { ProjectManager } from '../../../src/mms/data/ProjectManager'
import { ThreadDataStore } from '../../../src/mms/data/ThreadDataStore'
import { OrchestratorService } from '../../../src/mms/orchestrator/OrchestratorService'
import { UserQuestionService } from '../../../src/mms/orchestrator/UserQuestionService'
import { AntigravityProviderService } from '../../../src/mms/providers/antigravity/AntigravityProviderService'
import { ClaudeSubscriptionProviderService } from '../../../src/mms/providers/claudeSubscription/ClaudeSubscriptionProviderService'
import { ProfileDatabase } from '../../../src/mms/run/db/ProfileDatabase'
import { EffectWorker } from '../../../src/mms/run/EffectWorker'
import { RunEngine } from '../../../src/mms/run/RunEngine'
import { RunStore } from '../../../src/mms/run/RunStore'
import { replayAcpProcess } from '../../../src/mms/run/testkit/acpReplay'
import { replayCodexAppServer } from '../../../src/mms/run/testkit/codexAppServerReplay'
import { createCodexProviderService, type CodexProviderService } from '../../../src/mms/providers/codex/CodexProviderService'
import { createHarnessGateway } from '../../../src/mms/harness/gateway'
import { antigravityDriver } from '../../../src/mms/harness/drivers/antigravity'
import { acpDriver } from '../../../src/mms/harness/drivers/acp'
import { claudeCodeDriver } from '../../../src/mms/harness/drivers/claudeCode'
import { codexDriver } from '../../../src/mms/harness/drivers/codex'
import { cursorDriver } from '../../../src/mms/harness/drivers/cursor'
import { instanceStateDir } from '../../../src/mms/harness/instances'
import { replayCursorHost } from '../../../src/mms/run/testkit/cursorHostReplay'
import { piDriver } from '../../../src/mms/harness/drivers/pi'
import { ProviderInstanceService } from '../../../src/mms/providers/ProviderInstanceService'
import { replayPiChat } from '../../../src/mms/run/testkit/piChatReplay'
import { DEFAULT_VOLATILE_KEYS, dropKeys, readTranscript, ReplayTransport } from '../../../src/mms/run/testkit/ReplayTransport'
import { Reconciler } from '../../../src/mms/run/Reconciler'
import { replaySdkQuery } from '../../../src/mms/run/testkit/sdkQueryReplay'
import type { AttemptRecord, DelegationRecord, EffectKind, EffectRecord, HandoffRecord, RunRecord, TransferRecord } from '../../../src/mms/run/types'
import { TaskQueue } from '../../../src/mms/tasks/TaskQueue'
import { PtyManager } from '../../../src/mms/terminals/PtyManager'
import { WorktreeManager } from '../../../src/mms/worktree/WorktreeManager'
import { getDefaultSettings } from '../../../src/shared/settings'
import type { ChatMessage, OrchestratorResponse, TurnState } from '../../../src/shared/types'
import { SCENARIOS } from './index'

export const FIXTURES_DIR = join(__dirname, '..', 'fixtures')

/** Model selection per adapter; every fixture is authored against these. */
const SELECTION: Record<string, { instanceId?: string; llmProvider: string; model: string }> = {
  pi: { llmProvider: 'openai', model: 'gpt-replay' },
  // A Custom command: named by its instance only (no legacy provider name), on the agent's own model.
  acp: { instanceId: 'acp:replay', llmProvider: '', model: 'default' },
  // An added Cursor entry, on the model Cursor chooses (Auto).
  cursor: { instanceId: 'cursor:replay', llmProvider: '', model: 'default' },
  'claude-subscription': { llmProvider: 'claude-subscription', model: 'sonnet' },
  antigravity: { llmProvider: 'antigravity', model: 'replay-model' },
  codex: { llmProvider: 'codex', model: 'gpt-replay-codex' }
}

export interface ScenarioResult {
  adapterId: string
  response: OrchestratorResponse
  run: RunRecord
  /** Presentation transcript after the turn. */
  messages: ChatMessage[]
  /** Canonical (native) transcript after the turn. */
  llmMessages: Message[]
  turnState: TurnState
  /** Delegations the scenario thread made (SPEC §14), oldest first. */
  delegations: DelegationRecord[]
  /** Runs of the scenario thread, oldest first. */
  runs: RunRecord[]
  /** Handoffs the scenario thread received (SPEC §16.1), oldest first. */
  handoffs: HandoffRecord[]
  /** Transfers into or out of the scenario thread (SPEC §16.2), oldest first. */
  transfers: TransferRecord[]
  /** Attempts of each run of the scenario thread (with their execution bindings), by run id. */
  attempts: Record<string, AttemptRecord[]>
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g

/** Replaces run-time uuids in every string (delegating scenarios mint threads and delegations). */
function normalizeIds(frame: unknown): unknown {
  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') return value.replace(UUID, '<uuid>')
    if (Array.isArray(value)) return value.map(walk)
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, walk(entry)]))
    return value
  }
  return walk(dropKeys(DEFAULT_VOLATILE_KEYS)(frame))
}

/** Adapters with a fixture for `scenario`, by file name. */
export function fixtureAdapters(scenario: string): string[] {
  const dir = join(FIXTURES_DIR, scenario)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => name.endsWith('.ndjson'))
    .map((name) => name.slice(0, -'.ndjson'.length))
    .sort()
}

async function waitFor(cond: () => boolean, label: string, timeoutMs = 10_000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

export async function runScenario(name: string, adapterId: string): Promise<ScenarioResult> {
  const scenario = SCENARIOS[name]
  if (!scenario) throw new Error(`Unknown scenario ${name}`)
  const selection = SELECTION[adapterId]
  if (!selection) throw new Error(`No model selection for adapter ${adapterId}`)
  const transcript = readTranscript(join(FIXTURES_DIR, name, `${adapterId}.ndjson`))
  if (transcript.header.adapter !== adapterId || transcript.header.scenario !== name)
    throw new Error(`Fixture header names ${transcript.header.adapter}/${transcript.header.scenario}`)

  const home = mkdtempSync(join(tmpdir(), `mousse-scenario-${name}-`))
  const previousHome = process.env.MOUSSE_HOME
  process.env.MOUSSE_HOME = home
  const projects = new ProjectManager()
  const store = new ThreadDataStore(projects)
  const settings = { ...getDefaultSettings(), provider: { ...getDefaultSettings().provider, ...selection } }
  const orch = new OrchestratorService(
    new AgentRegistry(),
    new TaskQueue(),
    new WorktreeManager(home),
    new PtyManager(),
    { get: () => settings } as never,
    {} as never,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    projects
  )
  orch.setThreadStore(store)
  const engine = new RunEngine({ store: new RunStore(new ProfileDatabase({ profileHome: home })) })
  orch.setRunEngine(engine)
  orch.recoverRunEngineOnBoot()
  const worker = new EffectWorker({ outbox: engine.outbox, executors: orch.effectExecutors(), owner: engine.leaseOwner })
  worker.start()
  orch.attachEffectWorker(worker)
  const stops: Array<() => void> = []

  let threadId = ''
  const activeRun = (): RunRecord => {
    const run = engine.listRuns(threadId).find((entry) => entry.status === 'running')
    if (!run) throw new Error('No running run to act on')
    return run
  }
  const effectSucceeded = (kind: EffectKind, runId: string): boolean =>
    engine
      .listEvents(threadId)
      .filter((event) => event.type === 'effect.status')
      .map((event) => event.payload as EffectRecord)
      .some((effect) => effect.kind === kind && effect.runId === runId && effect.status === 'succeeded')
  let cues = 0
  const transport = new ReplayTransport(transcript, {
    ...(scenario.delegates ? { normalize: normalizeIds } : {}),
    onCue: async (cue) => {
      const action = cue as { action?: string; text?: string }
      const run = activeRun()
      cues += 1
      if (action.action === 'steer') {
        const result = await orch.steerRun(run.runId, action.text ?? '', `scenario-steer-${cues}`, threadId)
        if (result.status !== 'accepted') throw new Error(`steer was ${result.status}`)
        await waitFor(() => effectSucceeded('turn.steer', run.runId), 'turn.steer')
      } else if (action.action === 'stop') {
        const result = await orch.abortRun(run.runId, `scenario-stop-${cues}`, threadId)
        if (result.status !== 'accepted') throw new Error(`stop was ${result.status}`)
        await waitFor(() => effectSucceeded('turn.interrupt', run.runId), 'turn.interrupt')
      } else throw new Error(`Unknown cue ${JSON.stringify(cue)}`)
    }
  })

  // Every adapter shares the orchestrator's `LlmClient` for titles; only pi replays its chat.
  ;(orch as any).llm = {
    getSelectedModelContextLimit: () => ({ limit: 128_000, modelName: 'replay' }),
    getContextInputs: async () => ({ systemPromptText: '', mcpToolsText: '', otherToolsText: '', signature: 'replay' }),
    generateTitle: async () => 'Replay',
    chat: async () => {
      throw new Error(`${adapterId} turns must not reach the pi loop`)
    }
  }
  const questions = new UserQuestionService()
  const services: { claude?: ClaudeSubscriptionProviderService; antigravity?: AntigravityProviderService; codex?: CodexProviderService } = {}
  // A scenario may drive turns on several adapters (`before`); each replays from the one transcript.
  const involved = new Set([adapterId, ...(scenario.before ?? []).map((turn) => turn.adapter)])
  if (involved.has('pi')) {
    ;(orch as any).llm.chat = replayPiChat(transport).chat
  }
  if (involved.has('claude-subscription')) {
    const binary = join(home, 'claude')
    writeFileSync(binary, '#!/bin/sh\nexit 0\n')
    chmodSync(binary, 0o755)
    const providerDir = join(home, 'providers', 'claude-subscription')
    mkdirSync(providerDir, { recursive: true })
    writeFileSync(join(providerDir, 'settings.json'), JSON.stringify({ loginPolicy: 'cli', binaryPath: binary }))
    const service = new ClaudeSubscriptionProviderService(home, questions, {
      // A replayed transcript is one query per turn, so the scenarios keep the one-shot path.
      live: false,
      query: replaySdkQuery(transport),
      runAuth: async () => JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' })
    })
    stops.push(() => service.stop())
    services.claude = service
  }
  if (involved.has('antigravity')) {
    // Replace the agent process boundary only; the service's session lifecycle runs for real.
    const service = new AntigravityProviderService(home, home, questions, undefined, { connect: replayAcpProcess(transport) })
    Object.assign(service as unknown as Record<string, unknown>, { configured: () => true })
    stops.push(() => service.stop())
    services.antigravity = service
  }
  if (involved.has('codex')) {
    const binary = join(home, 'codex')
    writeFileSync(binary, '#!/bin/sh\nexit 0\n')
    chmodSync(binary, 0o755)
    const providerDir = join(home, 'providers', 'codex')
    mkdirSync(providerDir, { recursive: true })
    writeFileSync(join(providerDir, 'settings.json'), JSON.stringify({ binaryPath: binary, models: [{ id: 'gpt-replay-codex', label: 'Replay' }] }))
    // Replace the app-server process only; the client, service and adapter run for real.
    const service = createCodexProviderService(home, questions, { launch: replayCodexAppServer(transport) })
    stops.push(() => service.stop())
    services.codex = service
  }
  // The real gateway and drivers serve the turns; only each vendor's process boundary is replayed.
  const harness = createHarnessGateway({
    profileHome: home,
    installationHome: home,
    instanceMap: new ProviderInstanceService(),
    questions,
    shellPath: async () => ({ entries: [], source: 'failed' }),
    drivers: [
      piDriver({ client: () => orch.piChatClient() }),
      claudeCodeDriver({ builtIn: () => services.claude! }),
      antigravityDriver({ builtIn: () => services.antigravity! }),
      // The generic driver runs for real; only its agent connection is replayed.
      acpDriver({ connect: (_context, request) => replayAcpProcess(transport)(request), pty: { available: () => false } }),
      codexDriver({ builtIn: () => services.codex! }),
      // The driver and its session lifecycle run for real; only the host process is replayed.
      cursorDriver({ connect: replayCursorHost(transport) })
    ]
  })
  stops.push(() => harness.stop())
  if (involved.has('acp')) harness.instanceMap.setEntry('acp:replay', { driver: 'acp', enabled: true, config: { displayName: 'Replay agent', binaryPath: process.execPath } })
  if (involved.has('cursor')) {
    // A key saved for the entry (the vault keeps plain text outside Electron).
    const stateDir = instanceStateDir(home, 'cursor:replay')
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(join(stateDir, 'secrets.json'), JSON.stringify({ apiKey: 'replay-key', apiKeySubject: 'cursor-user:1' }))
    harness.instanceMap.setEntry('cursor:replay', { driver: 'cursor', enabled: true, config: { displayName: 'Replay Cursor' } })
  }
  orch.setHarness(harness)

  try {
    let thread
    // ACP agents work in a project workspace.
    if (adapterId === 'antigravity' || adapterId === 'acp' || adapterId === 'cursor') {
      const workspace = join(home, 'workspace')
      mkdirSync(workspace)
      const project = projects.openProject(workspace)
      thread = store.createThread(name, project.id, workspace)
    } else thread = store.createThread(name)
    threadId = thread.id
    for (const [index, turn] of (scenario.before ?? []).entries()) {
      const selected = SELECTION[turn.adapter]
      if (!selected) throw new Error(`No model selection for adapter ${turn.adapter}`)
      orch.setThreadModelOverride(threadId, selected)
      await orch.send(turn.prompt, false, { threadId, clientRequestId: `scenario-before-${index}` })
    }
    if (scenario.before) orch.setThreadModelOverride(threadId, selection)
    if (scenario.fork) threadId = (await engine.forkThread({ sourceThreadId: threadId, clientRequestId: 'scenario-fork' })).threadId
    const response = await orch.send(scenario.prompt, false, { threadId, clientRequestId: 'scenario-send' })
    await transport.idle()
    if (scenario.delegates) {
      // Children and wake turns run after the send returns; rule 4 wakes the parent.
      const reconciler = new Reconciler({ store: engine.store, outbox: engine.outbox, tools: engine.tools, capabilitiesFor: (id) => orch.capabilitiesForThread(id) })
      await waitFor(() => {
        if (transport.error) return true
        reconciler.runOnce()
        try {
          transport.assertDone()
          return engine.listRuns(threadId).every((run) => ['completed', 'failed', 'interrupted', 'cancelled'].includes(run.status))
        } catch {
          return false
        }
      }, 'the delegation to settle')
      await transport.idle()
    }
    transport.assertDone()
    const run = engine.listRuns(threadId).find((entry) => entry.clientRequestId === 'scenario-send')
    if (!run) throw new Error('The scenario send created no run')
    await waitFor(() => ['completed', 'failed', 'interrupted', 'cancelled'].includes(engine.getRun(run.runId)!.status), 'a terminal run')
    return {
      adapterId,
      response,
      run: engine.getRun(run.runId)!,
      messages: orch.getMessages(threadId),
      llmMessages: orch.getNativeContext(threadId).messages,
      turnState: orch.getTurnState(threadId),
      delegations: engine.delegations.listForParentThread(threadId),
      runs: engine.listRuns(threadId).reverse(),
      handoffs: engine.handoffs.listForThread(threadId),
      transfers: engine.transfers.listForThread(threadId),
      attempts: Object.fromEntries(engine.listRuns(threadId).map((entry) => [entry.runId, engine.store.listAttempts(entry.runId)]))
    }
  } finally {
    await worker.stop()
    orch.attachEffectWorker(null)
    orch.setRunEngine(null)
    engine.store.db.close()
    for (const stop of stops) stop()
    if (previousHome === undefined) delete process.env.MOUSSE_HOME
    else process.env.MOUSSE_HOME = previousHome
    rmSync(home, { recursive: true, force: true })
  }
}
