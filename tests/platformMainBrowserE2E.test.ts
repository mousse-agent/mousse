import { spawn } from 'node:child_process'
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
import { providerResponse, streamOf } from './fixtures/agent-platform/agent-runtime-policy/helpers'
import { makeBrowserCommandTempRoot, removeBrowserCommandTempRoot } from './fixtures/agent-platform/browser-command-transport/ownedTemp'

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
    vi.spyOn(main.providerAuth, 'has').mockReturnValue(true)
    vi.spyOn(main.providerAuth.models, 'getAuth').mockResolvedValue({ apiKey: 'fixture' } as never)
    const calls: string[] = []
    const captured: Context[] = []
    vi.spyOn(main.providerAuth.models, 'streamSimple').mockImplementation((_model, context) => {
      captured.push(structuredClone(context))
      const toolResults = context.messages.filter((message) => message.role === 'toolResult')
      const call = (name: string, args: Record<string, unknown>) => {
        calls.push(name)
        return streamOf(providerResponse([{ type: 'toolCall', id: 'fixture-' + calls.length, name, arguments: args }], 'toolUse')) as never
      }
      if (!toolResults.length) return call('browser_open', {})
      const first = toolResults[0]
      const text = first.content.filter((part) => part.type === 'text').map((part) => part.text).join('')
      const opened = JSON.parse(text)
      if (first.isError) throw new Error('Browser open failed: ' + text)
      if (toolResults.length === 1) {
        const element = opened.observation.elements.find((item: { name?: string; role: string }) => item.name?.trim() === 'Name' && item.role === 'textbox')
        if (!element) throw new Error('Actual page Name field was not observed: ' + JSON.stringify(opened.observation))
        return call('browser_act', { sessionId: opened.session.id, tabId: opened.observation.tabId,
          generation: opened.observation.generation, observationId: opened.observation.observationId,
          controlLeaseId: opened.session.controlLeaseId, action: { type: 'fill', target: { kind: 'ref', ref: element.ref }, text: 'Mousse pipeline' } })
      }
      const latest = toolResults.at(-1)!
      if (latest.isError) throw new Error('Browser action failed: ' + JSON.stringify(latest.content))
      return streamOf(providerResponse([{ type: 'text', text: 'Filled the existing Mousse tab.' }], 'stop')) as never
    })
    const protocol = new MmsProtocolServer({ mms: main, ownerToken, commandRouter: main.browserCommandRouter })
    const site = createServer((_req, res) => {
      res.setHeader('content-type', 'text/html')
      res.end('<!doctype html><title>Pipeline page</title><label>Name <input id="name"></label>')
    })
    try {
      const endpoint = await protocol.start()
      await new Promise<void>((done) => site.listen(0, '127.0.0.1', done))
      const port = (site.address() as { port: number }).port
      const buildDir = resolve('.mousse-dev/main-browser-e2e'); mkdirSync(buildDir, { recursive: true })
      const script = join(buildDir, 'launch.mjs')
      const payload = join(buildDir, 'electron-main.mjs')
      writeFileSync(script, "import {app} from 'electron';\ntry { await import('./electron-main.mjs') } catch (error) { console.error(error); app.exit(1) }\n")
      await build({ entryPoints: [resolve('tests/fixtures/agent-platform/main-browser-e2e/electron-main.ts')], outfile: payload,
        bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent',
        banner: { js: "import {createRequire as __fixtureCreateRequire} from 'node:module'; const require = __fixtureCreateRequire(import.meta.url);" } })
      const evidence = join(root, 'evidence.json')
      const config = join(root, 'config.json')
      writeFileSync(config, JSON.stringify({ home: main.getHomeDir(), endpoint, ownerToken,
        profileId: main.profileId, threadId: thread.id, pageUrl: `http://127.0.0.1:${port}/`, userData: join(root, 'electron'), evidence }))
      const env = { ...process.env, MOUSSE_E2E_CONFIG: config }; delete env.ELECTRON_RUN_AS_NODE
      const result = await new Promise<{ code: number | null; stderr: string }>((done, reject) => {
        const child = spawn(electron as unknown as string, [script], { cwd: process.cwd(), env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
        let stderr = ''
        const timer = setTimeout(() => { child.kill(); reject(new Error('Electron main-agent fixture timed out: ' + stderr)) }, 100_000)
        child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-6000) })
        child.once('error', (error) => { clearTimeout(timer); reject(error) })
        child.once('exit', (code) => { clearTimeout(timer); done({ code, stderr }) })
      })
      expect(result.code, result.stderr).toBe(0)
      expect(JSON.parse(readFileSync(evidence, 'utf8'))).toMatchObject({ ok: true, sameGuest: true, cookiePreserved: true,
        value: 'Mousse pipeline', takeover: true, resumed: true, automationReleased: true })
      expect(calls).toEqual(['browser_open', 'browser_act'])
      expect(captured[0].tools?.map((tool) => tool.name)).toEqual(expect.arrayContaining(['browser_open', 'browser_act']))
      expect(main.platform.browser.managedDispatchAttempted).toBe(false)
      expect(main.orchestrator.getMessages(thread.id).some((message) => message.content === 'Filled the existing Mousse tab.')).toBe(true)
    } finally {
      await new Promise<void>((done) => site.close(() => done()))
      await protocol.stop()
      await main.stop()
    }
  }, 120_000)
})
