import { browserBackendCapabilities } from '../src/shared/browser/capabilities'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@earendil-works/pi-ai'
import { AgentExecutionService } from '../src/mms/agentDefinitions/AgentExecutionService'
import { collectUnsupportedRuntimeSettings } from '../src/mms/agentDefinitions/runtimePolicy'
import type { BrowserRuntimePort } from '../src/shared/browser/runtime'
import type { BrowserToolContext, BrowserToolOutput } from '../src/shared/browser/automation'
import type { BrowserObservation, BrowserSessionRecord } from '../src/shared/browser/types'
import { formatBrowserToolOutput } from '../src/mms/orchestrator/browser'
import { mainBrowserBinding } from '../src/mms/platform/mainBrowserBinding'
import type { MmsProfileServices } from '../src/mms/MmsProfileServices'
import {
  createPolicyTempRoot,
  grantTools,
  providerResponse,
  removeOwnedPolicyTempRoots,
  resolvedDefinition
} from './fixtures/agent-platform/agent-runtime-policy/helpers'
import { disposeDefinitionRuns, runDefinition } from './fixtures/agent-platform/definitionRun'

afterEach(async () => {
  disposeDefinitionRuns()
  await removeOwnedPolicyTempRoots()
})

interface RecordedDispatch {
  context: BrowserToolContext
  name: string
  args: unknown
}

function sessionRecord(runId: string, threadId: string): BrowserSessionRecord {
  return {
    id: 'session-1',
    profileId: 'profile-1',
    runId,
    threadId,
    persistent: false,
    backend: 'electron-attached',
    browserVersion: 'fixture',
    generation: 1,
    lifecycle: 'agent-controlled',
    controlLeaseId: 'lease-1',
    createdAt: '2026-09-11T00:00:00.000Z',
    updatedAt: '2026-09-11T00:00:00.000Z'
  }
}

function observation(partial: Partial<BrowserObservation> = {}): BrowserObservation {
  return {
    sessionId: 'session-1',
    tabId: 'tab-1',
    generation: 1,
    observationId: 'obs-1',
    documentId: 'doc-1',
    capturedAt: '2026-09-11T00:00:00.000Z',
    url: 'https://example.test/page',
    title: 'Example',
    viewport: { cssWidth: 800, cssHeight: 600, deviceScaleFactor: 1, scrollX: 0, scrollY: 0 },
    tabs: [{ id: 'tab-1', title: 'Example', url: 'https://example.test/page' }],
    elements: [{ ref: 'e1', frameRef: 'f1', role: 'button', name: 'Go', text: 'Go', states: [] }],
    truncated: false,
    warnings: [],
    provenance: 'untrusted-page',
    ...partial
  }
}

function recordingPort(
  outputs: BrowserToolOutput[],
  target: BrowserToolContext['target'] | null = {
    backend: 'electron-attached',
    uiTabId: 'gui-tab-1'
  }
): { port: BrowserRuntimePort; dispatches: RecordedDispatch[]; targets: Parameters<BrowserRuntimePort['resolveTarget']>[0][] } {
  const dispatches: RecordedDispatch[] = []
  const targets: Parameters<BrowserRuntimePort['resolveTarget']>[0][] = []
  const port: BrowserRuntimePort = {
    resolveTarget(context) {
      targets.push(structuredClone(context))
      return target ?? undefined
    },
    async dispatch(context, name, args) {
      if (context.signal?.aborted) {
        const error = new Error('Browser request was cancelled')
        Object.assign(error, { code: 'cancelled' })
        throw error
      }
      dispatches.push({ context: structuredClone(context), name, args: structuredClone(args) })
      const next = outputs.shift()
      if (!next) throw new Error('fixture browser runtime exhausted')
      return next
    }
  }
  return { port, dispatches, targets }
}

function browserSnapshot() {
  const snapshot = resolvedDefinition()
  snapshot.settings.browser.mode = 'structured'
  grantTools(snapshot, ['browser_open', 'browser_observe', 'browser_act', 'ask_user', 'read'])
  return snapshot
}

