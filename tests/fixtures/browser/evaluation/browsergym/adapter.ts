import type { BrowserObservation, BrowserSessionRecord } from '../../../../../src/shared/browser/types'
import type { BrowserToolContext } from '../../../../../src/shared/browser/automation'
import type { EvaluationRuntime } from '../runtime'
import { observe } from '../observations'
import type { ObservationMode } from '../types'
import { parseBrowserGymActions } from './parse'
import { mapBrowserGymCall, toBrowserGymObservation, observationHasProtocolKeys } from './map'
import type { BrowserGymObservation } from './protocol'
import { probeBrowserGymPython } from './environment'

export interface NativeGymTask {
  id: string
  goal: string
  startPath: string
  split: 'calibration' | 'held-out'
  validate: (observation: BrowserObservation) => { reward: number; done: boolean; message: string }
}

export interface BrowserGymStepResult {
  obs: BrowserGymObservation
  reward: number
  terminated: boolean
  truncated: boolean
  info: {
    last_action: string
    last_action_error: string
    mapped: unknown
    protocolKeys: boolean
    executor: 'mousse-browser-tool-dispatcher'
  }
}

export class MousseBrowserGymAdapter {
  private observation: BrowserObservation | undefined
  private session: BrowserSessionRecord | undefined
  private lastAction = ''
  private lastError = ''
  private startedAt = Date.now()
  private task: NativeGymTask | undefined
  private executionContext: BrowserToolContext | undefined
  readonly external = probeBrowserGymPython()

  constructor(
    private readonly runtime: EvaluationRuntime,
    private readonly origin: string,
    private readonly mode: ObservationMode
  ) {}

  async reset(task: NativeGymTask, seed: number): Promise<{ obs: BrowserGymObservation; info: { seed: number; taskId: string } }> {
    await this.close()
    this.task = task
    this.startedAt = Date.now()
    this.lastAction = ''
    this.lastError = ''
    const context = this.runtime.context(this.mode !== 'structured', `bgym-${task.id}-${seed}`)
    this.executionContext = context
    const opened = await this.runtime.tools.invoke('browser_open', { url: `${this.origin}${task.startPath}` }, context)
    if (!opened.ok || !opened.value.session || !opened.value.observation) {
      throw new Error(`BrowserGym adapter failed to open: ${JSON.stringify(opened)}`)
    }
    this.session = opened.value.session as BrowserSessionRecord
    this.observation = opened.value.observation
    return { obs: this.gymObs(), info: { seed, taskId: task.id } }
  }

  async step(action: string): Promise<BrowserGymStepResult> {
    if (!this.session || !this.observation || !this.task) throw new Error('reset() required')
    this.lastAction = action
    this.lastError = ''
    const context = this.context()
    const mapped = []
    try {
      const calls = parseBrowserGymActions(action)
      for (const call of calls) {
        const op = mapBrowserGymCall(call, this.observation, this.mode)
        mapped.push(op)
        if (op.kind === 'unsupported') {
          this.lastError = op.reason
          break
        }
        if (op.kind === 'stop' || op.kind === 'infeasible') {
          const obs = this.gymObs()
          return {
            obs,
            reward: op.kind === 'infeasible' ? 0 : this.task.validate(this.observation).reward,
            terminated: true,
            truncated: false,
            info: { last_action: action, last_action_error: this.lastError, mapped, protocolKeys: observationHasProtocolKeys(obs), executor: 'mousse-browser-tool-dispatcher' }
          }
        }
        if (op.kind === 'noop') continue
        if (op.kind === 'tabs') {
          const tabs = await this.runtime.tools.invoke('browser_tabs', {
            sessionId: this.session.id,
            operation: op.operation,
            ...(op.operation === 'new' && op.url ? { url: op.url } : {}),
            ...(op.operation === 'switch' && this.observation.tabs[op.index ?? 0] ? { tabId: this.observation.tabs[op.index ?? 0].id } : {})
          }, context)
          if (!tabs.ok) this.lastError = tabs.error.message
        } else {
          const acted = await this.runtime.tools.invoke('browser_act', {
            sessionId: this.session.id,
            tabId: this.observation.tabId,
            generation: this.observation.generation,
            observationId: this.observation.observationId,
            controlLeaseId: this.session.controlLeaseId,
            action: op.action
          }, context)
          if (!acted.ok) this.lastError = acted.error.message
          else if (acted.value.action?.observation) this.observation = acted.value.action.observation
        }
      }
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error)
    }
    const fresh = await observe(this.runtime.tools, context, this.session.id, this.observation.tabId, this.mode)
    this.observation = fresh.observation
    const verdict = this.task.validate(this.observation)
    const obs = this.gymObs()
    return {
      obs,
      reward: verdict.reward,
      terminated: verdict.done || Boolean(this.lastError),
      truncated: false,
      info: { last_action: action, last_action_error: this.lastError, mapped, protocolKeys: observationHasProtocolKeys(obs), executor: 'mousse-browser-tool-dispatcher' }
    }
  }

  async close(): Promise<void> {
    if (!this.session) return
    const context = this.context()
    await this.runtime.sessions.close(context, this.session.id).catch(() => undefined)
    this.session = undefined
    this.observation = undefined
    this.executionContext = undefined
  }

  private context(): BrowserToolContext {
    if (!this.executionContext) throw new Error('reset() required')
    return this.executionContext
  }

  private gymObs(): BrowserGymObservation {
    if (!this.observation || !this.task) throw new Error('no observation')
    return toBrowserGymObservation({
      observation: this.observation,
      goal: this.task.goal,
      lastAction: this.lastAction,
      lastActionError: this.lastError,
      startedAt: this.startedAt
    })
  }
}

export function nativeGymTasks(): NativeGymTask[] {
  return [
    {
      id: 'browsergym.native.form-fill',
      goal: 'Fill the name field with Ada and save the account form.',
      startPath: '/form.html',
      split: 'calibration',
      validate: (observation) => {
        const text = observation.elements.map((el) => `${el.name ?? ''} ${el.text ?? ''}`).join(' ')
        const done = text.includes('saved:Ada')
        return { reward: done ? 1 : 0, done, message: done ? 'form saved' : 'form not saved' }
      }
    },
    {
      id: 'browsergym.native.open-shadow',
      goal: 'Type shadow-ok into the open shadow input and save.',
      startPath: '/shadow.html',
      split: 'held-out',
      validate: (observation) => {
        const text = observation.elements.map((el) => `${el.name ?? ''} ${el.text ?? ''}`).join(' ')
        const done = text.includes('shadow-saved:shadow-ok')
        return { reward: done ? 1 : 0, done, message: done ? 'shadow saved' : 'shadow not saved' }
      }
    }
  ]
}

export async function runNativeBrowserGymTask(input: {
  runtime: EvaluationRuntime
  origin: string
  task: NativeGymTask
  seed: number
  actions: string[]
  mode?: ObservationMode
}): Promise<{ reward: number; terminated: boolean; protocolKeys: boolean; lastError: string; obs: BrowserGymObservation }> {
  const adapter = new MousseBrowserGymAdapter(input.runtime, input.origin, input.mode ?? 'structured')
  await adapter.reset(input.task, input.seed)
  let last: BrowserGymStepResult | undefined
  for (const action of input.actions) {
    last = await adapter.step(action)
    if (last.terminated || last.truncated) break
  }
  await adapter.close()
  if (!last) throw new Error('no step')
  return { reward: last.reward, terminated: last.terminated, protocolKeys: last.info.protocolKeys, lastError: last.info.last_action_error, obs: last.obs }
}
