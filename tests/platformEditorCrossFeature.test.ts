import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { AssistantMessage, Context, Model } from '@earendil-works/pi-ai'
import { build } from 'esbuild'
import electron from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MousseMainService } from '../src/mms/MousseMainService'
import { readOwnerRecord } from '../src/mms/ownership/MmsOwnerLease'
import { ProviderAuthService } from '../src/mms/providers/ProviderAuthService'
import { MmsProtocolServer } from '../src/mms/protocol'
import { providerResponse, streamOf } from './fixtures/agent-platform/agent-runtime-policy/helpers'

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) {
    const rel = relative(realpathSync(tmpdir()), realpathSync(root))
    if (isAbsolute(rel) || !rel.startsWith('mousse-editor-cross-') || rel.includes('..')) throw new Error('Unexpected fixture root')
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

async function launch(config: Record<string, unknown>, root: string): Promise<Record<string, unknown>> {
  const bundle = join(root, 'electron-main.mjs')
  await build({ entryPoints: [resolve('tests/fixtures/agent-platform/editor-cross-feature/electron-main.ts')],
    outfile: bundle, bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent',
    banner: { js: "import {createRequire as __fixtureCreateRequire} from 'node:module'; const require = __fixtureCreateRequire(import.meta.url);" } })
  const configPath = join(root, `config-${config.phase}.json`)
  writeFileSync(configPath, JSON.stringify(config))
  const env = { ...process.env, MOUSSE_EDITOR_CROSS_CONFIG: configPath }; delete env.ELECTRON_RUN_AS_NODE
  const result = await new Promise<{ code: number | null; stderr: string }>((done, reject) => {
    const child = spawn(electron as unknown as string, [bundle], { cwd: process.cwd(), env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; child.kill() }, 100_000)
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-8_000) })
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    child.once('exit', (code) => {
      clearTimeout(timer)
      if (timedOut) reject(new Error('Editor Electron fixture timed out and exited: ' + stderr))
      else done({ code, stderr })
    })
  })
  expect(result.code, result.stderr).toBe(0)
  return JSON.parse(readFileSync(config.evidence as string, 'utf8')) as Record<string, unknown>
}