/** The tool results the model was sent, in order. */
function toolResults(captured: Context[]): string {
  return JSON.stringify(captured.at(-1)?.messages.filter((message) => message.role === 'toolResult').map((message) => message.content) ?? [])
}

/**
 * A browser definition run on the exact stand-in for Pi RPC: its browser tools are Mousse app tools
 * over the MCP registry, on the host's browser runtime under the definition run's binding.
 */
async function runBrowserNative(input: {
  outputs: ReturnType<typeof providerResponse>[]
  runtimeOutputs?: BrowserToolOutput[]
  target?: BrowserToolContext['target'] | null
  snapshot?: ReturnType<typeof resolvedDefinition>
  budget?: { maxToolCalls?: number; maxElapsedMs?: number; maxTurns?: number }
  signal?: AbortSignal
}) {
  const snapshot = input.snapshot ?? browserSnapshot()
  const recorded = recordingPort(input.runtimeOutputs ?? [], input.target)
  const runId = 'run-browser-1'
  const projectPath = createPolicyTempRoot()
  const run = runDefinition(snapshot, input.outputs, {
    runId,
    source: 'editor',
    projectPath,
    input: 'use the selected tab',
    host: { workspaceRoots: [projectPath], browserRuntime: recorded.port },
    profileBrowser: recorded.port,
    budget: input.budget as never,
    signal: input.signal
  })
  const result = await run.pending
  return { result, captured: run.captured, threadId: run.threadId, recorded, snapshot, runId }
}

