import type { BrowserAction, BrowserActionResult, BrowserObservation, BrowserSessionRecord } from '../../../../src/shared/browser/types'
import type { BrowserToolContext, BrowserToolResult } from '../../../../src/shared/browser/automation'
import { findElement, haystack, observe, observationFrom, targetFor } from './observations'
import type { EvaluationRuntime } from './runtime'
import { visionFor } from './runtime'
import { evaluationCatalog, mulberry32 } from './catalog'
import { nativeGymTasks, runNativeBrowserGymTask } from './browsergym/adapter'
import { probeBrowserGymPython } from './browsergym/environment'
import { BROWSERGYM_EXTERNAL_RUN_COMMAND } from './browsergym/protocol'
import { UNAVAILABLE_COST } from './metrics'
import { buildPin, DEFAULT_BUDGETS } from './pin'
import type {
  ActionTrace,
  EvaluationMode,
  EvaluationReport,
  ObservationMode,
  RecordedAction,
  TaskDefinition,
  TaskSplit,
  TaskTrialResult
} from './types'
import type { EvaluationSite } from './site'
import type { ModelDriver } from './modelDriver'
import { MAX_MODEL_SCREENSHOT_BYTES, observationForModel } from './modelDriver'

function nowIso(): string {
  return new Date().toISOString()
}

function resolveAction(step: Extract<RecordedAction, { kind: 'act' | 'human-act-expect-block' }>, observation: BrowserObservation, mode: ObservationMode): BrowserAction {
  const action = typeof step.action === 'function' ? step.action(observation) : step.action
  if (!('target' in action) || !action.target || action.target.kind !== 'ref') return action
  // Text entry still uses a semantic ref. The production executor accepts
  // image points for text actions, but screenshot pixels do not identify the
  // editable control reliably after focus/scroll changes. Pointer actions
  // are the screenshot adapter's coordinate path.
  if (mode !== 'screenshot' || !['click', 'double-click', 'hover'].includes(action.type)) return action
  const element = observation.elements.find((candidate) => candidate.ref === action.target.ref)
  if (!observation.screenshot || !element?.bounds) return action
  const converted = targetFor(mode, observation, { ref: action.target.ref })
  return { ...action, target: converted } as BrowserAction
}

function asSession(value: unknown): BrowserSessionRecord {
  const session = (value as { session?: BrowserSessionRecord }).session
  if (!session) throw new Error('missing session')
  return session
}

function actionTrace(partial: Omit<ActionTrace, 'startedAt' | 'endedAt' | 'wallMs' | 'trial' | 'seed' | 'taskId' | 'support' | 'observationMode' | 'driverKind'> & Partial<ActionTrace>, base: ActionTrace): ActionTrace {
  return { ...base, ...partial }
}

export interface RunOptions {
  modes?: EvaluationMode[]
  observationModes?: ObservationMode[]
  split?: TaskSplit | 'all'
  repeats?: number
  seed?: number
  stressCycles?: number
  taskIds?: string[]
}

/** Execute decisions from an injected model through the same production tool
 * dispatcher used by conformance runs. This path is intentionally opt-in and
 * its trials retain the live-model label even when the endpoint is local. */
export async function runModelSuite(input: {
  runtime: EvaluationRuntime
  site: EvaluationSite
  driverFactory: () => ModelDriver
  options?: Pick<RunOptions, 'taskIds' | 'split' | 'seed' | 'repeats'> & {
    observationMode?: ObservationMode
    observationModes?: ObservationMode[]
  }
}): Promise<TaskTrialResult[]> {
  const seed = input.options?.seed ?? 20260911
  const repeats = input.options?.repeats ?? 1
  if (!Number.isSafeInteger(repeats) || repeats < 1 || repeats > 20) throw new Error('Model evaluation repeats must be an integer from 1 to 20')
  const modes = input.options?.observationModes ?? [input.options?.observationMode ?? 'hybrid']
  if (!modes.length || modes.some((mode) => !['structured', 'hybrid', 'screenshot'].includes(mode))) throw new Error('Model evaluation requires valid observation modes')
  const tasks = evaluationCatalog().filter((candidate) =>
    (!input.options?.taskIds?.length || input.options.taskIds.includes(candidate.id))
    && (!input.options?.split || input.options.split === 'all' || candidate.split === input.options.split))
  const trials: TaskTrialResult[] = []
  for (const task of tasks) {
    for (const observationMode of modes) {
      for (let trial = 0; trial < repeats; trial += 1) {
        if (task.support === 'unsupported' || !task.observationModes.includes(observationMode)) {
          trials.push(unsupportedModelTrial(task, observationMode, trial, seed + trial,
            task.support === 'unsupported'
              ? 'Task is explicitly unsupported by the pinned executor contract'
              : `Task does not support ${observationMode} observations`))
          continue
        }
        const driver = input.driverFactory()
        trials.push(await runModelTrial(input.runtime, input.site, task, observationMode, trial, seed + trial, driver))
      }
    }
  }
  return trials
}

