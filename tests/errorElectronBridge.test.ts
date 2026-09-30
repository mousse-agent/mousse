import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import electron from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MousseMainService } from '../src/mms/MousseMainService'
import { ProviderAuthService } from '../src/mms/providers/ProviderAuthService'
import { MmsProtocolServer } from '../src/mms/protocol/server'
import { createErrorProvider } from '../src/shared/errors'

const roots: string[] = []
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('production Electron error bridge', () => {
  it('preserves daemon errors through real GUI IPC handlers, preload and contextBridge', async () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), 'mousse-error-electron-')); roots.push(root)
    const home = join(root, 'home')
    vi.spyOn(ProviderAuthService.prototype, 'init').mockResolvedValue(undefined)
    const main = await MousseMainService.create({ homeDir: home, headless: true, ownerKind: 'test' })
    await main.start()
    const fixtureErrors = createErrorProvider({ fixture_denied: { category: 'denied', retryable: false, message: 'Fixture integration access denied.' } })
    const originalDispatch = main.domains.dispatch.bind(main.domains)
    vi.spyOn(main.domains, 'dispatch').mockImplementation((context, method, params) => {
      if (method === 'integrations.snapshot') throw fixtureErrors.create('fixture_denied', new Error('private raw cause'), { operationId: 'fixture-operation' })
      return originalDispatch(context, method, params)
    })
    const ownerToken = main.getOwnerLease()!.owner.token
    const server = new MmsProtocolServer({ mms: main, ownerToken, version: 'fixture' })
    try {
      const endpoint = await server.start()
      const mainBundle = join(root, 'electron-main.cjs'), preload = join(root, 'preload.cjs')
      // External runtime packages resolve only to this checkout's dependencies.
      symlinkSync(resolve('node_modules'), join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
      await build({ entryPoints: [resolve('tests/fixtures/repository-upgrades/electron-error-bridge.ts')], outfile: mainBundle,
        bundle: true, platform: 'node', format: 'cjs', packages: 'external', logLevel: 'silent' })
      await build({ entryPoints: [resolve('src/preload/index.ts')], outfile: preload,
        bundle: true, platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'silent' })
      const evidence = join(root, 'evidence.json'), configPath = join(root, 'config.json')
      writeFileSync(configPath, JSON.stringify({ home, endpoint, ownerToken, preload, evidence, userData: join(root, 'electron-data') }))
      const env = { ...process.env, MOUSSE_ERROR_BRIDGE_CONFIG: configPath, MOUSSE_HOME: home }; delete env.ELECTRON_RUN_AS_NODE
      const result = await new Promise<{ code: number | null; stderr: string }>((done, reject) => {
        const child = spawn(electron as unknown as string, [mainBundle], { cwd: process.cwd(), env, stdio: ['ignore', 'ignore', 'pipe'] })
        let stderr = ''
        const timeout = setTimeout(() => { child.kill(); reject(new Error('Electron bridge fixture timed out: ' + stderr)) }, 35_000)
        child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-6000) })
        child.once('error', (error) => { clearTimeout(timeout); reject(error) })
        child.once('exit', (code) => { clearTimeout(timeout); done({ code, stderr }) })
      })
      expect(result.code, result.stderr).toBe(0)
      const observed = JSON.parse(readFileSync(evidence, 'utf8'))
      expect(observed).toMatchObject({ ok: true, bridgeExposed: true,
        chat: { requestAcknowledged: false, error: { code: 'thread_not_found', message: 'Thread not found', errorInfo: { category: 'internal', retryable: false }, details: { threadId: 'missing_fixture_thread' } } },
        platform: { code: 'fixture_denied', message: 'Fixture integration access denied.', details: { operationId: 'fixture-operation' }, errorInfo: { category: 'denied', retryable: false } }
      })
      expect(JSON.stringify(observed)).not.toContain('private raw cause')
      expect(observed.controlledNativeFailure).toMatchObject({
        chat: { requestAcknowledged: false, error: { code: 'internal_error', errorInfo: { category: 'internal', retryable: false } } },
        platform: { code: 'platform_request_failed', errorInfo: { category: 'internal', retryable: false } }
      })
      for (const error of [observed.controlledNativeFailure.chat.error, observed.controlledNativeFailure.platform]) {
        expect(error.details.supportId).toMatch(/^[0-9a-f-]{36}$/)
        expect(error.message).toContain(error.details.supportId)
        expect(error.details).toEqual({ supportId: error.details.supportId })
      }
      expect(JSON.stringify(observed.controlledNativeFailure)).not.toMatch(/ENOENT|privateFixture|secret-auth|no such file/)
    } finally { await server.stop(); await main.stop() }
  }, 45_000)
})