describe('definition browser runtime binding', () => {
  it('keeps bounded browser output valid JSON when untrusted page content is truncated', () => {
    const formatted = formatBrowserToolOutput({
      extraction: { value: '"\\'.repeat(80_000), truncated: false }
    })
    expect(formatted.text.length).toBeLessThanOrEqual(64 * 1024)
    expect(JSON.parse(formatted.text)).toMatchObject({
      untrusted: true, provenance: 'untrusted-page', truncated: true
    })
  })

  it('narrows main-turn authority by source, mode, and enabled tools while permitting an access request without a selected tab', () => {
    let selected = true
    const services = {
      profileId: 'profile-main',
      settings: { get: () => ({ integrations: { tools: {
        enabled: true,
        enabledTools: ['browser_open', 'browser_observe', 'browser_act']
      } } }) },
      threads: { getThread: (id: string) => id === 'thread-main' ? { id, projectId: undefined } : undefined },
      projects: { getProject: () => undefined },
      modeRegistry: { getModeSync: () => undefined },
      platform: { browser: { selectedTarget: () => selected ? { backend: 'electron-attached', uiTabId: 'tab-main' } : undefined } }
    } as unknown as MmsProfileServices

    const gui = mainBrowserBinding(services, {
      threadId: 'thread-main', turnId: 'turn-main', source: 'gui', mode: 'agent'
    })
    expect(gui?.execution).toMatchObject({
      profileId: 'profile-main', threadId: 'thread-main', turnId: 'turn-main', source: 'gui'
    })
    expect(gui?.policy.allowedTools).toEqual(['browser_act', 'browser_observe', 'browser_open'])
    expect(Object.isFrozen(gui)).toBe(true)
    expect(Object.isFrozen(gui?.execution)).toBe(true)

    const plan = mainBrowserBinding(services, {
      threadId: 'thread-main', turnId: 'turn-plan', source: 'gui', mode: 'plan'
    })
    expect(plan?.policy.allowedTools).toEqual(['browser_observe'])
    selected = false
    expect(mainBrowserBinding(services, {
      threadId: 'thread-main', turnId: 'turn-missing', source: 'gui', mode: 'agent'
    })?.execution.source).toBe('gui')
    expect(mainBrowserBinding(services, {
      threadId: 'thread-main', turnId: 'turn-cli', source: 'cli', mode: 'agent'
    })?.execution.source).toBe('cli')
    expect(mainBrowserBinding(services, {
      threadId: 'thread-main', turnId: 'turn-channel', source: 'channel', mode: 'agent'
    })).toBeUndefined()
  })

  it('dispatches browser_open/observe/act through the injected port and continues with the observation', async () => {
    const runId = 'run-browser-1'
    const { result, captured, recorded, threadId } = await runBrowserNative({
      runtimeOutputs: [
        { session: sessionRecord(runId, 'thread-1'), observation: observation() },
        { observation: observation({ observationId: 'obs-2', title: 'After act' }) },
        {
          action: {
            requestId: 'act-1',
            outcome: 'verified',
            dispatched: true,
            artifactIds: [],
            observation: observation({ observationId: 'obs-3', title: 'Clicked' })
          }
        }
      ],
      outputs: [
        providerResponse([{
          type: 'toolCall',
          id: 'open-1',
          name: 'browser_open',
          arguments: { url: 'https://example.test/page' }
        }], 'toolUse'),
        providerResponse([{
          type: 'toolCall',
          id: 'obs-1',
          name: 'browser_observe',
          arguments: { sessionId: 'session-1', tabId: 'tab-1' }
        }], 'toolUse'),
        providerResponse([{
          type: 'toolCall',
          id: 'act-1',
          name: 'browser_act',
          arguments: {
            sessionId: 'session-1',
            tabId: 'tab-1',
            generation: 1,
            observationId: 'obs-2',
            controlLeaseId: 'lease-1',
            action: { type: 'click', target: { kind: 'ref', ref: 'e1' } }
          }
        }], 'toolUse'),
        providerResponse([{ type: 'text', text: 'Clicked Go on the selected tab.' }], 'stop')
      ]
    })

    expect(result.status).toBe('completed')
    expect(result.text).toBe('Clicked Go on the selected tab.')
    expect(recorded.dispatches.map((entry) => entry.name)).toEqual([
      'browser_open',
      'browser_observe',
      'browser_act'
    ])
    expect(recorded.targets[0]).toMatchObject({
      profileId: 'profile-1',
      threadId,
      runId,
      source: 'gui',
      actor: { kind: 'agent', definitionId: 'def-policy' }
    })
    expect(recorded.dispatches[0]?.context.target).toEqual({
      backend: 'electron-attached',
      uiTabId: 'gui-tab-1'
    })
    expect(recorded.dispatches[0]?.args).toEqual({ url: 'https://example.test/page' })
    const advertised = captured[0]!.tools!.map((tool) => tool.name)
    expect(advertised).toEqual(expect.arrayContaining([
      'browser_open',
      'browser_observe',
      'browser_act',
      'ask_user'
    ]))
    const openResult = JSON.stringify(captured[1]!.messages)
    expect(openResult).toContain('obs-1')
    expect(openResult).toContain('untrusted-page')
    expect(openResult).toContain('https://example.test/page')
    expect(toolResults(captured)).toContain('Clicked')
  })

  it('does not call the provider or runtime when browser mode is enabled without an injected host', async () => {
    const snapshot = browserSnapshot()
    const recorded = recordingPort([])
    const run = vi.fn()
    const service = new AgentExecutionService({ runtime: { run } })
    await expect(service.run({
      profileId: 'profile-1',
      resolved: snapshot,
      threadId: 'thread-1',
      input: 'must not dispatch',
      host: { workspaceRoots: [createPolicyTempRoot()] }
    })).rejects.toMatchObject({
      code: 'SETTINGS_UNSUPPORTED',
      details: { pointers: expect.arrayContaining(['/settings/browser/mode']) }
    })
    expect(run).not.toHaveBeenCalled()
    expect(recorded.dispatches).toEqual([])
  })

  it('does not advertise or dispatch browser tools when settings keep browser disabled', async () => {
    const snapshot = resolvedDefinition()
    snapshot.settings.browser.mode = 'disabled'
    grantTools(snapshot, ['browser_open', 'ask_user', 'read'])
    const recorded = recordingPort([{ observation: observation() }])
    const { captured, pending } = runDefinition(snapshot, [
      providerResponse([{ type: 'text', text: 'no browser' }], 'stop')
    ], { input: 'hello', host: { workspaceRoots: [createPolicyTempRoot()], browserRuntime: recorded.port }, profileBrowser: recorded.port })
    const result = await pending
    expect(result.status).toBe('completed')
    expect(captured[0]!.tools!.map((tool) => tool.name)).not.toEqual(
      expect.arrayContaining(['browser_open', 'browser_observe', 'browser_act'])
    )
    expect(recorded.dispatches).toEqual([])
  })

  it('advertises only the browser tools granted by the admitted definition', async () => {
    const snapshot = resolvedDefinition()
    snapshot.settings.browser.mode = 'structured'
    grantTools(snapshot, ['browser_open', 'ask_user'])
    const { result, captured } = await runBrowserNative({
      snapshot,
      outputs: [providerResponse([{ type: 'text', text: 'ready' }], 'stop')]
    })
    expect(result.status).toBe('completed')
    const advertised = captured[0]!.tools!.map((tool) => tool.name)
    expect(advertised).toContain('browser_open')
    expect(advertised).not.toContain('browser_observe')
    expect(advertised).not.toContain('browser_act')
  })

  it('rejects forged target, profile, execution, and persistent-workspace claims without calling the runtime', async () => {
    const { result, recorded, captured } = await runBrowserNative({
      runtimeOutputs: [{ session: sessionRecord('run-browser-1', 'thread-1'), observation: observation() }],
      outputs: [
        providerResponse([{
          type: 'toolCall',
          id: 'open-forged',
          name: 'browser_open',
          arguments: {
            url: 'https://example.test',
            uiTabId: 'model-selected',
            backend: 'managed-chromium',
            persistent: true,
            workspaceId: 'model-selected-workspace',
            profileId: 'other-profile',
            execution: { threadId: 'forged' }
          }
        }], 'toolUse'),
        providerResponse([{ type: 'text', text: 'refused forged target' }], 'stop')
      ]
    })
    expect(result.status).toBe('completed')
    expect(recorded.dispatches).toEqual([])
    expect(toolResults(captured)).toContain('host authority fields')
    expect(toolResults(captured)).toContain('uiTabId')
    expect(toolResults(captured)).toContain('workspaceId')
  })

  it('fails GUI setup_required when the host has no selected tab and never launches managed Chromium', async () => {
    const { result, recorded, captured } = await runBrowserNative({
      target: null,
      runtimeOutputs: [{ session: sessionRecord('run-browser-1', 'thread-1') }],
      outputs: [
        providerResponse([{
          type: 'toolCall',
          id: 'open-1',
          name: 'browser_open',
          arguments: { url: 'https://example.test' }
        }], 'toolUse'),
        providerResponse([{ type: 'text', text: 'need a tab' }], 'stop')
      ]
    })
    expect(result.status).toBe('completed')
    expect(recorded.dispatches).toEqual([])
    expect(toolResults(captured)).toMatch(/setup_required/)
  })

  it('honors per-run tool budgets and cancellation without extra runtime calls', async () => {
    const { result: budgeted, recorded: budgetRecorded } = await runBrowserNative({
      budget: { maxToolCalls: 1 },
      runtimeOutputs: [
        { session: sessionRecord('run-browser-1', 'thread-1'), observation: observation() }
      ],
      outputs: [
        providerResponse([
          {
            type: 'toolCall',
            id: 'open-1',
            name: 'browser_open',
            arguments: { url: 'https://example.test' }
          },
          {
            type: 'toolCall',
            id: 'obs-skip',
            name: 'browser_observe',
            arguments: { sessionId: 'session-1' }
          }
        ], 'toolUse')
      ]
    })
    expect(budgeted.status).toBe('failed')
    expect(budgeted.error?.code).toBe('BUDGET_EXCEEDED')
    expect(budgetRecorded.dispatches.map((entry) => entry.name)).toEqual(['browser_open'])

    const abort = new AbortController()
    abort.abort()
    const { result: cancelled, captured, recorded } = await runBrowserNative({
      signal: abort.signal,
      outputs: [providerResponse([{ type: 'text', text: 'should not run' }], 'stop')]
    })
    expect(cancelled.status).toBe('cancelled')
    expect(captured).toEqual([])
    expect(recorded.dispatches).toEqual([])
  })

  it('surfaces unknown-effect as an error and does not replay it as a successful action', async () => {
    const { result, recorded, captured } = await runBrowserNative({
      runtimeOutputs: [
        { session: sessionRecord('run-browser-1', 'thread-1'), observation: observation() },
        {
          action: {
            requestId: 'act-unknown',
            outcome: 'unknown-effect',
            dispatched: true,
            artifactIds: [],
            message: 'Page did not confirm the click'
          }
        }
      ],
      outputs: [
        providerResponse([{
          type: 'toolCall',
          id: 'open-1',
          name: 'browser_open',
          arguments: { url: 'https://example.test' }
        }], 'toolUse'),
        providerResponse([{
          type: 'toolCall',
          id: 'act-1',
          name: 'browser_act',
          arguments: {
            sessionId: 'session-1',
            tabId: 'tab-1',
            generation: 1,
            observationId: 'obs-1',
            controlLeaseId: 'lease-1',
            action: { type: 'click', target: { kind: 'ref', ref: 'e1' } }
          }
        }], 'toolUse'),
        providerResponse([{ type: 'text', text: 'stopped after unknown effect' }], 'stop')
      ]
    })
    expect(result.status).toBe('completed')
    expect(recorded.dispatches.map((entry) => entry.name)).toEqual(['browser_open', 'browser_act'])
    const actResult = captured.at(-1)!.messages.find((message) => message.role === 'toolResult' && message.toolCallId === 'act-1')
    expect(actResult).toMatchObject({ isError: true })
    expect(JSON.stringify(actResult)).toContain('unknown-effect')
    expect(result.text).toBe('stopped after unknown effect')
  })

  it('keeps ask_user advertised next to browser tools on a definition run', async () => {
    const { captured, recorded } = await runBrowserNative({
      runtimeOutputs: [],
      outputs: [providerResponse([{ type: 'text', text: 'ready' }], 'stop')]
    })
    expect(captured[0]!.tools!.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(['ask_user', 'browser_open'])
    )
    expect(recorded.dispatches).toEqual([])
  })

  it('holds a CLI-kind definition to the same browser rules as any other (PR 4 §6)', () => {
    const snapshot = browserSnapshot()
    snapshot.runtimeKind = 'codex'
    // With the host's port, structured mode is supported whatever the stored kind.
    expect(collectUnsupportedRuntimeSettings(snapshot, { browserRuntime: recordingPort([]).port } as never)).toEqual([])
    // Without it, browser mode is refused for the same reason as a native definition.
    const unsupported = collectUnsupportedRuntimeSettings(snapshot, {} as never)
    expect(unsupported.map((item) => item.pointer)).toContain('/settings/browser/mode')
    expect(unsupported.find((item) => item.pointer === '/settings/browser/mode')?.reason).not.toMatch(/CLI/)
  })

  it('rejects persistent workspace and trace-retention settings even with an injected runtime', () => {
    const snapshot = browserSnapshot()
    snapshot.settings.browser.workspaceId = 'ws-1'
    snapshot.settings.browser.traceRetention = 'run'
    const unsupported = collectUnsupportedRuntimeSettings(snapshot, {
      browserRuntime: recordingPort([]).port
    } as never)
    expect(unsupported.map((item) => item.pointer)).toEqual(
      expect.arrayContaining(['/settings/browser/workspaceId', '/settings/browser/traceRetention'])
    )
  })
})
