import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { ExecutionContext, ExecutionPolicySnapshot } from '../src/shared/execution/types'
import type { BrowserModelAction, BrowserModelCall } from '../src/shared/browser/modelAdapters'
import type { BrowserObservation, BrowserSessionRecord } from '../src/shared/browser/types'
import { anthropicComputerAdapter, browserModelCapabilities, executeOrderedCall, getBrowserModelCapability, googleComputerAdapter, openAiComputerAdapter } from '../src/mms/browser/modelAdapters'
import { BrowserSessionManager } from '../src/mms/browser/automation/BrowserSessionManager'
import { BrowserToolDispatcher } from '../src/mms/browser/automation/BrowserToolDispatcher'
import { ensureManagedChrome, startFixtureSite, createInProcessBroker } from './fixtures/browser/harness'
import { anthropicClickEnvelope, geminiClickEnvelope, openAiClickEnvelope } from './fixtures/browser/model-adapter-envelopes'

const chrome = await ensureManagedChrome()
let origin = ''
let submitCount = () => 0
let closeSite: () => Promise<void> = async () => undefined
const brokers: Array<{ close(): Promise<void> }> = []
const managers: Array<{ closeAll(): Promise<void> }> = []

beforeAll(async () => {
  if (!chrome.ok) return
  const site = await startFixtureSite()
  origin = site.origin
  submitCount = site.submitCount
  closeSite = site.close
}, 120_000)

afterEach(async () => {
  while (managers.length) await managers.pop()!.closeAll()
  while (brokers.length) await brokers.pop()!.close()
})

afterAll(async () => { await closeSite() })

const policy = (profileId: string): ExecutionPolicySnapshot => ({
  id: `policy-${profileId}`, profileId, version: 1,
  allowedTools: ['browser_open', 'browser_observe', 'browser_act'],
  allowedCapabilities: ['browser.session', 'browser.observe', 'browser.action'],
  allowedEffects: ['read', 'write', 'external'], approvalEffects: [],
  maxToolCalls: 40, maxElapsedMs: 60_000, maxArtifactBytes: 10_000_000
})

function context(profileId: string, vision = true): { execution: ExecutionContext; policy: ExecutionPolicySnapshot; vision: boolean } {
  const currentPolicy = policy(profileId)
  return {
    execution: { profileId, threadId: 'thread-model', turnId: 'turn-model', actor: { kind: 'workflow' }, policySnapshotId: currentPolicy.id, source: 'cli', cancellationId: 'cancel-model' },
    policy: currentPolicy,
    vision
  }
}

function observation(value: unknown): BrowserObservation {
  const output = value as { observation?: BrowserObservation }
  if (!output.observation) throw new Error('missing browser observation')
  return output.observation
}

