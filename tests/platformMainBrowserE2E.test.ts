import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { build } from 'esbuild'
import electron from 'electron'
import type { Context } from '@earendil-works/pi-ai'
import { MousseMainService } from '../src/mms/MousseMainService'
import { MmsProtocolServer } from '../src/mms/protocol/server'
import { ProviderAuthService } from '../src/mms/providers/ProviderAuthService'
import { BROWSER_AUTOMATION_TOOLS } from '../src/shared/browser/automation'
import type { WorkflowBundle } from '../src/shared/workflows'
import { providerResponse, streamOf } from './fixtures/agent-platform/agent-runtime-policy/helpers'
import { makeBrowserCommandTempRoot, removeBrowserCommandTempRoot } from './fixtures/agent-platform/browser-command-transport/ownedTemp'

import { terminateChild } from './fixtures/agent-platform/process-lifecycle/terminateChild'

const roots: string[] = []
const priorHome = process.env.MOUSSE_HOME
afterEach(() => {
  vi.restoreAllMocks()
  if (priorHome === undefined) delete process.env.MOUSSE_HOME
  else process.env.MOUSSE_HOME = priorHome
  for (const root of roots.splice(0)) removeBrowserCommandTempRoot(root)
})

describe('main-agent existing in-app browser pipeline', () => {
  it('runs native model tools through MMS, the same GUI connection, main host, and a real Electron webview', async () => {
    vi.spyOn(ProviderAuthService.prototype, 'init').mockResolvedValue(undefined)
    const root = makeBrowserCommandTempRoot(); roots.push(root)
    const main = await MousseMainService.create({ homeDir: join(root, 'home'), repoRoot: root, headless: true, ownerKind: 'daemon' })
    const ownerToken = main.getOwnerLease()!.owner.token
    const thread = main.threads.createThread('Browser pipeline fixture')
    const provider = main.providerAuth.models.getProviders().find((entry) => main.providerAuth.models.getModels(entry.id).length > 0)!
    const model = main.providerAuth.models.getModels(provider.id)[0]
    const settings = main.settings.get()
    main.settings.set({ provider: { llmProvider: provider.id, model: model.id }, integrations: {
      ...settings.integrations, tools: { enabled: true, enabledTools: [...BROWSER_AUTOMATION_TOOLS] },
      skills: { ...settings.integrations.skills, enabled: false }, mcp: { ...settings.integrations.mcp, enabled: false }
    } })
    const workflowId = randomUUID()
    const workflowBundle: WorkflowBundle = { assets: [], manifest: {
      schemaVersion: 1, id: workflowId, name: 'Existing tab workflow', slug: `existing-tab-${workflowId.slice(0, 8)}`,
      entryNodeId: 'start', inputSchema: { type: 'object' }, outputSchema: { type: 'object', additionalProperties: true },
      permissions: { capabilities: ['browser.session', 'browser.action'] },
      nodes: [
        { id: 'start', type: 'start', version: 1, config: {} },
        { id: 'open', type: 'browser-session', version: 1, config: {} },
        { id: 'navigate', type: 'browser-action', version: 1, config: { action: { type: 'navigate', url: '__WORKFLOW_URL__' } }, inputs: {
          sessionId: { ref: 'node', nodeId: 'open', pointer: '/session/id' },
          tabId: { ref: 'node', nodeId: 'open', pointer: '/observation/tabId' },
          generation: { ref: 'node', nodeId: 'open', pointer: '/observation/generation' },
          observationId: { ref: 'node', nodeId: 'open', pointer: '/observation/observationId' },
          controlLeaseId: { ref: 'node', nodeId: 'open', pointer: '/session/controlLeaseId' }
        } },
        { id: 'end', type: 'end', version: 1, config: {}, inputs: { result: { ref: 'node', nodeId: 'navigate', pointer: '' } } }
      ],
      edges: [
        { from: 'start', port: 'next', to: 'open' },
        { from: 'open', port: 'success', to: 'navigate' },
        { from: 'navigate', port: 'success', to: 'end' }
      ]
    } }
    vi.spyOn(main.providerAuth, 'has').mockReturnValue(true)
    vi.spyOn(main.providerAuth.models, 'getAuth').mockResolvedValue({ apiKey: 'fixture' } as never)
    const calls: string[] = []
    const captured: Context[] = []
    let opened: {
      session: { id: string; controlLeaseId: string }
      observation: { tabId: string; generation: number; observationId: string; elements: Array<{ ref: string; name?: string; role: string }> }
    } | undefined
    let staleActionError = ''
    let freshGeneration = 0
    let freshInputRef = ''
    let freshControlLeaseId = ''
    let waitingResponseSent = false
    vi.spyOn(main.providerAuth.models, 'streamSimple').mockImplementation((_model, context) => {
      captured.push(structuredClone(context))
      const toolResults = context.messages.filter((message) => message.role === 'toolResult')
      const call = (name: string, args: Record<string, unknown>) => {
        calls.push(name)
        return streamOf(providerResponse([{ type: 'toolCall', id: 'fixture-' + calls.length, name, arguments: args }], 'toolUse')) as never
      }
      if (!toolResults.length) return call('browser_open', {})
      const latest = toolResults.at(-1)!
      const text = latest.content.filter((part) => part.type === 'text').map((part) => part.text).join('')
      if (calls.length === 1) {
        if (latest.isError) throw new Error('Browser open failed: ' + text)
        opened = JSON.parse(text)
        const element = opened!.observation.elements.find((item) => item.name?.trim() === 'Name' && item.role === 'textbox')
        if (!element) throw new Error('Actual page Name field was not observed: ' + JSON.stringify(opened!.observation))
        return call('browser_request_human', { sessionId: opened!.session.id, reason: 'Please complete the form after resuming the agent.' })
      }
      if (calls.length === 2) {
        if (!waitingResponseSent) {
          if (latest.isError) throw new Error('Browser human handoff failed: ' + text)
          waitingResponseSent = true
          return streamOf(providerResponse([{ type: 'text', text: 'Waiting for human review.' }], 'stop')) as never
        }
        const oldInput = opened!.observation.elements.find((item) => item.name?.trim() === 'Name' && item.role === 'textbox')!
        return call('browser_act', { sessionId: opened!.session.id, tabId: opened!.observation.tabId,
          generation: opened!.observation.generation, observationId: opened!.observation.observationId,
          controlLeaseId: opened!.session.controlLeaseId,
          action: { type: 'fill', target: { kind: 'ref', ref: oldInput.ref }, text: 'stale write' } })
      }
      if (!opened) throw new Error('Browser session was not captured')
      const oldInput = opened.observation.elements.find((item) => item.name?.trim() === 'Name' && item.role === 'textbox')!
      if (calls.length === 3) {
        if (!latest.isError || !text.includes('stale_generation')) throw new Error('Old browser reference was not fenced after resume: ' + text)
        staleActionError = text
        return call('browser_observe', { sessionId: opened.session.id, tabId: opened.observation.tabId })
      }
      if (calls.length === 4) {
        if (latest.isError) throw new Error('Fresh browser observation failed: ' + text)
        const refreshed = JSON.parse(text) as { session?: { controlLeaseId?: string }; observation: typeof opened.observation }
        const observed = refreshed.observation
        const input = observed.elements.find((item) => item.name?.trim() === 'Name' && item.role === 'textbox')
        if (!input || observed.generation <= opened.observation.generation || input.ref === oldInput.ref || !refreshed.session?.controlLeaseId) {
          throw new Error('Resume did not provide a fresh input reference: ' + text)
        }
        freshGeneration = observed.generation
        freshInputRef = input.ref
        freshControlLeaseId = refreshed.session.controlLeaseId
        return call('browser_act', { sessionId: opened.session.id, tabId: observed.tabId,
          generation: observed.generation, observationId: observed.observationId,
          controlLeaseId: freshControlLeaseId,
          action: { type: 'fill', target: { kind: 'ref', ref: input.ref }, text: 'Mousse pipeline' } })
      }
      if (calls.length === 5) {
        if (latest.isError) throw new Error('Post-resume fill failed: ' + text)
        const action = JSON.parse(text).action
        const observed = action?.observation as typeof opened.observation | undefined
        const submit = observed?.elements.find((item) => item.name?.trim() === 'Submit' && item.role === 'button')
        if (!observed || !submit) throw new Error('Submit button was not freshly observed after fill: ' + text)
        return call('browser_act', { sessionId: opened.session.id, tabId: observed.tabId,
          generation: observed.generation, observationId: observed.observationId,
          controlLeaseId: freshControlLeaseId,
          action: { type: 'click', target: { kind: 'ref', ref: submit.ref } },
          expected: { type: 'url', includes: '/submit' } })
      }
      if (calls.length === 6) {
        if (latest.isError) throw new Error('Post-resume submit failed: ' + text)
        return streamOf(providerResponse([{ type: 'text', text: 'Completed and submitted the existing Mousse form.' }], 'stop')) as never
      }
      throw new Error('Unexpected provider invocation after browser pipeline completion')
    })
    const protocol = new MmsProtocolServer({ mms: main, ownerToken, commandRouter: main.browserCommandRouter })
    let submittedBody = ''
    let submittedCookie = ''
    const site = createServer((req, res) => {
      res.setHeader('content-type', 'text/html')
      if (req.method === 'POST' && req.url === '/submit') {
        submittedCookie = req.headers.cookie ?? ''
        req.setEncoding('utf8')
        req.on('data', (chunk) => { submittedBody += chunk })
        req.on('end', () => res.end('<!doctype html><title>Submitted</title><p id="result">Submitted Mousse pipeline</p>'))
        return
      }
      res.end('<!doctype html><title>Pipeline page</title><form method="post" action="/submit"><label>Name <input id="name" name="name"></label><button type="submit">Submit</button></form>')
    })
    let child: ReturnType<typeof spawn> | undefined
    try {
      const endpoint = await protocol.start()
      await new Promise<void>((done) => site.listen(0, '127.0.0.1', done))
      const port = (site.address() as { port: number }).port
      const workflowUrl = `http://127.0.0.1:${port}/workflow`
      const encodedBundle = structuredClone(workflowBundle)
      ;(encodedBundle.manifest.nodes.find((node) => node.id === 'navigate')!.config.action as { url: string }).url = workflowUrl
      const draft = main.platform.workflowDefinitions.saveDraft({ bundle: encodedBundle })
      const published = main.platform.workflowDefinitions.publish({ definitionId: workflowId,
        expectedDraftSemanticHash: draft.semanticHash, expectedHeadRevisionId: null })
      const buildDir = join(root, 'bundle'); mkdirSync(buildDir, { recursive: true })
      const script = join(buildDir, 'launch.mjs')
      const payload = join(buildDir, 'electron-main.mjs')
      writeFileSync(script, "import {app} from 'electron';\ntry { await import('./electron-main.mjs') } catch (error) { console.error(error); app.exit(1) }\n")
      await build({ entryPoints: [resolve('tests/fixtures/agent-platform/main-browser-e2e/electron-main.ts')], outfile: payload,
        bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent',
        banner: { js: "import {createRequire as __fixtureCreateRequire} from 'node:module'; const require = __fixtureCreateRequire(import.meta.url);" } })
      const evidence = join(root, 'evidence.json')
      const config = join(root, 'config.json')
      writeFileSync(config, JSON.stringify({ home: main.getHomeDir(), endpoint, ownerToken,
        profileId: main.profileId, threadId: thread.id, pageUrl: `http://127.0.0.1:${port}/`, workflowUrl,
        workflowDefinitionId: workflowId, workflowRevisionId: published.head!.revisionId,
        userData: join(root, 'electron'), evidence }))
      const env = { ...process.env, MOUSSE_E2E_CONFIG: config }; delete env.ELECTRON_RUN_AS_NODE
      const result = await new Promise<{ code: number | null; stderr: string }>((done, reject) => {
        child = spawn(electron as unknown as string, [script], { cwd: process.cwd(), env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
        let stderr = ''
        let timedOut = false
        const timer = setTimeout(() => {
          timedOut = true
          void terminateChild(child).then(
            () => reject(new Error('Electron main-agent fixture timed out: ' + stderr)),
            (error) => reject(new AggregateError([new Error('Electron main-agent fixture timed out: ' + stderr), error]))
          )
        }, 100_000)
        child.stderr!.on('data', (chunk) => { stderr = (stderr + chunk).slice(-6000) })
        child.once('error', (error) => { clearTimeout(timer); reject(error) })
        child.once('exit', (code) => { clearTimeout(timer); if (!timedOut) done({ code, stderr }) })
      })
      expect(result.code, result.stderr).toBe(0)
      const proof = JSON.parse(readFileSync(evidence, 'utf8')) as { workflow: { runId: string } }
      expect(proof).toMatchObject({ ok: true, sameGuest: true, cookiePreserved: true,
        value: 'Submitted Mousse pipeline', takeover: true, resumed: true, automationReleased: true,
        workflow: { state: 'succeeded', approvals: 2, sameGuest: true, cookiePreserved: true, managedFallback: false, actionOutcome: 'verified' } })
      expect(submittedBody).toBe('name=Mousse+pipeline')
      expect(submittedCookie).toContain('existing=preserved')
      expect(staleActionError).toContain('stale_generation')
      expect(freshGeneration).toBeGreaterThan(opened!.observation.generation)
      expect(freshInputRef).not.toBe(opened!.observation.elements.find((item) => item.role === 'textbox')!.ref)
      const workflowTrace = await main.platform.workflowRuns.runtime.trace(proof.workflow.runId, { profileId: main.profileId })
      expect(workflowTrace.nodeOutputs.navigate).toMatchObject({ action: { outcome: 'verified', dispatched: true } })
      expect(workflowTrace.attempts.find((attempt) => attempt.nodeId === 'navigate')).toMatchObject({ outcome: 'succeeded' })
      expect(calls).toEqual(['browser_open', 'browser_request_human', 'browser_act', 'browser_observe', 'browser_act', 'browser_act'])
      expect(captured[0].tools?.map((tool) => tool.name)).toEqual(expect.arrayContaining(['browser_open', 'browser_act']))
      expect(main.platform.browser.managedDispatchAttempted).toBe(false)
      expect(main.platform.browser.getActiveCount()).toBe(0)
      expect(main.platform.browser.pendingAttachedGuestAcks()).toEqual([])
      expect(main.orchestrator.getMessages(thread.id).some((message) => message.content === 'Completed and submitted the existing Mousse form.')).toBe(true)
    } finally {
      try {
        await terminateChild(child)
      } finally {
        try { await protocol.stop() } finally {
          try { await main.stop() } finally {
            site.closeAllConnections()
            await new Promise<void>((done) => site.close(() => done()))
          }
        }
      }
    }
  }, 120_000)
})
