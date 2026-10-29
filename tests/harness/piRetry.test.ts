import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isRetryableAssistantError } from '@earendil-works/pi-ai'
import { afterEach, describe, expect, it } from 'vitest'
import { AppError } from '../../src/shared/errors'
import { isRetriesExhausted } from '../../src/shared/harness/types'
import { REQUEST_PATH_ERRORS } from '../../src/mms/harness/pi/extension/messages'
import { PI_RETRY_SETTINGS, piSettings, piShellPath, preparePiHome, worstCaseBackoffMs } from '../../src/mms/harness/pi/settings'

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('Pi retries (configured, never Mousse’s own)', () => {
  it('writes Pi’s own bounded retry with SDK retries off, worst case within 50 s', () => {
    expect(PI_RETRY_SETTINGS).toEqual({ enabled: true, maxRetries: 5, baseDelayMs: 1600, provider: { maxRetries: 0 } })
    expect(worstCaseBackoffMs()).toBe(49_600)
    expect(worstCaseBackoffMs()).toBeLessThanOrEqual(50_000)
    expect(piSettings()).toMatchObject({ defaultProjectTrust: 'never', retry: PI_RETRY_SETTINGS, compaction: { enabled: true }, cacheWarming: 'off' })
  })

  it('Pi does not retry any text Mousse raises on the request path, and none has a digit', () => {
    for (const message of REQUEST_PATH_ERRORS) {
      expect(isRetryableAssistantError({ stopReason: 'error', errorMessage: message } as never), message).toBe(false)
      expect(/\d/.test(message), message).toBe(false)
    }
  })

  it('reads retriesExhausted from a turn error’s details', () => {
    const exhausted = new AppError({ code: 'provider_unavailable', message: 'x', errorInfo: { category: 'unavailable', retryable: true }, details: { retriesExhausted: true } })
    const plain = new AppError({ code: 'provider_unavailable', message: 'x', errorInfo: { category: 'unavailable', retryable: true } })
    expect(isRetriesExhausted(exhausted)).toBe(true)
    expect(isRetriesExhausted(plain)).toBe(false)
    expect(isRetriesExhausted(new Error('x'))).toBe(false)
  })
})

describe('Pi’s private agent dir', () => {
  it('holds only Mousse-written files: settings.json is written, anything else removed', () => {
    const home = mkdtempSync(join(tmpdir(), 'mousse-pi-home-'))
    scratch.push(home)
    writeFileSync(join(home, 'models.json'), '{}')
    mkdirSync(join(home, 'extensions'))
    writeFileSync(join(home, 'auth.json'), '{}')
    preparePiHome(home, { shellPath: 'C:\\Git\\bin\\bash.exe' })
    expect(JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8'))).toMatchObject({ defaultProjectTrust: 'never', shellPath: 'C:\\Git\\bin\\bash.exe' })
    expect(() => readFileSync(join(home, 'models.json'))).toThrow()
    expect(() => readFileSync(join(home, 'extensions'))).toThrow()
    expect(readFileSync(join(home, 'auth.json'), 'utf8')).toBe('{}')
  })

  it('points Pi at Git Bash on Windows, never WSL’s bash', () => {
    const files = new Set(['C:\\Users\\me\\AppData\\Local\\Programs\\Git\\bin\\bash.exe', 'C:\\Windows\\System32\\bash.exe', 'D:\\Tools\\Git\\cmd\\git.exe', 'D:\\Tools\\Git\\bin\\bash.exe'])
    const exists = (path: string) => files.has(path)
    expect(piShellPath({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local', PATH: 'C:\\Windows\\System32' }, exists }))
      .toBe('C:\\Users\\me\\AppData\\Local\\Programs\\Git\\bin\\bash.exe')
    expect(piShellPath({ platform: 'win32', env: { PATH: 'C:\\Windows\\System32;D:\\Tools\\Git\\cmd' }, exists })).toBe('D:\\Tools\\Git\\bin\\bash.exe')
    expect(piShellPath({ platform: 'win32', env: { PATH: 'C:\\Windows\\System32' }, exists })).toBeUndefined()
    expect(piShellPath({ platform: 'linux', env: {}, exists })).toBeUndefined()
  })
})