function unsupportedModelTrial(task: TaskDefinition, observationMode: ObservationMode, trial: number, seed: number, reason: string): TaskTrialResult {
  const at = nowIso()
  return {
    taskId: task.id, trial, seed, split: task.split, support: 'unsupported', category: task.category,
    observationMode, driverKind: 'live-model', mode: 'live-model', startedAt: at, endedAt: at, wallMs: 0,
    taskSuccess: false, actionSuccessCount: 0, actionCount: 0, falseSuccess: false, duplicateEffect: false,
    intervention: false, retries: 0, recovery: false, unsupportedReported: true, cost: { ...UNAVAILABLE_COST },
    actions: [], verifierNotes: [reason], error: reason
  }
}

async function runModelTrial(
  runtime: EvaluationRuntime,
  site: EvaluationSite,
  task: TaskDefinition,
  observationMode: ObservationMode,
  trial: number,
  seed: number,
  driver: ModelDriver
): Promise<TaskTrialResult> {
  const startedAt = nowIso()
  const t0 = performance.now()
  const context = runtime.context(true, `model-${task.id}-${observationMode}-${trial}-${seed}`)
  const counters = site.counterSnapshot()
  const traces: ActionTrace[] = []
  let session: BrowserSessionRecord | undefined
  let observation: BrowserObservation | undefined
  let error: string | undefined
  try {
    const opened = await runtime.tools.invoke('browser_open', { url: `${site.origin}${task.page}` }, context)
    if (!opened.ok || !opened.value.session || !opened.value.observation) throw new Error(`open failed ${JSON.stringify(opened)}`)
    session = opened.value.session as BrowserSessionRecord
    observation = opened.value.observation
    if (observationMode !== 'structured') {
      observation = (await observe(runtime.tools, context, session.id, observation.tabId, observationMode)).observation
    }
    for (let stepIndex = 0; stepIndex < driver.budgets.maxActions; stepIndex += 1) {
      const modelObservation = observationForModel(observation, observationMode)
      const screenshot = modelObservation.screenshot
        ? await runtime.readModelScreenshot(context, modelObservation, MAX_MODEL_SCREENSHOT_BYTES)
        : undefined
      const decision = await driver.decide({
        taskId: task.id,
        goal: task.goal,
        observation: modelObservation,
        ...(screenshot ? { screenshot } : {}),
        stepIndex
      })
      if (decision.kind === 'stop' || decision.kind === 'unavailable') { error = decision.reason; break }
      const stepStarted = performance.now()
      const acted = await invokeAct(runtime, context, session, observation, decision.action, decision.expected)
      const result = acted.result
      const actionResult = result.ok ? result.value.action : undefined
      traces.push({
        taskId: task.id, trial, seed, support: task.support, observationMode, driverKind: 'live-model',
        tool: 'browser_act', actionType: decision.action.type, startedAt: nowIso(), endedAt: nowIso(), wallMs: performance.now() - stepStarted,
        observationMs: acted.observationMs, executorOverheadMs: acted.overheadMs,
        outcome: result.ok ? (actionResult?.outcome ?? 'unverified') : 'tool-error', dispatched: Boolean(actionResult?.dispatched),
        code: result.ok ? actionResult?.code : result.error.code, message: result.ok ? actionResult?.message : result.error.message,
        verifiedByGroundTruth: decision.expected ? Boolean(result.ok && actionResult?.outcome === 'verified') : null,
        falseSuccess: false, duplicateEffect: false, intervention: false, retry: false, recovery: false
      })
      if (observationMode === 'structured' && result.ok && actionResult?.observation) {
        observation = actionResult.observation
      } else {
        const fresh = await observe(runtime.tools, context, session.id, observation.tabId, observationMode).catch(() => undefined)
        if (fresh) observation = fresh.observation
      }
    }
    const check = await task.verify({ observation, submitCount: (path) => site.submitDelta(counters, path), downloadNames: [], frameSubmitCount: site.frameSubmitDelta(counters), actionOutcomes: traces, support: task.support })
    const cost = driver.cost()
    const failure = check.ok ? undefined : (error ?? 'Ground-truth verification failed')
    return {
      taskId: task.id, trial, seed, split: task.split, support: task.support, category: task.category,
      observationMode, driverKind: 'live-model', mode: 'live-model', startedAt, endedAt: nowIso(), wallMs: performance.now() - t0,
      taskSuccess: check.ok, actionSuccessCount: traces.filter((trace) => trace.outcome === 'verified').length, actionCount: traces.length,
      falseSuccess: check.falseSuccess, duplicateEffect: check.duplicateEffect, intervention: false, retries: 0, recovery: false,
      unsupportedReported: false, cost, actions: traces, verifierNotes: [...check.notes, ...(error ? [`model: ${error}`] : [])],
      ...(failure ? { error: failure } : {})
    }
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught)
    return {
      taskId: task.id, trial, seed, split: task.split, support: task.support, category: task.category,
      observationMode, driverKind: 'live-model', mode: 'live-model', startedAt, endedAt: nowIso(), wallMs: performance.now() - t0,
      taskSuccess: false, actionSuccessCount: traces.filter((trace) => trace.outcome === 'verified').length, actionCount: traces.length,
      falseSuccess: false, duplicateEffect: false, intervention: false, retries: 0, recovery: false, unsupportedReported: false,
      cost: driver.cost(), actions: traces, verifierNotes: [error], error
    }
  } finally {
    if (session) await runtime.sessions.close(context, session.id).catch(() => undefined)
  }
}

