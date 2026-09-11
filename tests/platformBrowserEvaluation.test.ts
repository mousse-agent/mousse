import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { BROWSER_CONTRACT_VERSION } from '../src/shared/browser/types'
import { BrowserToolDispatcher } from '../src/mms/browser/automation/BrowserToolDispatcher'
import {
  actionSucceeded,
  computeMetrics,
  createEvaluationRuntime,
  createLiveModelDriver,
  createHttpModelDriver,
  inspectChromeSource,
  mapBrowserGymCall,
  observationHasProtocolKeys,
  parseBrowserGymActions,
  probeBrowserGymPython,
  runNativeBrowserGymTask,
  nativeGymTasks,
  observationForModel,
  startEvaluationSite,
  SIBLING_CORE_BROWSER_ROOT,
  UNAVAILABLE_COST,
  wilsonInterval
} from './fixtures/browser/evaluation'
import { toBrowserGymObservation } from './fixtures/browser/evaluation/browsergym/map'
import { DEFAULT_BUDGETS } from './fixtures/browser/evaluation/pin'
import { haystack } from './fixtures/browser/evaluation/observations'
import type { ActionTrace, TaskTrialResult } from './fixtures/browser/evaluation/types'

const chrome = inspectChromeSource()

function trial(partial: Partial<TaskTrialResult> & Pick<TaskTrialResult, 'taskId' | 'taskSuccess' | 'actions'>): TaskTrialResult {
  return {
    trial: 0,
    seed: 1,
    split: 'calibration',
    support: 'supported',
    category: 'test',
    observationMode: 'structured',
    driverKind: 'executor-script',
    mode: 'executor',
    startedAt: '2026-09-11T00:00:00.000Z',
    endedAt: '2026-09-11T00:00:01.000Z',
    wallMs: 10,
    actionSuccessCount: 0,
    actionCount: partial.actions.length,
    falseSuccess: false,
    duplicateEffect: false,
    intervention: false,
    retries: 0,
    recovery: false,
    unsupportedReported: false,
    cost: UNAVAILABLE_COST,
    verifierNotes: [],
    ...partial
  }
}

function action(partial: Partial<ActionTrace>): ActionTrace {
  return {
    taskId: 't',
    trial: 0,
    seed: 1,
    support: 'supported',
    observationMode: 'structured',
    driverKind: 'executor-script',
    tool: 'browser_act',
    startedAt: '2026-09-11T00:00:00.000Z',
    endedAt: '2026-09-11T00:00:00.100Z',
    wallMs: 100,
    observationMs: 40,
    executorOverheadMs: 60,
    outcome: 'verified',
    dispatched: true,
    verifiedByGroundTruth: true,
    falseSuccess: false,
    duplicateEffect: false,
    intervention: false,
    retry: false,
    recovery: false,
    ...partial
  }
}

describe('Q03 evaluation metrics against known traces', () => {
  it('does not report a 0% interval when there are no trials', () => {
    const empty = wilsonInterval(0, 0)
    expect(empty).toMatchObject({ status: 'undefined' })
  })

  it('flags false-success when a verified action fails ground truth', () => {
    const metrics = computeMetrics([
      trial({
        taskId: 'false-success',
        taskSuccess: false,
        falseSuccess: true,
        actions: [action({ falseSuccess: true, verifiedByGroundTruth: false })]
      })
    ], { maxRssBytes: 1, maxHeapBytes: 1, chromeMemoryBytes: null, chromeMemoryStatus: 'unavailable' })
    expect(metrics.executor.falseSuccessCount).toBe(1)
    expect(metrics.gates.falseSuccessMet).toBe(false)
    expect(actionSucceeded(action({ falseSuccess: true }))).toBe(false)
  })

  it('flags duplicate consequential effects separately from success', () => {
    const metrics = computeMetrics([
      trial({
        taskId: 'duplicate',
        taskSuccess: false,
        duplicateEffect: true,
        actions: [action({ duplicateEffect: true }), action({ duplicateEffect: true })]
      })
    ], { maxRssBytes: 1, maxHeapBytes: 1, chromeMemoryBytes: null, chromeMemoryStatus: 'unavailable' })
    expect(metrics.executor.duplicateEffectCount).toBe(1)
    expect(metrics.gates.duplicateMet).toBe(false)
  })

  it('never stores token/image cost as 0 when a model did not run', () => {
    expect(UNAVAILABLE_COST.tokens).toBeNull()
    expect(UNAVAILABLE_COST.images).toBeNull()
    expect(UNAVAILABLE_COST.status).toBe('unavailable')
    const metrics = computeMetrics([trial({ taskId: 'cost', taskSuccess: true, actions: [action({})] })], {
      maxRssBytes: 1, maxHeapBytes: 1, chromeMemoryBytes: null, chromeMemoryStatus: 'unavailable'
    })
    expect(metrics.cost.tokens).toBeNull()
    expect(metrics.cost.images).toBeNull()
    expect(metrics.cost.status).toBe('unavailable')
  })

  it('keeps unsupported cases out of the supported-action denominator', () => {
    const metrics = computeMetrics([
      trial({
        taskId: 'closed-shadow',
        support: 'unsupported',
        taskSuccess: true,
        unsupportedReported: true,
        actions: [action({ support: 'unsupported', outcome: 'unsupported-reported', dispatched: false })]
      }),
      trial({
        taskId: 'form',
        taskSuccess: true,
        actions: [action({}), action({})]
      })
    ], { maxRssBytes: 1, maxHeapBytes: 1, chromeMemoryBytes: null, chromeMemoryStatus: 'unavailable' })
    const interval = metrics.executor.supportedActionSuccess
    expect(interval.status === 'undefined' ? 0 : interval.n).toBe(2)
  })
})

