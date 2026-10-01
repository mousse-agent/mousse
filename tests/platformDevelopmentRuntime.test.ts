import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, relative, isAbsolute } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { developmentRuntime, developmentDaemonInvocation } from '../scripts/development-runtime.mjs'

const fixture = mkdtempSync(join(tmpdir(), 'mousse-platform-dev-'))
const first = join(fixture, 'first')
const second = join(fixture, 'second')
mkdirSync(first)
mkdirSync(second)
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
