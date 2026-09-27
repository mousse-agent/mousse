import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { browserWorkerEnvironment } from '../src/mms/browser/workerEnvironment'

describe('browser worker environment boundary', () => {
  it('preserves only Windows AppContainer local app data among user directories', () => {
    const source = { LOCALAPPDATA: 'C:\\Users\\fixture\\AppData\\Local', APPDATA: 'private-roaming', USERPROFILE: 'private-home', OPENAI_API_KEY: 'secret' }
    expect(browserWorkerEnvironment(source, 'win32')).toEqual({ LOCALAPPDATA: source.LOCALAPPDATA, ELECTRON_RUN_AS_NODE: '1', MOUSSE_BROWSER_WORKER: '1' })
    for (const platform of ['linux', 'darwin'] as const) expect(browserWorkerEnvironment(source, platform)).toEqual({ ELECTRON_RUN_AS_NODE: '1', MOUSSE_BROWSER_WORKER: '1' })
  })
  it('passes the Linux sandbox helper without inheriting secrets or loader flags', () => {
    const sandbox = { CHROME_DEVEL_SANDBOX: '/opt/browser/chrome-sandbox' }
    const env = browserWorkerEnvironment({
      ...sandbox, HOME: '/home/browser', XDG_CONFIG_HOME: '/home/browser/config', PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT,
      OPENAI_API_KEY: 'fixture-secret', MOUSSE_OWNER_TOKEN: 'fixture-owner',
      NODE_OPTIONS: '--require=untrusted-module', LD_PRELOAD: '/untrusted.so',
      ELECTRON_RUN_AS_NODE: '0', MOUSSE_BROWSER_WORKER: '0'
    }, 'linux')
    // Exercise the actual child boundary, including forced worker mode and exclusions.
    const childEnv = JSON.parse(execFileSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(process.env))'], { env, encoding: 'utf8' }))
    expect(childEnv).toMatchObject({ ...sandbox, ELECTRON_RUN_AS_NODE: '1', MOUSSE_BROWSER_WORKER: '1' })
    for (const key of ['OPENAI_API_KEY', 'MOUSSE_OWNER_TOKEN', 'NODE_OPTIONS', 'LD_PRELOAD', 'HOME', 'XDG_CONFIG_HOME']) expect(childEnv).not.toHaveProperty(key)
  })

  it('keeps Linux-only settings out of other platforms and omits unset values', () => {
    expect(browserWorkerEnvironment({ HOME: '/home/browser', CHROME_DEVEL_SANDBOX: '/helper', TEMP: '/tmp' }, 'win32'))
      .toEqual({ TEMP: '/tmp', ELECTRON_RUN_AS_NODE: '1', MOUSSE_BROWSER_WORKER: '1' })
    expect(browserWorkerEnvironment({}, 'linux')).toEqual({ ELECTRON_RUN_AS_NODE: '1', MOUSSE_BROWSER_WORKER: '1' })
  })
})