export async function runExecutorSuite(input: {
  runtime: EvaluationRuntime
  site: EvaluationSite
  options: RunOptions
}): Promise<TaskTrialResult[]> {
  const catalog = evaluationCatalog().filter((task) => {
    if (input.options.taskIds?.length) return input.options.taskIds.includes(task.id)
    if (input.options.split && input.options.split !== 'all' && task.split !== input.options.split) return false
    return true
  })
  const observationModes = input.options.observationModes ?? ['structured']
  const repeats = input.options.repeats ?? 3
  const seed = input.options.seed ?? 20260911
  const rng = mulberry32(seed)
  const trials: TaskTrialResult[] = []
  for (const task of catalog) {
    const selected = task.observationModes.filter((mode) => observationModes.includes(mode))
    for (const mode of selected) {
      const n = task.support === 'unsupported' ? Math.min(repeats, task.repeatsDefault) : repeats
      for (let trial = 0; trial < n; trial += 1) {
        rng()
        trials.push(await runTask(input.runtime, input.site, task, mode, trial, seed + trial))
      }
    }
  }
  if ((input.options.stressCycles ?? 0) > 0) {
    trials.push(await runFormStress(input.runtime, input.site, input.options.stressCycles ?? 0, seed))
  }
  return trials
}

async function runTask(
  runtime: EvaluationRuntime,
  site: EvaluationSite,
  task: TaskDefinition,
  mode: ObservationMode,
  trial: number,
  seed: number
): Promise<TaskTrialResult> {
  const startedAt = nowIso()
  const t0 = performance.now()
  const runId = `${task.id}-${trial}-${seed}`
  const context = runtime.context(visionFor(mode), runId)
  const traces: ActionTrace[] = []
  let observation: BrowserObservation | undefined
  let firstObservation: BrowserObservation | undefined
  let firstAction: BrowserAction | undefined
  let session: BrowserSessionRecord | undefined
  const downloads: string[] = []
  const counters = site.counterSnapshot()
  let intervention = false
  let retries = 0
  let recovery = task.id.startsWith('recovery.')
  const baseTrace = {
    taskId: task.id,
    trial,
    seed,
    support: task.support,
    observationMode: mode,
    driverKind: 'executor-script' as const,
    startedAt,
    endedAt: startedAt,
    wallMs: 0,
    observationMs: null,
    executorOverheadMs: null,
    outcome: 'skipped' as const,
    dispatched: false,
    verifiedByGroundTruth: null,
    falseSuccess: false,
    duplicateEffect: false,
    intervention: false,
    retry: false,
    recovery
  }
  try {
    const opened = await runtime.tools.invoke('browser_open', { url: `${site.origin}${task.page}` }, context)
    if (!opened.ok || !opened.value.session || !opened.value.observation) throw new Error(`open failed ${JSON.stringify(opened)}`)
    session = opened.value.session as BrowserSessionRecord
    observation = opened.value.observation
    const ready = await runtime.tools.invoke('browser_wait', {
      sessionId: session.id,
      tabId: observation.tabId,
      condition: { type: 'document-ready' },
      timeoutMs: 8_000
    }, context)
    if (ready.ok && ready.value.observation) observation = ready.value.observation
    firstObservation = observation
    if (mode !== 'structured') {
      const extra = await observe(runtime.tools, context, session.id, observation.tabId, mode)
      observation = extra.observation
      traces.push(actionTrace({
        tool: 'browser_observe',
        outcome: 'verified',
        dispatched: false,
        observationMs: extra.ms,
        verifiedByGroundTruth: null
      }, { ...baseTrace, startedAt: nowIso(), endedAt: nowIso(), wallMs: extra.ms }))
    }
    for (const step of task.script) {
      const stepStarted = performance.now()
      const stepIso = nowIso()
      if (step.kind === 'observe') {
        const extra = await observe(runtime.tools, context, session.id, observation.tabId, mode)
        observation = extra.observation
        traces.push(actionTrace({ tool: 'browser_observe', outcome: 'verified', dispatched: false, observationMs: extra.ms }, { ...baseTrace, startedAt: stepIso, endedAt: nowIso(), wallMs: extra.ms }))
        continue
      }
      if (step.kind === 'wait') {
        const waited = await runtime.tools.invoke('browser_wait', {
          sessionId: session.id,
          tabId: observation.tabId,
          condition: step.condition,
          timeoutMs: step.timeoutMs ?? 8_000
        }, context)
        if (waited.ok && waited.value.observation) observation = waited.value.observation
        else {
          // A timed-out wait still leaves a useful fresh observation. Keep the
          // verifier and subsequent recorded step grounded in current refs.
          const fresh = await observe(runtime.tools, context, session.id, observation.tabId, mode).catch(() => undefined)
          if (fresh) observation = fresh.observation
        }
        traces.push(actionTrace({
          tool: 'browser_wait',
          outcome: waited.ok ? 'verified' : 'tool-error',
          dispatched: false,
          code: waited.ok ? undefined : waited.error.code,
          message: waited.ok ? undefined : `${waited.error.message}; fresh=${observation.elements.map((element) => `${element.role}:${element.name ?? element.text ?? ''}`).join('|')}`,
          observationMs: performance.now() - stepStarted
        }, { ...baseTrace, startedAt: stepIso, endedAt: nowIso(), wallMs: performance.now() - stepStarted }))
        continue
      }
      if (step.kind === 'takeover') {
        intervention = step.owner === 'human' || intervention
        await runtime.sessions.control(context, session.id, step.owner)
        const listed = runtime.sessions.list(context).find((item) => item.id === session!.id)
        if (listed) session = listed
        const extra = await observe(runtime.tools, context, session.id, observation.tabId, mode).catch(() => undefined)
        if (extra) observation = extra.observation
        traces.push(actionTrace({
          tool: 'control.take',
          actionType: step.owner,
          outcome: 'verified',
          dispatched: true,
          intervention: step.owner === 'human'
        }, { ...baseTrace, startedAt: stepIso, endedAt: nowIso(), wallMs: performance.now() - stepStarted }))
        continue
      }
      if (step.kind === 'human-act-expect-block') {
        const action = resolveAction(step, observation, mode)
        const blocked = await runtime.tools.invoke('browser_act', {
          sessionId: session.id,
          tabId: observation.tabId,
          generation: observation.generation,
          observationId: observation.observationId,
          controlLeaseId: session.controlLeaseId,
          action
        }, context)
        const fenced = !blocked.ok && ['human_controlled', 'stale_generation', 'stale_observation'].includes(blocked.error.code)
        traces.push(actionTrace({
          tool: 'browser_act',
          actionType: action.type,
          outcome: fenced ? 'verified' : (blocked.ok ? 'failed' : 'tool-error'),
          dispatched: Boolean(blocked.ok && blocked.value.action?.dispatched),
          code: blocked.ok ? undefined : blocked.error.code,
          message: blocked.ok ? undefined : blocked.error.message,
          intervention: true,
          executorOverheadMs: performance.now() - stepStarted,
          verifiedByGroundTruth: fenced
        }, { ...baseTrace, startedAt: stepIso, endedAt: nowIso(), wallMs: performance.now() - stepStarted }))
        continue
      }
      if (step.kind === 'upload') {
        const staged = await runtime.stageUpload('safe fixture text', 'note.txt')
        const action: BrowserAction = { type: 'upload', target: targetFor(mode === 'screenshot' ? 'screenshot' : 'structured', observation, step.query), artifactIds: [staged.artifactId] }
        const uploaded = await invokeAct(runtime, context, session, observation, action)
        applyAct(uploaded, traces, baseTrace, stepIso, stepStarted, action.type, observation)
        const result = uploaded.result
        if (result.ok && result.value.action?.observation) observation = result.value.action.observation
        continue
      }
      if (step.kind === 'replay-stale') {
        retries += 1
        recovery = true
        if (!firstObservation || !firstAction) throw new Error('replay-stale requires a prior action')
        const replayed = await runtime.tools.invoke('browser_act', {
          sessionId: session.id,
          tabId: firstObservation.tabId,
          generation: firstObservation.generation,
          observationId: firstObservation.observationId,
          controlLeaseId: session.controlLeaseId,
          action: firstAction
        }, context)
        const dispatched = Boolean(replayed.ok && replayed.value.action?.dispatched)
        const rejected = !dispatched && (replayed.ok === false || replayed.value.action?.outcome === 'blocked' || replayed.value.action?.outcome === 'failed')
        traces.push(actionTrace({
          tool: 'browser_act',
          actionType: firstAction.type,
          outcome: dispatched ? 'failed' : (rejected ? 'verified' : 'tool-error'),
          dispatched,
          code: replayed.ok ? replayed.value.action?.code : replayed.error.code,
          message: replayed.ok ? replayed.value.action?.message : replayed.error.message,
          retry: true,
          recovery: true,
          verifiedByGroundTruth: rejected && !dispatched
        }, { ...baseTrace, startedAt: stepIso, endedAt: nowIso(), wallMs: performance.now() - stepStarted }))
        continue
      }
      if (step.kind === 'find') {
        const found = await runtime.tools.invoke('browser_find', { sessionId: session.id, tabId: observation.tabId, query: step.query, role: step.role }, context)
        traces.push(actionTrace({
          tool: 'browser_find',
          outcome: found.ok ? 'verified' : 'tool-error',
          dispatched: false,
          code: found.ok ? undefined : found.error.code
        }, { ...baseTrace, startedAt: stepIso, endedAt: nowIso(), wallMs: performance.now() - stepStarted }))
        continue
      }
      if (step.kind === 'tabs') {
        const tabs = await runtime.tools.invoke('browser_tabs', { sessionId: session.id, operation: step.operation, url: step.url }, context)
        traces.push(actionTrace({
          tool: 'browser_tabs',
          outcome: tabs.ok ? 'verified' : 'tool-error',
          dispatched: step.operation !== 'list',
          code: tabs.ok ? undefined : tabs.error.code
        }, { ...baseTrace, startedAt: stepIso, endedAt: nowIso(), wallMs: performance.now() - stepStarted }))
        continue
      }
      if (step.kind === 'act') {
        const action = resolveAction(step, observation, mode)
        firstAction = firstAction ?? action
        const acted = await invokeAct(runtime, context, session, observation, action, step.expected)
        const applied = applyAct(acted, traces, baseTrace, stepIso, stepStarted, action.type, observation, step.expected)
        if (acted.result.ok && acted.result.value.action?.artifacts) {
          for (const artifact of acted.result.value.action.artifacts) {
            if (artifact.displayName) downloads.push(artifact.displayName)
          }
        }
        if (acted.result.ok && acted.result.value.action?.observation) observation = acted.result.value.action.observation
        else if (!acted.result.ok) {
          const extra = await observe(runtime.tools, context, session.id, observation.tabId, mode).catch(() => undefined)
          if (extra) observation = extra.observation
        }
        void applied
      }
    }
    if (session && observation && task.support === 'unsupported' && task.script.length === 0) {
      traces.push(actionTrace({
        tool: 'browser_observe',
        outcome: 'unsupported-reported',
        dispatched: false,
        verifiedByGroundTruth: true
      }, { ...baseTrace, startedAt: nowIso(), endedAt: nowIso(), wallMs: 0 }))
    }
    const check = await task.verify({
      observation,
      submitCount: (path) => site.submitDelta(counters, path),
      downloadNames: downloads,
      frameSubmitCount: site.frameSubmitDelta(counters),
      actionOutcomes: traces,
      support: task.support
    })
    // A failed task does not make every preceding action a false success.
    // Only a verifier with evidence of a contradicted consequential effect
    // may set falseSuccess (for example an overlay click reaching the page).
    const falseSuccess = check.falseSuccess || traces.some((trace) => trace.falseSuccess)
    const duplicateEffect = check.duplicateEffect
    const actionSuccessCount = traces.filter((trace) => trace.support === 'supported' && (trace.outcome === 'verified' || trace.outcome === 'unverified') && !trace.falseSuccess).length
    let taskSuccess = check.ok
    if (task.support === 'unsupported') taskSuccess = check.ok
    if (session) await runtime.sessions.close(context, session.id).catch(() => undefined)
    return {
      taskId: task.id,
      trial,
      seed,
      split: task.split,
      support: task.support,
      category: task.category,
      observationMode: mode,
      driverKind: 'executor-script',
      mode: 'executor',
      startedAt,
      endedAt: nowIso(),
      wallMs: performance.now() - t0,
      taskSuccess,
      actionSuccessCount,
      actionCount: traces.length,
      falseSuccess,
      duplicateEffect,
      intervention,
      retries,
      recovery,
      unsupportedReported: task.support === 'unsupported' && check.ok,
      cost: UNAVAILABLE_COST,
      actions: traces,
      verifierNotes: check.notes
    }
  } catch (error) {
    if (session) await runtime.sessions.close(context, session.id).catch(() => undefined)
    return {
      taskId: task.id,
      trial,
      seed,
      split: task.split,
      support: task.support,
      category: task.category,
      observationMode: mode,
      driverKind: 'executor-script',
      mode: 'executor',
      startedAt,
      endedAt: nowIso(),
      wallMs: performance.now() - t0,
      taskSuccess: false,
      actionSuccessCount: traces.filter((trace) => trace.outcome === 'verified').length,
      actionCount: traces.length,
      falseSuccess: false,
      duplicateEffect: false,
      intervention,
      retries,
      recovery,
      unsupportedReported: false,
      cost: UNAVAILABLE_COST,
      actions: traces,
      verifierNotes: [error instanceof Error ? error.message : String(error)],
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

async function invokeAct(
  runtime: EvaluationRuntime,
  context: BrowserToolContext,
  session: BrowserSessionRecord,
  observation: BrowserObservation,
  action: BrowserAction,
  expected?: { type: string; text?: string; present?: boolean; includes?: string }
): Promise<{ result: BrowserToolResult; observationMs: number | null; overheadMs: number }> {
  const started = performance.now()
  const result = await runtime.tools.invoke('browser_act', {
    sessionId: session.id,
    tabId: observation.tabId,
    generation: observation.generation,
    observationId: observation.observationId,
    controlLeaseId: session.controlLeaseId,
    action,
    timeoutMs: 15_000,
    ...(expected ? { expected } : {})
  }, context)
  const wall = performance.now() - started
  return { result, observationMs: result.ok && result.value.action?.observation ? wall : null, overheadMs: wall }
}

function applyAct(
  acted: { result: BrowserToolResult; observationMs: number | null; overheadMs: number },
  traces: ActionTrace[],
  baseTrace: ActionTrace,
  stepIso: string,
  stepStarted: number,
  actionType: string,
  before: BrowserObservation,
  expected?: { type: string; text?: string; present?: boolean; includes?: string }
): ActionTrace {
  const result = acted.result
  const actionResult = result.ok ? result.value.action as BrowserActionResult | undefined : undefined
  const outcome = result.ok ? (actionResult?.outcome ?? 'unverified') : 'tool-error'
  const dispatched = Boolean(actionResult?.dispatched)
  const after = actionResult?.observation
  const changed = after ? haystack(after) !== haystack(before) || after.url !== before.url : dispatched
  const trace = actionTrace({
    tool: 'browser_act',
    actionType,
    outcome,
    dispatched,
    code: result.ok ? actionResult?.code : result.error.code,
    message: result.ok ? actionResult?.message : result.error.message,
    observationMs: acted.observationMs,
    executorOverheadMs: acted.overheadMs,
    verifiedByGroundTruth: expected ? (result.ok && actionResult?.outcome === 'verified') : null,
    falseSuccess: false
  }, { ...baseTrace, startedAt: stepIso, endedAt: nowIso(), wallMs: performance.now() - stepStarted })
  traces.push(trace)
  void changed
  return trace
}

async function runFormStress(runtime: EvaluationRuntime, site: EvaluationSite, cycles: number, seed: number): Promise<TaskTrialResult> {
  const task = evaluationCatalog().find((item) => item.id === 'forms.fill-save')!
  const startedAt = nowIso()
  const t0 = performance.now()
  const context = runtime.context(false, `stress-${seed}`)
  const traces: ActionTrace[] = []
  const opened = await runtime.tools.invoke('browser_open', { url: `${site.origin}/form.html` }, context)
  if (!opened.ok || !opened.value.session || !opened.value.observation) throw new Error('stress open failed')
  let session = opened.value.session as BrowserSessionRecord
  let observation = opened.value.observation
  let failures = 0
  for (let i = 0; i < cycles; i += 1) {
    const name = `Ada${i}`
    const fill: BrowserAction = { type: 'fill', target: { kind: 'ref', ref: findElement(observation, { name: 'Name', role: 'textbox' }).ref }, text: name }
    const filled = await invokeAct(runtime, context, session, observation, fill)
    applyAct(filled, traces, {
      taskId: 'forms.stress-cycles',
      trial: 0,
      seed,
      support: 'supported',
      observationMode: 'structured',
      driverKind: 'executor-script',
      startedAt: nowIso(),
      endedAt: nowIso(),
      wallMs: 0,
      observationMs: null,
      executorOverheadMs: null,
      outcome: 'skipped',
      dispatched: false,
      verifiedByGroundTruth: null,
      falseSuccess: false,
      duplicateEffect: false,
      intervention: false,
      retry: false,
      recovery: false,
      tool: 'browser_act'
    }, nowIso(), performance.now(), 'fill', observation)
    if (filled.result.ok && filled.result.value.action?.observation) observation = filled.result.value.action.observation
    const click: BrowserAction = { type: 'click', target: { kind: 'ref', ref: findElement(observation, { name: 'Save' }).ref } }
    const clicked = await invokeAct(runtime, context, session, observation, click, { type: 'text', text: `saved:${name}`, present: true })
    applyAct(clicked, traces, traces[traces.length - 1], nowIso(), performance.now(), 'click', observation)
    if (clicked.result.ok && clicked.result.value.action?.observation) observation = clicked.result.value.action.observation
    if (!haystack(observation).includes(`saved:${name}`)) failures += 1
  }
  await runtime.sessions.close(context, session.id).catch(() => undefined)
  const success = failures === 0
  return {
    taskId: 'forms.stress-cycles',
    trial: 0,
    seed,
    split: 'calibration',
    support: 'supported',
    category: 'forms',
    observationMode: 'structured',
    driverKind: 'executor-script',
    mode: 'executor',
    startedAt,
    endedAt: nowIso(),
    wallMs: performance.now() - t0,
    taskSuccess: success,
    actionSuccessCount: traces.filter((trace) => trace.outcome === 'verified' || trace.outcome === 'unverified').length,
    actionCount: traces.length,
    falseSuccess: false,
    duplicateEffect: false,
    intervention: false,
    retries: 0,
    recovery: false,
    unsupportedReported: false,
    cost: UNAVAILABLE_COST,
    actions: traces,
    verifierNotes: success ? [`${cycles} form cycles saved`] : [`${failures} form cycles failed`]
  }
}

export async function runBrowserGymSuite(input: {
  runtime: EvaluationRuntime
  site: EvaluationSite
  seed?: number
}): Promise<TaskTrialResult[]> {
  const seed = input.seed ?? 20260911
  const trials: TaskTrialResult[] = []
  const tasks = nativeGymTasks()
  const scripts: Record<string, string[]> = {
    'browsergym.native.form-fill': ["fill('Name', 'Ada')", "click('Save')"],
    'browsergym.native.open-shadow': ["fill('Shadow input', 'shadow-ok')", "click('Save shadow')"]
  }
  for (const [index, task] of tasks.entries()) {
    const startedAt = nowIso()
    const t0 = performance.now()
    try {
      const result = await runNativeBrowserGymTask({
        runtime: input.runtime,
        origin: input.site.origin,
        task,
        seed: seed + index,
        actions: scripts[task.id]
      })
      trials.push({
        taskId: task.id,
        trial: 0,
        seed: seed + index,
        split: task.split,
        support: 'supported',
        category: 'browsergym-adapter',
        observationMode: 'structured',
        driverKind: 'fixture-oracle',
        mode: 'browsergym',
        startedAt,
        endedAt: nowIso(),
        wallMs: performance.now() - t0,
        taskSuccess: result.reward === 1 && result.protocolKeys,
        actionSuccessCount: result.reward === 1 ? scripts[task.id].length : 0,
        actionCount: scripts[task.id].length,
        falseSuccess: false,
        duplicateEffect: false,
        intervention: false,
        retries: 0,
        recovery: false,
        unsupportedReported: false,
        cost: UNAVAILABLE_COST,
        actions: scripts[task.id].map((source) => ({
          taskId: task.id,
          trial: 0,
          seed: seed + index,
          support: 'supported' as const,
          observationMode: 'structured' as const,
          driverKind: 'fixture-oracle' as const,
          tool: 'browsergym.step',
          actionType: source,
          startedAt,
          endedAt: nowIso(),
          wallMs: 0,
          observationMs: null,
          executorOverheadMs: null,
          outcome: result.reward === 1 ? 'verified' as const : 'failed' as const,
          dispatched: true,
          verifiedByGroundTruth: result.reward === 1,
          falseSuccess: false,
          duplicateEffect: false,
          intervention: false,
          retry: false,
          recovery: false,
          message: result.lastError || undefined
        })),
        verifierNotes: [result.lastError || `reward=${result.reward} protocolKeys=${result.protocolKeys}`]
      })
    } catch (error) {
      trials.push({
        taskId: task.id,
        trial: 0,
        seed: seed + index,
        split: task.split,
        support: 'supported',
        category: 'browsergym-adapter',
        observationMode: 'structured',
        driverKind: 'fixture-oracle',
        mode: 'browsergym',
        startedAt,
        endedAt: nowIso(),
        wallMs: performance.now() - t0,
        taskSuccess: false,
        actionSuccessCount: 0,
        actionCount: 0,
        falseSuccess: false,
        duplicateEffect: false,
        intervention: false,
        retries: 0,
        recovery: false,
        unsupportedReported: false,
        cost: UNAVAILABLE_COST,
        actions: [],
        verifierNotes: [error instanceof Error ? error.message : String(error)],
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }
  return trials
}

export function liveModelRefusalTrial(): TaskTrialResult {
  const startedAt = nowIso()
  return {
    taskId: 'live-model.refused',
    trial: 0,
    seed: 0,
    split: 'held-out',
    support: 'unsupported',
    category: 'model-quality',
    observationMode: 'hybrid',
    driverKind: 'live-model',
    mode: 'live-model',
    startedAt,
    endedAt: nowIso(),
    wallMs: 0,
    taskSuccess: false,
    actionSuccessCount: 0,
    actionCount: 0,
    falseSuccess: false,
    duplicateEffect: false,
    intervention: false,
    retries: 0,
    recovery: false,
    unsupportedReported: true,
    cost: UNAVAILABLE_COST,
    actions: [],
    verifierNotes: ['Live-model quality is unavailable in this Q03 run; no paid calls were placed.']
  }
}

export function buildReport(input: {
  trials: TaskTrialResult[]
  chrome: { source: string; version: string; sha256: string }
  seed: number
}): Omit<EvaluationReport, 'metrics'> {
  const probe = probeBrowserGymPython()
  const live = input.trials.some((trial) => trial.driverKind === 'live-model' && trial.mode === 'live-model' && trial.taskId !== 'live-model.refused')
  return {
    kind: 'mousse-browser-evaluation',
    qualification: 'Q03',
    requirement: 'BR-02',
    runKind: live ? 'live-model' : 'fixture-only',
    modelQuality: live ? 'measured' : 'unavailable',
    pin: buildPin({
      browserVersion: input.chrome.version,
      browserSha256: input.chrome.sha256,
      taskSeed: input.seed,
      budgets: DEFAULT_BUDGETS
    }),
    generatedAt: nowIso(),
    chromeSource: input.chrome.source,
    chromeMutated: false,
    externalBenchmark: {
      protocol: 'browsergym-core-0.14.3',
      adapterImplemented: true,
      fullEnvironmentAvailable: probe.available,
      missing: probe.missing,
      externalRunCommand: probe.externalRunCommand.length ? probe.externalRunCommand : BROWSERGYM_EXTERNAL_RUN_COMMAND,
      nativeFixtureScoreClaimed: false,
      note: 'Native fixture adapter results are not a BrowserGym MiniWoB/WebArena leaderboard score.'
    },
    trials: input.trials
  }
}