describe('production editor UI compound persistence', () => {
  it('persists renderer agent/workflow edits across restart and runs the exact agent revision', async () => {
    vi.spyOn(ProviderAuthService.prototype, 'init').mockResolvedValue(undefined)
    const root = mkdtempSync(join(tmpdir(), 'mousse-editor-cross-')); roots.push(root)
    const home = join(root, 'home')
    const rendererDir = join(root, 'renderer')
    const rendererJs = join(rendererDir, 'preview.js')
    await build({ entryPoints: [resolve('tests/fixtures/agent-platform/editor-cross-feature/preview.tsx')],
      outfile: rendererJs, bundle: true, platform: 'browser', format: 'esm', jsx: 'automatic', logLevel: 'silent',
      loader: { '.css': 'css', '.svg': 'dataurl', '.png': 'dataurl', '.webp': 'dataurl' },
      define: { 'process.env.NODE_ENV': '"production"' } })
    const rendererHtml = join(rendererDir, 'preview.html')
    writeFileSync(rendererHtml, '<!doctype html><html><head><meta charset="UTF-8"><link rel="stylesheet" href="./preview.css"></head><body><div id="root"></div><script type="module" src="./preview.js"></script></body></html>')
    const url = pathToFileURL(rendererHtml).href
    let main = await MousseMainService.create({ homeDir: home, repoRoot: root, headless: true })
    let ownerToken = readOwnerRecord(home)!.token
    let profileId = main.profileId
    let services = await main.getProfileServices(profileId)
    const provider = services.providerAuth.models.getProviders().find((entry) => services.providerAuth.models.getModels(entry.id).length > 0)!
    const model = services.providerAuth.models.getModels(provider.id)[0]
    let protocol = new MmsProtocolServer({ mms: main, ownerToken })
    let endpoint = await protocol.start()
    const common = { home, ownerToken, profileId, url,
      preload: resolve('tests/fixtures/agent-platform/editor-cross-feature/preload.cjs'),
      providerId: provider.id, providerLabel: provider.name, modelId: model.id, modelLabel: model.name,
      exportPath: join(root, 'exported.mousse-workflow.json') }
    try {
    const edited = await launch({ ...common, endpoint, phase: 'edit', evidence: join(root, 'edit.json'), userData: join(root, 'electron-edit') }, root)
    expect(edited.ok).toBe(true)
    expect(edited.appearanceAccessible).toBe(true)
    const agentId = edited.agentId as string
    const workflowId = edited.workflowId as string
    const importedId = edited.importedId as string
    const storedAgent = services.platform.agentDefinitions.get(agentId)
    expect(storedAgent.systemPrompt.replace(/\r\n/g, '\n')).toBe('# Exact renderer prompt\n\nPreserve  two spaces.')
    expect(storedAgent.settings.primaryModel.ref).toEqual({ providerId: provider.id, modelId: model.id })
    expect(storedAgent.published?.revision).toBe(storedAgent.semanticHash)
    expect(storedAgent.visual).toMatchObject({ palette: edited.palette })
    const original = services.platform.workflowDefinitions.get(workflowId)
    const imported = services.platform.workflowDefinitions.get(importedId)
    expect(original.head?.revisionId).toBeTruthy()
    expect(imported.bundle.manifest.nodes.map((node) => node.id)).toEqual(original.bundle.manifest.nodes.map((node) => node.id))
    expect(imported.bundle.manifest.edges).toEqual(original.bundle.manifest.edges)
    expect(imported.bundle.editor).toEqual(original.bundle.editor)
    expect(await services.platform.workflowRuns.runtime.list({ profileId })).toEqual([])

    await protocol.stop(); await main.stop()
    main = await MousseMainService.create({ homeDir: home, repoRoot: root, headless: true })
    ownerToken = readOwnerRecord(home)!.token
    services = await main.getProfileServices(profileId)
    const captured: Array<{ model: Model<any>; context: Context }> = []
    vi.spyOn(services.providerAuth, 'has').mockReturnValue(true)
    vi.spyOn(services.providerAuth.models, 'getAuth').mockResolvedValue({ apiKey: 'fixture' } as never)
    vi.spyOn(services.providerAuth.models, 'streamSimple').mockImplementation((selected, context) => {
      captured.push({ model: selected as Model<any>, context: structuredClone(context) })
      return streamOf(providerResponse([{ type: 'text', text: 'renderer production run complete' }], 'stop') as AssistantMessage) as never
    })
    protocol = new MmsProtocolServer({ mms: main, ownerToken }); endpoint = await protocol.start()
      const ran = await launch({ ...common, ownerToken, endpoint, phase: 'run', agentId, evidence: join(root, 'run.json'), userData: join(root, 'electron-run') }, root)
      expect(ran).toMatchObject({ ok: true, agentId, palette: edited.palette })
      expect(String(ran.summary)).toContain('renderer production run complete')
      expect(captured).toHaveLength(1)
      expect(captured[0].model.id).toBe(model.id)
      expect(captured[0].context.systemPrompt?.replace(/\r\n/g, '\n')).toBe('# Exact renderer prompt\n\nPreserve  two spaces.')
      expect(JSON.stringify(captured[0].context)).toContain('Run through the production renderer bridge.')
      expect(ran.runId).toEqual(expect.any(String))
      expect(ran.threadId).toEqual(expect.any(String))
      const history = JSON.parse(readFileSync(join(services.getProfileHomeDir(), 'agent-runs', String(ran.runId), 'run.json'), 'utf8'))
      expect(history).toMatchObject({ runId: ran.runId, threadId: ran.threadId, profileId, definitionId: agentId, state: 'completed' })
      expect(services.orchestrator.getMessages(String(ran.threadId)).map((message) => message.content))
        .toEqual(expect.arrayContaining(['Run through the production renderer bridge.', 'renderer production run complete']))
      expect(await services.platform.workflowRuns.runtime.list({ profileId })).toEqual([])
    } finally { await protocol.stop(); await main.stop() }
  }, 120_000)
})
