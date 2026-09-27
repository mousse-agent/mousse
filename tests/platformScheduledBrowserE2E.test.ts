import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { build } from 'esbuild'
import electron from 'electron'
import { MousseMainService } from '../src/mms/MousseMainService'
import { inspectChromeSource } from './fixtures/browser/evaluation/chrome'
import { ProviderAuthService } from '../src/mms/providers/ProviderAuthService'
import { MmsProtocolServer } from '../src/mms/protocol'
import type { MmsProfileServices } from '../src/mms/MmsProfileServices'
import type { WorkflowBundle, WorkflowRunSnapshot } from '../src/shared/workflows'

import { terminateChild } from './fixtures/agent-platform/process-lifecycle/terminateChild'

const roots: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) {
    const rel = relative(realpathSync(tmpdir()), realpathSync(root))
    if (isAbsolute(rel) || !rel.startsWith('mousse-scheduled-browser-') || rel.includes('..')) throw new Error('Unsafe fixture cleanup')
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

function workflow(url: string): WorkflowBundle {
  const id = randomUUID()
  return { assets: [], manifest: {
    schemaVersion: 1, id, name: 'Scheduled managed browser', slug: `scheduled-browser-${id.slice(0, 8)}`,
    entryNodeId: 'start', inputSchema: { type: 'object', additionalProperties: false },
    outputSchema: { type: 'object', additionalProperties: true },
    permissions: { capabilities: ['browser.session', 'browser.action'] },
    nodes: [
      { id: 'start', type: 'start', version: 1, config: {} },
      { id: 'open', type: 'browser-session', version: 1, config: { url } },
      { id: 'navigate', type: 'browser-action', version: 1, config: { action: { type: 'navigate', url: `${url}done` } }, inputs: {
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
}

async function waitFile(path: string): Promise<void> {
  await vi.waitFor(() => expect(existsSync(path)).toBe(true), { timeout: 15_000, interval: 25 })
}

// Failed ephemeral sessions remove their logs before workflow failure reaches
// the GUI. Retain only bounded stderr tails for this fixture's fresh profile.
function captureBrowserStderr(browserRoot: string, profileId: string): { stop(): void; text(): string } {
  const directory = join(browserRoot, 'user-data', profileId, 'ephemeral')
  const tails = new Map<string, string>()
  const sample = () => {
    try {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (!entry.isDirectory() || !/^sess_[\w-]+$/.test(entry.name) || (!tails.has(entry.name) && tails.size >= 4)) continue
        const file = join(directory, entry.name, 'mousse-logs', 'stderr.log')
        try {
          const within = relative(realpathSync(directory), realpathSync(file))
          if (isAbsolute(within) || within.startsWith('..') || lstatSync(file).isSymbolicLink()) continue
          const fd = openSync(file, 'r')
          try {
            const stat = fstatSync(fd)
            if (!stat.isFile()) continue
            const bytes = Buffer.alloc(Math.min(stat.size, 6000))
            const count = readSync(fd, bytes, 0, bytes.length, Math.max(0, stat.size - bytes.length))
            tails.set(entry.name, bytes.subarray(0, count).toString('utf8'))
          } finally { closeSync(fd) }
        } catch { /* The worker may remove a completed session while sampling. */ }
      }
    } catch { /* No session has been created yet. */ }
  }
  const timer = setInterval(sample, 25)
  timer.unref()
  return {
    stop: () => clearInterval(timer),
    text: () => { sample(); return [...tails].map(([session, tail]) => `${session}:\n${tail}`).join('\n').replaceAll(browserRoot, '<managed-browser-root>') }
  }
}

describe('scheduled Browser workflow after owning GUI closes', () => {
  it('waits durably, resumes through a replacement authenticated GUI, and uses managed Chrome without attached fallback', async () => {
    vi.spyOn(ProviderAuthService.prototype, 'init').mockResolvedValue(undefined)
    const root = join(tmpdir(), `mousse-scheduled-browser-${randomUUID()}`); mkdirSync(root, { recursive: true }); roots.push(root)
    const homeDir = join(root, 'home')
    const main = await MousseMainService.create({ homeDir, repoRoot: root, requireOwnership: true, headless: true, ownerKind: 'daemon' })
    const ownerToken = main.getOwnerLease()!.owner.token
    const server = new MmsProtocolServer({ mms: main, ownerToken, commandRouter: main.browserCommandRouter })
    const site = createServer((_req, res) => { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><title>Scheduled Browser</title>ready') })
    let owner: ReturnType<typeof spawn> | undefined
    let approver: ReturnType<typeof spawn> | undefined
    let services: MmsProfileServices | undefined
    let browserStderr: ReturnType<typeof captureBrowserStderr> | undefined
    try {
      const endpoint = await server.start()
      await new Promise<void>((done) => site.listen(0, '127.0.0.1', done))
      const origin = `http://127.0.0.1:${(site.address() as { port: number }).port}/`
      const chrome = inspectChromeSource()
      if (!chrome.ok) throw new Error(chrome.message)
      const browserRoot = chrome.browserRoot
      browserStderr = captureBrowserStderr(browserRoot, main.profileId)
      services = await main.getProfileServices(main.profileId)
      services.platform.configureBrowser({ installationBrowserRoot: browserRoot, workerModulePath: resolve('out/browser-worker/index.mjs') })
      const settings = services.settings.get().integrations
      services.settings.set({ integrations: { ...settings, tools: { enabled: true, enabledTools: ['browser_open', 'browser_act'] } } })
      const thread = services.threads.createThread('Scheduled Browser E2E')
      const content = workflow(origin)
      const draft = services.platform.workflowDefinitions.saveDraft({ bundle: content })
      const published = services.platform.workflowDefinitions.publish({ definitionId: draft.definitionId,
        expectedDraftSemanticHash: draft.semanticHash, expectedHeadRevisionId: null })

      const buildDir = join(root, 'bundle'); mkdirSync(buildDir, { recursive: true })
      const entry = join(buildDir, 'electron-gui.mjs')
      await build({ entryPoints: [resolve('tests/fixtures/agent-platform/scheduled-browser-e2e/electron-gui.ts')], outfile: entry,
        bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent',
        banner: { js: "import {createRequire as __fixtureCreateRequire} from 'node:module'; const require = __fixtureCreateRequire(import.meta.url);" } })
      const launch = (name: string, runId?: string) => {
        const ready = join(root, `${name}-ready.json`), evidence = join(root, `${name}-evidence.json`), close = join(root, `${name}-close`)
        const config = join(root, `${name}-config.json`)
        writeFileSync(config, JSON.stringify({ home: homeDir, endpoint, ownerToken, profileId: main.profileId,
          userData: join(root, `${name}-electron`), ready, close, evidence, runId }))
        const env = { ...process.env, MOUSSE_E2E_CONFIG: config }; delete env.ELECTRON_RUN_AS_NODE
        const child = spawn(electron as unknown as string, [entry], { cwd: process.cwd(), env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
        let stderr = ''; child.stderr!.on('data', (chunk) => { stderr = (stderr + chunk).slice(-6000) })
        const exited = new Promise<number | null>((done, reject) => {
          child.once('error', reject); child.once('exit', done)
        })
        return { child, ready, evidence, close, exited, stderr: () => stderr }
      }

      const first = launch('owner'); owner = first.child
      await waitFile(first.ready)
      const job = services.scheduled.createJob({ name: 'Scheduled Browser', prompt: `/${content.manifest.slug}`,
        schedule: { kind: 'interval', minutes: 60 }, threadId: thread.id })
      services.scheduled.triggerJob(job.id)
      services.scheduled.start()
      let pending!: WorkflowRunSnapshot
      try {
        await vi.waitFor(async () => {
          const runs = await services.platform.workflowRuns.runtime.list({ profileId: main.profileId })
          const run = runs.find((item) => item.source === 'schedule')
          if (run) pending = await services.platform.workflowRuns.runtime.get(run.runId, { profileId: main.profileId })
          expect(pending?.manifest.state).toBe('waiting-approval')
        }, { timeout: 15_000, interval: 25 })
      } catch (error) {
        throw new Error(`Scheduled admission failed: ${JSON.stringify(services.scheduled.getJob(job.id))}`, { cause: error })
      }
      expect(services.platform.browser.managedDispatchAttempted).toBe(false)

      writeFileSync(first.close, 'close')
      expect(await first.exited, first.stderr()).toBe(0)
      expect(JSON.parse(readFileSync(first.evidence, 'utf8'))).toMatchObject({ closed: true, profileId: main.profileId })
      expect((await services.platform.workflowRuns.runtime.get(pending.manifest.runId, { profileId: main.profileId })).manifest.state).toBe('waiting-approval')

      const attachedAbort = new AbortController()
      const explicitAttached = services.platform.browser.dispatch({ execution: {
        profileId: main.profileId, threadId: thread.id, turnId: randomUUID(), runId: randomUUID(), actor: { kind: 'main' },
        source: 'gui', policySnapshotId: 'explicit-attached', cancellationId: randomUUID()
      }, policy: services.platform.workflowRuns.policy.snapshot(main.profileId, {
        allowedTools: ['browser_open'], allowedCapabilities: ['browser.session'], allowedEffects: ['external']
      }), signal: attachedAbort.signal }, 'browser_open', {})
      // No GUI is present to grant access. The request must wait for consent,
      // stay off managed Chrome, and remain cancellable instead of hanging the test.
      await vi.waitFor(() => expect(services!.platform.browser.accessStatus().pending).toHaveLength(1))
      expect(services.platform.browser.managedDispatchAttempted).toBe(false)
      attachedAbort.abort()
      expect(await explicitAttached).toMatchObject({ ok: false, error: { code: 'cancelled' } })
      expect(services.platform.browser.managedDispatchAttempted).toBe(false)

      const second = launch('approver', pending.manifest.runId); approver = second.child
      await waitFile(second.ready)
      const approverExit = await second.exited
      expect(approverExit, approverExit === 0 ? undefined : `${second.stderr()}\nManaged Chrome stderr:\n${browserStderr.text()}`).toBe(0)
      expect(JSON.parse(readFileSync(second.evidence, 'utf8'))).toMatchObject({ state: 'succeeded', approvals: 2, profileId: main.profileId })
      const done = await services.platform.workflowRuns.runtime.get(pending.manifest.runId, { profileId: main.profileId })
      expect(done.manifest).toMatchObject({ state: 'succeeded', source: 'schedule' })
      expect(done.outputs.navigate).toMatchObject({ action: { outcome: 'verified', dispatched: true, observation: { url: `${origin}done` } } })
      expect(done.outputs.open).toMatchObject({ session: { backend: 'managed-chromium' } })
      expect(services.platform.browser.managedDispatchAttempted).toBe(true)
      expect(services.platform.browser.managedBrokerStarted).toBe(true)
    } finally {
      browserStderr?.stop()
      services?.scheduled.stop()
      try {
        const stopped = await Promise.allSettled([terminateChild(owner), terminateChild(approver)])
        const failed = stopped.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        if (failed.length) throw new AggregateError(failed.map((result) => result.reason), 'GUI fixture termination failed')
      } finally {
        try { await server.stop() } finally {
          try { await main.stop() } finally {
            site.closeAllConnections()
            await new Promise<void>((done) => site.close(() => done()))
          }
        }
      }
    }
  }, 90_000)
})
