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

  it('drops inherited credentials so a CLI started by a test cannot sign in with them', () => {
    const environment: NodeJS.ProcessEnv = {
      ANTHROPIC_AUTH_TOKEN: 'inherited', ANTHROPIC_BASE_URL: 'https://example.invalid', CLAUDE_CODE_OAUTH_TOKEN: 'inherited',
      OPENAI_API_KEY: 'inherited', AWS_PROFILE: 'inherited', GROK_AUTH_PATH: 'inherited', PATH: 'kept'
    }
    const isolated = createIsolatedMousseHome(environment)
    try {
      for (const name of ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY', 'AWS_PROFILE', 'GROK_AUTH_PATH']) {
        expect(environment[name]).toBeUndefined()
      }
      expect(environment.PATH).toBe('kept')
      expect(environment.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe(environment.CLAUDE_CONFIG_DIR)
      expect(environment.ANTHROPIC_CONFIG_DIR).toBe(join(isolated.home, 'anthropic'))
    } finally {
      isolated.cleanup()
    }
  })
})
