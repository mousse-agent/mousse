import { existsSync, readFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { getMousseHomeDir } from '../src/mms/data/paths'
import { ProviderAuthService } from '../src/mms/providers/ProviderAuthService'
import { createIsolatedMousseHome } from './setup/isolatedMousseHome'

describe('Vitest default Mousse home', () => {
  it('routes a default provider store to disposable test data', async () => {
    const home = getMousseHomeDir()
    expect(home).not.toBe(join(homedir(), '.mousse'))
    expect(relative(tmpdir(), home)).toMatch(/^mousse-vitest-/)
    const service = new ProviderAuthService()
    try {
      await service.credentials.modify('fixture', async () => ({ type: 'api_key', key: 'synthetic-test-only' }))
      expect(JSON.parse(readFileSync(join(home, 'auth.json'), 'utf8')).fixture.type).toBe('api_key')
    } finally {
      service.stop()
    }
  })

  it('replaces inherited app data, preserves explicit fixtures and cleans up only its owned directory', () => {
    const environment = { MOUSSE_HOME: 'inherited-installation', HOME: 'user-home', USERPROFILE: 'user-profile' }
    const isolated = createIsolatedMousseHome(environment)
    expect(environment.MOUSSE_HOME).toBe(isolated.home)
    expect(environment.HOME).toBe('user-home')
    expect(environment.USERPROFILE).toBe('user-profile')
    environment.MOUSSE_HOME = 'explicit-fixture'
    isolated.ensureDefault()
    expect(environment.MOUSSE_HOME).toBe('explicit-fixture')
    environment.MOUSSE_HOME = ''
    isolated.ensureDefault()
    expect(environment.MOUSSE_HOME).toBe(isolated.home)
    isolated.cleanup()
    expect(existsSync(isolated.home)).toBe(false)
  })
})