describe('BrowserGym protocol adapter boundary', () => {
  it('parses pinned high-level actions and maps them to Mousse actions without Python eval', () => {
    const calls = parseBrowserGymActions("fill('a12', \"Ada\")\nclick('b9', button=\"left\")\ngoto('http://127.0.0.1/form.html')")
    expect(calls.map((call) => call.name)).toEqual(['fill', 'click', 'goto'])
    const observation = {
      sessionId: 's', tabId: 't', generation: 1, observationId: 'o', documentId: 'd', capturedAt: '2026-09-11T00:00:00.000Z',
      url: 'http://127.0.0.1/form.html', title: 'Fixture Form',
      viewport: { cssWidth: 800, cssHeight: 600, deviceScaleFactor: 1, scrollX: 0, scrollY: 0 },
      tabs: [{ id: 't', title: 'Fixture Form', url: 'http://127.0.0.1/form.html' }],
      elements: [
        { ref: 'a12', frameRef: 'f', role: 'textbox', name: 'Name', text: '', states: [] },
        { ref: 'b9', frameRef: 'f', role: 'button', name: 'Save', text: 'Save', states: [] }
      ],
      truncated: false, warnings: [], provenance: 'untrusted-page' as const
    }
    expect(mapBrowserGymCall(calls[0], observation, 'structured')).toEqual({
      kind: 'act', action: { type: 'fill', target: { kind: 'ref', ref: 'a12' }, text: 'Ada' }
    })
    expect(mapBrowserGymCall(calls[1], observation, 'structured')).toMatchObject({
      kind: 'act', action: { type: 'click', target: { kind: 'ref', ref: 'b9' } }
    })
    const gym = toBrowserGymObservation({ observation, goal: 'save', lastAction: "click('b9')", lastActionError: '', startedAt: Date.now() })
    expect(observationHasProtocolKeys(gym)).toBe(true)
  })

  it('refuses Python/code actions and unmapped primitives instead of executing them', () => {
    expect(() => parseBrowserGymActions('page.click("x")')).toThrow(/Invalid action type|not a high-level action|Invalid action/)
    const observation = {
      sessionId: 's', tabId: 't', generation: 1, observationId: 'o', documentId: 'd', capturedAt: '2026-09-11T00:00:00.000Z',
      url: 'http://127.0.0.1/', title: 't',
      viewport: { cssWidth: 800, cssHeight: 600, deviceScaleFactor: 1, scrollX: 0, scrollY: 0 },
      tabs: [{ id: 't', title: 't', url: 'http://127.0.0.1/' }],
      elements: [], truncated: false, warnings: [], provenance: 'untrusted-page' as const
    }
    const focus = parseBrowserGymActions('focus("a1")')[0]
    expect(mapBrowserGymCall(focus, observation, 'structured').kind).toBe('unsupported')
  })

  it('documents the missing full BrowserGym environment instead of inventing a leaderboard score', () => {
    const probe = probeBrowserGymPython()
    expect(probe.available).toBe(false)
    expect(probe.missing.length).toBeGreaterThan(0)
    expect(probe.externalRunCommand.some((line) => line.includes('browsergym-core==0.14.3'))).toBe(true)
  })

  it('keeps live-model and fixture-oracle labels distinct', async () => {
    const driver = createLiveModelDriver({ modelId: 'unspecified', revision: 'none', budgets: DEFAULT_BUDGETS })
    expect(driver.kind).toBe('live-model')
    const decision = await driver.decide({
      taskId: 'x',
      goal: 'g',
      observation: {
        sessionId: 's', tabId: 't', generation: 1, observationId: 'o', documentId: 'd', capturedAt: '2026-09-11T00:00:00.000Z',
        url: 'http://127.0.0.1/', title: 't',
        viewport: { cssWidth: 800, cssHeight: 600, deviceScaleFactor: 1, scrollX: 0, scrollY: 0 },
        tabs: [{ id: 't', title: 't', url: 'http://127.0.0.1/' }],
        elements: [], truncated: false, warnings: [], provenance: 'untrusted-page'
      },
      stepIndex: 0
    })
    expect(decision.kind).toBe('unavailable')
    expect(driver.cost().tokens).toBeNull()
  })

  it('executes strict JSON decisions through an injectable model endpoint and records usage', async () => {
    const observation = {
      sessionId: 's', tabId: 't', generation: 1, observationId: 'o', documentId: 'd', capturedAt: '2026-09-11T00:00:00.000Z',
      url: 'http://127.0.0.1/', title: 't', viewport: { cssWidth: 800, cssHeight: 600, deviceScaleFactor: 1, scrollX: 0, scrollY: 0 },
      tabs: [{ id: 't', title: 't', url: 'http://127.0.0.1/' }], elements: [], truncated: false, warnings: [], provenance: 'untrusted-page' as const
    }
    const driver = createHttpModelDriver({
      endpoint: 'http://model.test/decision', modelId: 'local-fixture', revision: 'rev-1', budgets: DEFAULT_BUDGETS,
      fetchImpl: async () => new Response(JSON.stringify({
        decision: { kind: 'act', action: { type: 'click', target: { kind: 'ref', ref: 'a1' } } },
        usage: { input_tokens: 12, output_tokens: 4, images: 1 }
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    const decision = await driver.decide({ taskId: 't', goal: 'click', observation, stepIndex: 0 })
    expect(decision).toMatchObject({ kind: 'act', action: { type: 'click', target: { kind: 'ref', ref: 'a1' } } })
    expect(driver.cost()).toMatchObject({ status: 'measured', tokens: 16, images: 1 })

    const invalid = createHttpModelDriver({
      endpoint: 'http://model.test/invalid', modelId: 'local-fixture', revision: 'rev-1', budgets: DEFAULT_BUDGETS,
      fetchImpl: async () => new Response(JSON.stringify({ kind: 'act', extra: true, action: { type: 'reload' } }), { status: 200 })
    })
    await expect(invalid.decide({ taskId: 't', goal: 'reload', observation, stepIndex: 0 })).rejects.toThrow(/unsupported field extra/)
  })

  it('uses a real local HTTP model exchange without leaking semantic refs in screenshot-only input', async () => {
    let received: Record<string, any> | undefined
    const server = createServer((request, response) => {
      let body = ''
      request.setEncoding('utf8')
      request.on('data', (chunk) => { body += chunk })
      request.on('end', () => {
        received = JSON.parse(body)
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({
          decision: { kind: 'act', action: { type: 'click', target: { kind: 'image-point', point: { x: 10, y: 20 } } } },
          usage: { input_tokens: 8, output_tokens: 3, images: 1 }
        }))
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const observation = {
        sessionId: 's', tabId: 't', generation: 1, observationId: 'o', documentId: 'd', capturedAt: '2026-09-11T00:00:00.000Z',
        url: 'http://secret.invalid/account', title: 'Secret account', viewport: { cssWidth: 800, cssHeight: 600, deviceScaleFactor: 1, scrollX: 0, scrollY: 0 },
        tabs: [{ id: 't', title: 'Secret account', url: 'http://secret.invalid/account' }],
        elements: [{ ref: 'secret-ref', frameRef: 'main', role: 'button', name: 'Delete account', states: [] }],
        screenshot: { artifactId: 'image-artifact', pixelWidth: 800, pixelHeight: 600, cssToImageScaleX: 1, cssToImageScaleY: 1 },
        truncated: false, warnings: ['semantic warning'], provenance: 'untrusted-page' as const
      }
      const driver = createHttpModelDriver({
        endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}/decision`,
        modelId: 'local-http-fixture', revision: 'sha256:fixture-rev', budgets: DEFAULT_BUDGETS
      })
      const decision = await driver.decide({
        taskId: 'screenshot', goal: 'click the visible control',
        observation: observationForModel(observation, 'screenshot'), stepIndex: 0
      })
      expect(decision).toMatchObject({ kind: 'act', action: { target: { kind: 'image-point' } } })
      expect(received?.model).toBe('local-http-fixture')
      expect(received?.revision).toBe('sha256:fixture-rev')
      expect(received?.observation.screenshot.artifactId).toBe('image-artifact')
      expect(received?.observation.elements).toEqual([])
      expect(received?.observation.tabs).toEqual([])
      expect(JSON.stringify(received?.observation)).not.toMatch(/secret-ref|Delete account|secret\.invalid|Secret account|semantic warning/)
      expect(driver.cost()).toMatchObject({ status: 'measured', tokens: 11, images: 1 })
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    }
  })

  it('stops before dispatch when cumulative model usage exceeds pinned budgets', async () => {
    const budgets = { ...DEFAULT_BUDGETS, maxTokens: 5, maxImages: 0 }
    const driver = createHttpModelDriver({
      endpoint: 'http://model.test/budget', modelId: 'fixture', revision: 'rev', budgets,
      fetchImpl: async () => new Response(JSON.stringify({
        decision: { kind: 'act', action: { type: 'reload' } },
        usage: { input_tokens: 4, output_tokens: 2, images: 0 }
      }))
    })
    const observation = {
      sessionId: 's', tabId: 't', generation: 1, observationId: 'o', documentId: 'd', capturedAt: '2026-09-11T00:00:00.000Z',
      url: '', title: '', viewport: { cssWidth: 800, cssHeight: 600, deviceScaleFactor: 1, scrollX: 0, scrollY: 0 },
      tabs: [], elements: [], truncated: false, warnings: [], provenance: 'untrusted-page' as const
    }
    await expect(driver.decide({ taskId: 't', goal: 'g', observation, stepIndex: 0 })).resolves.toEqual({
      kind: 'stop', reason: 'model token budget exhausted'
    })
  })
})

describe.skipIf(!chrome.ok)('Q03 evaluation against the production executor', () => {
  const runtimes: Array<{ close(): Promise<void> }> = []
  let site: Awaited<ReturnType<typeof startEvaluationSite>> | undefined

  afterAll(async () => {
    while (runtimes.length) await runtimes.pop()!.close()
    await site?.close()
  })

  it('fills a real fixture form through BrowserToolDispatcher and verifies the end state', async () => {
    site = site ?? await startEvaluationSite()
    const runtime = await createEvaluationRuntime()
    runtimes.push(runtime)
    expect(runtime.home.includes('core')).toBe(false)
    expect(existsSync(join(SIBLING_CORE_BROWSER_ROOT, 'user-data'))).toBe(true)
    const context = runtime.context(false, 'eval-form')
    expect(runtime.tools).toBeInstanceOf(BrowserToolDispatcher)
    const opened = await runtime.tools.invoke('browser_open', { url: `${site.origin}/form.html` }, context)
    expect(opened.ok, JSON.stringify(opened)).toBe(true)
    const observation = opened.ok ? opened.value.observation : undefined
    const session = opened.ok ? opened.value.session : undefined
    expect(observation && session).toBeTruthy()
    const name = observation!.elements.filter((el) => (el.name ?? '').includes('Name') || (el.text ?? '').includes('Name')).find((el) => el.role === 'textbox')
      ?? observation!.elements.find((el) => el.role === 'textbox')
    const filled = await runtime.tools.invoke('browser_act', {
      sessionId: session!.id,
      tabId: observation!.tabId,
      generation: observation!.generation,
      observationId: observation!.observationId,
      controlLeaseId: session!.controlLeaseId,
      action: { type: 'fill', target: { kind: 'ref', ref: name!.ref }, text: 'Ada' }
    }, context)
    expect(filled.ok, JSON.stringify(filled)).toBe(true)
    const afterFill = filled.ok ? filled.value.action?.observation ?? observation! : observation!
    const save = afterFill.elements.find((el) => (el.name ?? el.text ?? '').includes('Save'))
    const clicked = await runtime.tools.invoke('browser_act', {
      sessionId: session!.id,
      tabId: afterFill.tabId,
      generation: afterFill.generation,
      observationId: afterFill.observationId,
      controlLeaseId: session!.controlLeaseId,
      action: { type: 'click', target: { kind: 'ref', ref: save!.ref } },
      expected: { type: 'text', text: 'saved:Ada:pwlen=0', present: true }
    }, context)
    expect(clicked.ok, JSON.stringify(clicked)).toBe(true)
    expect(haystack(clicked.ok ? clicked.value.action?.observation : undefined)).toContain('saved:Ada:pwlen=0')
    await runtime.sessions.close(context, session!.id)
  }, 120_000)

  it('records overlay force-click as not_actionable, not as a supported success', async () => {
    site = site ?? await startEvaluationSite()
    const runtime = await createEvaluationRuntime()
    runtimes.push(runtime)
    const context = runtime.context(false, 'eval-overlay')
    const opened = await runtime.tools.invoke('browser_open', { url: `${site.origin}/overlay.html` }, context)
    expect(opened.ok).toBe(true)
    const observation = opened.ok ? opened.value.observation : undefined
    const session = opened.ok ? opened.value.session : undefined
    const submit = observation!.elements.find((el) => (el.name ?? el.text ?? '').includes('Submit'))
    const clicked = await runtime.tools.invoke('browser_act', {
      sessionId: session!.id,
      tabId: observation!.tabId,
      generation: observation!.generation,
      observationId: observation!.observationId,
      controlLeaseId: session!.controlLeaseId,
      action: { type: 'click', target: { kind: 'ref', ref: submit!.ref } }
    }, context)
    expect(clicked.ok).toBe(false)
    expect(clicked.ok ? '' : clicked.error.code).toBe('not_actionable')
    expect(haystack(observation)).not.toContain('clicked')
  }, 120_000)

  it('does not fabricate closed-shadow refs and maps a BrowserGym native form through the adapter', async () => {
    site = site ?? await startEvaluationSite()
    const runtime = await createEvaluationRuntime()
    runtimes.push(runtime)
    const context = runtime.context(false, 'eval-closed')
    const opened = await runtime.tools.invoke('browser_open', { url: `${site.origin}/closed-shadow.html` }, context)
    expect(opened.ok).toBe(true)
    const observation = opened.ok ? opened.value.observation : undefined
    expect(haystack(observation)).toContain('page-idle')
    expect(runtime.broker.capabilityReport?.capabilities.closedShadowDom).toBe('unsupported')
    expect(haystack(observation)).not.toContain('page-leaked')
    const gym = await runNativeBrowserGymTask({
      runtime,
      origin: site.origin,
      task: nativeGymTasks()[0],
      seed: 7,
      actions: ["fill('Name', 'Ada')", "click('Save')"]
    })
    expect(gym.protocolKeys).toBe(true)
    expect(gym.lastError).toBe('')
    expect(gym.reward, JSON.stringify(gym.obs.axtree_object)).toBe(1)
  }, 180_000)

  it('uses a unique browser root and does not add files to the sibling core cache', async () => {
    const before = new Set(readdirSync(SIBLING_CORE_BROWSER_ROOT))
    site = site ?? await startEvaluationSite()
    const runtime = await createEvaluationRuntime()
    runtimes.push(runtime)
    expect(runtime.home.startsWith(SIBLING_CORE_BROWSER_ROOT)).toBe(false)
    const after = new Set(readdirSync(SIBLING_CORE_BROWSER_ROOT))
    expect([...after].sort().join(',')).toBe([...before].sort().join(','))
    expect(chrome.ok && chrome.version).toBeTruthy()
    expect(BROWSER_CONTRACT_VERSION).toBe(1)
    expect(readFileSync(join(process.cwd(), 'scripts/evaluation/browser/pin.json'), 'utf8')).toContain('9e779f087de9a65668b6974d11f9ce9816026e96')
  }, 60_000)
})
