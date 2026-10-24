import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, relative, isAbsolute, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { developmentRuntime, developmentDaemonInvocation, developmentUsesGlobalHome } from '../scripts/development-runtime.mjs'

const fixture = mkdtempSync(join(tmpdir(), 'mousse-platform-dev-'))
const first = join(fixture, 'first')
const second = join(fixture, 'second')
const shared = join(fixture, 'shared')
mkdirSync(first)
mkdirSync(second)
mkdirSync(join(shared, '.mousse-dev'), { recursive: true })
writeFileSync(join(shared, '.mousse-dev', 'dev.json'), JSON.stringify({ useGlobalHome: true }))
afterAll(() => {
  const rel = relative(realpathSync(tmpdir()), realpathSync(fixture))
  if (!rel.startsWith('mousse-platform-dev-') || rel.startsWith('..') || isAbsolute(rel)) throw new Error('Unsafe fixture cleanup')
  rmSync(fixture, { recursive: true, force: true })
})

describe('worktree development runtime', () => {
  it('isolates all mutable development roots and keeps the same checkout stable', () => {
    const a = developmentRuntime(first, {})
    const b = developmentRuntime(second, {})
    expect(developmentRuntime(first, {})).toEqual(a)
    for (const key of ['homeDir', 'electronUserData', 'browserRoot', 'artifactRoot']) expect(a[key]).not.toBe(b[key])
    expect(a.homeDir).toBe(join(realpathSync(first), '.mousse-dev', 'runtime'))
    expect(a.electronUserData.startsWith(a.homeDir)).toBe(true)
    expect(a.rendererPort).toBeGreaterThanOrEqual(5100)
    expect(a.rendererPort).toBeLessThan(6000)
  })

  it('respects explicit roots without mutating the caller environment', () => {
    const env = { MOUSSE_HOME: fixture, MOUSSE_RENDERER_PORT: '6123', MOUSSE_ELECTRON_USER_DATA: join(fixture, 'gui') }
    const copy = { ...env }
    const result = developmentRuntime(first, env)
    expect(result.homeDir).toBe(fixture)
    expect(result.electronUserData).toBe(env.MOUSSE_ELECTRON_USER_DATA)
    expect(result.rendererPort).toBe(6123)
    expect(env).toEqual(copy)
  })

  it.each(['0', '80', '65536', '5198.5', 'NaN', '-1'])('rejects invalid port %s before processes start', (port) => {
    expect(() => developmentRuntime(first, { MOUSSE_RENDERER_PORT: port })).toThrow('MOUSSE_RENDERER_PORT')
  })
})

 it('launches development MMS in the same isolated Electron context without run-as-node', () => {
   const env = { ELECTRON_RUN_AS_NODE: '1', MOUSSE_CLI: '1' }
   const invocation = developmentDaemonInvocation(first, env)
   const runtime = developmentRuntime(first, env)
   expect(invocation.argsPrefix).toEqual([join(first, 'out/cli/index.js')])
   expect(invocation.env.MOUSSE_HOME).toBe(runtime.homeDir)
   expect(invocation.env.MOUSSE_ELECTRON_USER_DATA).toBe(runtime.electronUserData)
   expect(invocation.env.ELECTRON_RUN_AS_NODE).toBeUndefined()
   expect(invocation.env.MOUSSE_CLI).toBeUndefined()
   expect(env.ELECTRON_RUN_AS_NODE).toBe('1')
 })

it('rejects a shared global development home before starting processes', () => {
  expect(() => developmentRuntime(first, { MOUSSE_HOME: join(homedir(), '.mousse') })).toThrow('Development cannot share')
})

describe('shared global development home', () => {
  const globalHome = join(homedir(), '.mousse')

  it('uses the installed home and leaves vault, browser and artifact roots to the app', () => {
    const env = { MOUSSE_DEV_USE_GLOBAL: '1', MOUSSE_ELECTRON_USER_DATA: '/stale', MOUSSE_BROWSER_ROOT: '/stale' }
    const runtime = developmentRuntime(first, { MOUSSE_DEV_USE_GLOBAL: '1' })
    expect(runtime).toMatchObject({ homeDir: globalHome, sharedGlobalHome: true, electronUserData: null, browserRoot: null, artifactRoot: null })
    const invocation = developmentDaemonInvocation(first, { MOUSSE_DEV_USE_GLOBAL: '1', MOUSSE_BROWSER_ROOT: '' })
    expect(invocation.env.MOUSSE_HOME).toBe(globalHome)
    for (const key of ['MOUSSE_ELECTRON_USER_DATA', 'MOUSSE_BROWSER_ROOT', 'MOUSSE_ARTIFACT_ROOT']) expect(invocation.env).not.toHaveProperty(key)
    // Explicit overrides still apply.
    expect(developmentRuntime(first, env).electronUserData).toBe(resolve('/stale'))
  })

  it('is the checkout default with dev.json, and the flag overrides it either way', () => {
    expect(developmentUsesGlobalHome(first, {})).toBe(false)
    expect(developmentUsesGlobalHome(shared, {})).toBe(true)
    expect(developmentUsesGlobalHome(shared, { MOUSSE_DEV_USE_GLOBAL: '0' })).toBe(false)
    expect(developmentUsesGlobalHome(first, { MOUSSE_DEV_USE_GLOBAL: 'true' })).toBe(true)
    expect(developmentRuntime(shared, { MOUSSE_DEV_USE_GLOBAL: '0' }).homeDir).toBe(join(realpathSync(shared), '.mousse-dev', 'runtime'))
  })

  it('rejects an unclear flag or a conflicting home', () => {
    expect(() => developmentUsesGlobalHome(first, { MOUSSE_DEV_USE_GLOBAL: 'maybe' })).toThrow('MOUSSE_DEV_USE_GLOBAL must be 1 or 0')
    expect(() => developmentRuntime(first, { MOUSSE_DEV_USE_GLOBAL: '1', MOUSSE_HOME: fixture })).toThrow('conflicts with MOUSSE_HOME')
    expect(developmentRuntime(first, { MOUSSE_DEV_USE_GLOBAL: '1', MOUSSE_HOME: globalHome }).homeDir).toBe(globalHome)
  })
})