describe('M03 browser model adapters', () => {
  it('decodes and encodes provider-native envelopes with call IDs, safety, coordinates, and continuation state', () => {
    expect(openAiComputerAdapter.buildRequest({ model: 'computer-use-preview', prompt: 'test', viewport: { width: 1200, height: 800 } })).toMatchObject({ tools: [{ type: 'computer-preview', environment: 'browser', display_width: 1200, display_height: 800 }] })
    expect(anthropicComputerAdapter.buildRequest({ model: 'claude-sonnet-4-6', prompt: 'test', viewport: { width: 1200, height: 800 } })).toMatchObject({ tools: [{ type: 'computer_20251124', name: 'computer', display_width_px: 1200, display_height_px: 800 }] })
    expect(googleComputerAdapter.buildRequest({ model: 'gemini-3.8-flash', prompt: 'test', enablePromptInjectionDetection: true })).toMatchObject({ tools: [{ type: 'computer_use', environment: 'browser', enable_prompt_injection_detection: true }] })
    const openAi = openAiComputerAdapter.decodeResponse({ ...openAiClickEnvelope(320, 240), id: 'resp_1', output: [{ ...openAiClickEnvelope(320, 240).output[0], call_id: 'call_1', pending_safety_checks: [{ id: 'safety_1', code: 'external_effect', message: 'Confirm submit' }], actions: [{ type: 'click', button: 'left', x: 320, y: 240 }, { type: 'type', text: 'Ada' }] }] })!
    expect(openAi.callId).toBe('call_1')
    expect(openAi.actions[0]).toMatchObject({ kind: 'action', safety: { decision: 'require_confirmation', id: 'safety_1' }, action: { target: { point: { x: 320, y: 240 } } } })
    expect(openAi.continuation?.responseId).toBe('resp_1')
    expect(openAiComputerAdapter.encodeResult(openAi, { outcome: 'verified', screenshot: { dataUrl: 'data:image/png;base64,AAAA', mediaType: 'image/png' } }, { provider: 'openai', callId: 'call_1', responseId: 'resp_1', acknowledgedSafetyCheckIds: ['safety_1'] })).toMatchObject({ type: 'computer_call_output', call_id: 'call_1', acknowledged_safety_checks: [{ id: 'safety_1' }] })

    const anthropic = anthropicComputerAdapter.decodeResponse({ ...anthropicClickEnvelope(120, 80), content: [{ ...anthropicClickEnvelope(120, 80).content[0], id: 'toolu_1' }] })!
    expect(anthropic.actions[0]).toMatchObject({ kind: 'action', action: { type: 'click', target: { point: { x: 120, y: 80 } } } })
    // Anthropic's public schema is an array coordinate; the adapter accepts that shape explicitly.
    expect((anthropic.actions[0] as { kind: 'action'; action: { target: { point: { x: number; y: number } } } }).action.target.point).toEqual({ x: 120, y: 80 })
  })

  it('scales Gemini 1000x1000 coordinates and carries safety acknowledgement in function_result', () => {
    const call = googleComputerAdapter.decodeResponse({ ...geminiClickEnvelope(500, 250, 'require_confirmation'), id: 'interaction_1', steps: [{ ...geminiClickEnvelope(500, 250, 'require_confirmation').steps[0], id: 'fn_1', arguments: { x: 500, y: 250, safety_decision: { decision: 'require_confirmation', explanation: 'Confirm' } } }] }, { viewport: { width: 1200, height: 800 } })!
    expect(call.callId).toBe('fn_1')
    expect(call.actions[0]).toMatchObject({ action: { target: { point: { x: 600, y: 200 } } }, safety: { decision: 'require_confirmation' } })
    expect(googleComputerAdapter.encodeResult(call, { outcome: 'verified', safetyAcknowledgement: true, screenshot: { dataUrl: 'data:image/png;base64,AAAA', mediaType: 'image/png' } })).toMatchObject({ type: 'function_result', call_id: 'fn_1', result: [{ type: 'text' }, { type: 'image' }, { type: 'text' }] })
  })

  it('stops an ordered native batch before the second effect on approval, failure, unknown effect, or cancellation', async () => {
    const call: BrowserModelCall = { provider: 'openai', callId: 'ordered', actions: [{ kind: 'action', action: { type: 'back' } }, { kind: 'action', action: { type: 'forward' } }], safetyDecisions: [] }
    const invoked: BrowserModelAction[] = []
    const stopped = await executeOrderedCall(call, {}, {}, async (action) => { invoked.push(action); return { outcome: 'failed', message: 'fixture failure' } })
    expect(invoked).toHaveLength(1)
    expect(stopped.stoppedBecause).toBe('failure')

    invoked.length = 0
    const unknown = await executeOrderedCall(call, {}, {}, async (action) => { invoked.push(action); return { outcome: 'unknown-effect', message: 'fixture uncertain' } })
    expect(invoked).toHaveLength(1)
    expect(unknown.stoppedBecause).toBe('unknown-effect')

    const approvalCall: BrowserModelCall = { ...call, actions: [{ kind: 'action', action: { type: 'back' }, safety: { decision: 'require_confirmation', explanation: 'Confirm' } }, call.actions[1]] }
    invoked.length = 0
    const approval = await executeOrderedCall(approvalCall, {}, {}, async (action) => { invoked.push(action); return { outcome: 'verified' } })
    expect(invoked).toHaveLength(0)
    expect(approval.stoppedBecause).toBe('approval')

    const controller = new AbortController()
    invoked.length = 0
    const cancelled = await executeOrderedCall(call, {}, {}, async (action) => { invoked.push(action); controller.abort('fixture cancellation'); return { outcome: 'verified' } }, controller.signal)
    expect(invoked).toHaveLength(1)
    expect(cancelled.stoppedBecause).toBe('cancelled')
  })

  it('runs an OpenAI native click through the real managed Chromium M01 executor exactly once', async () => {
    if (!chrome.ok) return
    const { broker, roots } = await createInProcessBroker()
    brokers.push(broker)
    const manager = new BrowserSessionManager({ profileId: 'profile-model', profileRoot: roots.profileRoot, broker })
    managers.push(manager)
    const tools = new BrowserToolDispatcher({ sessions: manager })
    const owner = context('profile-model', true)
    const opened = await tools.invoke('browser_open', { url: `${origin}/submit-once.html` }, owner)
    expect(opened.ok, JSON.stringify(opened)).toBe(true)
    const session = opened.ok ? opened.value.session as BrowserSessionRecord : undefined
    const first = observation(opened.ok ? opened.value : {})
    const fresh = await tools.invoke('browser_observe', { sessionId: session!.id, tabId: first.tabId, includeScreenshot: true }, owner)
    expect(fresh.ok, JSON.stringify(fresh)).toBe(true)
    const current = observation(fresh.ok ? fresh.value : {})
    const button = current.elements.find((element) => (element.name ?? '').toLowerCase().includes('submit'))
    expect(button?.bounds).toBeTruthy()
    expect(current.screenshot).toBeTruthy()
    const crop = current.screenshot?.cropOriginCss ?? { x: 0, y: 0 }
    const bounds = button!.bounds!
    const point = { x: Math.floor((bounds.x + bounds.width / 2 - crop.x) * (current.screenshot?.cssToImageScaleX ?? 1)), y: Math.floor((bounds.y + bounds.height / 2 - crop.y) * (current.screenshot?.cssToImageScaleY ?? 1)) }
    const response = { ...openAiClickEnvelope(point.x, point.y), id: 'resp-real', output: [{ ...openAiClickEnvelope(point.x, point.y).output[0], call_id: 'call-real' }] }
    const call = openAiComputerAdapter.decodeResponse(response)!
    const execution = await executeOrderedCall(call, openAiComputerAdapter.buildRequest({ model: 'computer-use-preview', prompt: 'Submit once', observation: current }), response, async (item) => {
      if (item.kind !== 'action') return { outcome: 'unverified', message: 'Fixture only executes browser actions' }
      const invoked = await tools.invoke('browser_act', { sessionId: session!.id, tabId: current.tabId, generation: current.generation, observationId: current.observationId, controlLeaseId: session!.controlLeaseId, action: item.action }, owner)
      if (!invoked.ok) return { outcome: 'failed', message: invoked.error.message }
      return { outcome: invoked.value.action?.outcome ?? 'verified' }
    }, undefined, openAiComputerAdapter.encodeResult, call.continuation)
    expect(execution.results).toHaveLength(1)
    expect(execution.results[0].outcome).toBe('verified')
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(submitCount()).toBe(1)
    const result = await tools.invoke('browser_observe', { sessionId: session!.id, tabId: current.tabId }, owner)
    expect(result.ok).toBe(true)
    // The fixture server increments once for the click; the native batch contains one action, so replay is impossible in this loop.
    const encoded = execution.encodedResult as { type?: string; call_id?: string }
    expect(encoded).toMatchObject({ type: 'computer_call_output', call_id: 'call-real' })
  }, 120_000)
})

describe('M03 capability catalog', () => {
  it('publishes honest B0 through B3 records and hides unknown models', () => {
    expect(browserModelCapabilities.some((item) => item.tier === 'B1' && item.availability === 'available')).toBe(true)
    expect(browserModelCapabilities.some((item) => item.tier === 'B2')).toBe(true)
    expect(browserModelCapabilities.some((item) => item.tier === 'B3' && item.availability === 'experimental')).toBe(true)
    expect(getBrowserModelCapability('google', 'unknown-model').tier).toBe('B0')
    expect(getBrowserModelCapability('google', 'unknown-model').availability).toBe('unavailable')
  })
})
