/**
 * Older Claude models found after a model refresh returned reach open windows: the check that finds
 * them runs in the background, so the gateway hears about each one through the runtime's `changed`.
 * Fake Claude Code only, with made-up models; no sign-in runs.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Query } from '@anthropic-ai/claude-agent-sdk'
import { afterEach, expect, it, vi } from 'vitest'
import { claudeCodeDriver } from '../../src/mms/harness/drivers/claudeCode'
import { createHarnessGateway, type HarnessGatewayEvent } from '../../src/mms/harness/gateway'
import { ProviderInstanceService } from '../../src/mms/harness/instanceMap'
import { UserQuestionService } from '../../src/mms/orchestrator/UserQuestionService'
import { ClaudeSubscriptionProviderService } from '../../src/mms/harness/vendors/claude/ClaudeSubscriptionProviderService'
import { parseModelCatalog } from '../../src/shared/modelCatalog'

const dirs: string[] = []
const stops: Array<() => void> = []
afterEach(() => {
  for (const stop of stops.splice(0)) stop()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

/** A `claude` that only prints its version: a node script, behind an npm-style shim on Windows. */
function fakeClaude(): string {
  const dir = tempDir('mousse-fakeclaude-')
  mkdirSync(join(dir, 'node_modules', 'claude'), { recursive: true })
  const script = join(dir, 'node_modules', 'claude', 'cli.js')
  writeFileSync(join(dir, 'node_modules', 'claude', 'package.json'), JSON.stringify({ name: 'claude' }))
  writeFileSync(script, "#!/usr/bin/env node\nif (process.argv.includes('--version')) console.log('2.1.300 (Claude Code)')\n")
  if (process.platform === 'win32') {
    const shim = join(dir, 'claude.cmd')
    writeFileSync(shim, `@ECHO off\r\n"%~dp0\\node_modules\\claude\\cli.js" %*\r\n`)
    return shim
  }
  chmodSync(script, 0o755)
  return script
}

const catalog = parseModelCatalog({
  format: 1,
  revision: 1,
  models: [
    { id: 'ember-live', name: 'Claude Ember 9', short: 'Ember 9', maker: 'anthropic', released: '2031-01-01', routes: { claude: { id: 'ember-live' } } },
    { id: 'ember-old', name: 'Claude Ember 8', short: 'Ember 8', maker: 'anthropic', released: '2030-01-01', older: true, routes: { claude: { id: 'ember-old' } } }
  ]
})

it('tells open windows about an older model the background check finds after the refresh returned', async () => {
  const profileHome = tempDir('mousse-claude-older-')
  const binary = fakeClaude()
  // `get_settings` answers for the older model only once the test lets it: the refresh has returned by then.
  let release = () => {}
  const held = new Promise<void>((resolve) => (release = resolve))
  // Each discovery query is its own Claude Code process, with its own applied model.
  const discovery = () => {
    let applied = 'ember'
    return Object.assign((async function* () {})(), {
      close: vi.fn(),
      interrupt: async () => {},
      supportedModels: async () => [{ value: 'ember', resolvedModel: 'ember-live', displayName: 'Ember', description: 'Ember 9 · test model' }],
      setModel: async (model: string) => { applied = model },
      getSettings: async () => {
        if (applied === 'ember-old') await held
        return { applied: { model: applied } }
      }
    }) as unknown as Query
  }
  const builtIn = new ClaudeSubscriptionProviderService(profileHome, new UserQuestionService(), {
    findBinary: () => binary,
    runAuth: async () => JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max' }),
    query: discovery as never,
    modelCatalog: () => catalog
  })
  let stored: unknown = { claude: { driver: 'claude', enabled: true } }
  const harness = createHarnessGateway({
    profileHome,
    installationHome: profileHome,
    instanceMap: new ProviderInstanceService({ store: { read: () => ({ instances: stored, seedVersion: 1 }), write: (next) => { stored = next.instances } } }),
    questions: new UserQuestionService(),
    shellPath: async () => ({ entries: [dirname(binary)], source: 'login_shell' }),
    drivers: [claudeCodeDriver({ builtIn: () => builtIn })]
  })
  stops.push(() => { harness.stop(); builtIn.stop() })
  const events: HarnessGatewayEvent[] = []
  stops.push(harness.instances.subscribe((event) => events.push(event)))
  const olderIn = (event: HarnessGatewayEvent) =>
    event.type === 'snapshots' &&
    event.data.snapshots.some((snapshot) => snapshot.instanceId === 'claude' && snapshot.models.entries.some((model) => model.id === 'ember-old' && model.older))

  const snapshot = await harness.instances.refreshModels('claude')
  expect(snapshot.models.entries.map((model) => model.id)).toEqual(['ember'])
  expect(events.some(olderIn)).toBe(false)
  // The check finds the model after the refresh returned; a window hears about it without another refresh.
  release()
  await builtIn.olderCheck
  await vi.waitFor(() => expect(events.some(olderIn)).toBe(true))
})

it('checks the models a newer catalog adds once the catalog changes, without asking about the others again', async () => {
  const profileHome = tempDir('mousse-claude-catalog-')
  const binary = fakeClaude()
  const switched: string[] = []
  const discovery = () => {
    let applied = 'ember'
    return Object.assign((async function* () {})(), {
      close: vi.fn(),
      interrupt: async () => {},
      supportedModels: async () => [{ value: 'ember', resolvedModel: 'ember-live', displayName: 'Ember', description: 'Ember 9 · test model' }],
      setModel: async (model: string) => { switched.push(model); applied = model },
      getSettings: async () => ({ applied: { model: applied } })
    }) as unknown as Query
  }
  let current = catalog
  const builtIn = new ClaudeSubscriptionProviderService(profileHome, new UserQuestionService(), {
    findBinary: () => binary,
    runAuth: async () => JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max' }),
    query: discovery as never,
    modelCatalog: () => current
  })
  let stored: unknown = { claude: { driver: 'claude', enabled: true } }
  const harness = createHarnessGateway({
    profileHome,
    installationHome: profileHome,
    instanceMap: new ProviderInstanceService({ store: { read: () => ({ instances: stored, seedVersion: 1 }), write: (next) => { stored = next.instances } } }),
    questions: new UserQuestionService(),
    shellPath: async () => ({ entries: [dirname(binary)], source: 'login_shell' }),
    drivers: [claudeCodeDriver({ builtIn: () => builtIn })]
  })
  stops.push(() => { harness.stop(); builtIn.stop() })
  await harness.instances.refreshModels('claude')
  await builtIn.olderCheck
  expect(switched).toContain('ember-old')
  // Any refresh the first sign-in check started in the background has finished too.
  await vi.waitFor(() => expect(builtIn.olderCheck).toBeUndefined())

  current = parseModelCatalog({
    format: 1,
    revision: 2,
    models: [...catalog.models, { id: 'ember-older', name: 'Claude Ember 7', short: 'Ember 7', maker: 'anthropic', released: '2029-01-01', older: true, routes: { claude: { id: 'ember-older' } } }]
  })
  switched.length = 0
  const refreshes = vi.spyOn(builtIn, 'refreshModels')
  harness.modelCatalogChanged()
  await vi.waitFor(() => expect(builtIn.models().map((model) => model.id)).toEqual(['ember', 'ember-old', 'ember-older']))
  expect(refreshes).toHaveBeenCalled()
  expect(switched).toContain('ember-older')
  expect(switched).not.toContain('ember-old')
})
