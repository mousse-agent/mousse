/**
 * Live check of Antigravity on the real `agy`: Mousse finds it, starts it as `agy acp` on a private
 * profile, reads whether this computer's `agy` is already signed in by opening one session, and reads
 * its plan limits with `agy -p /usage`. It never signs in or out, and runs no model turn. Only with
 * MOUSSE_LIVE_AGY=1; MOUSSE_AGY_BINARY may name the executable (else the one on PATH or in Google's
 * install folder).
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { AntigravityProviderService } from '../../src/mms/harness/acp/presets/antigravity/AntigravityProviderService'
import { agyStandalonePaths, cliNames, findOnPath } from '../../src/mms/harness/env'
import { UserQuestionService } from '../../src/mms/orchestrator/UserQuestionService'

const live = process.env.MOUSSE_LIVE_AGY === '1'
const binary = process.env.MOUSSE_AGY_BINARY || findOnPath(cliNames('agy'), { env: process.env, searchPath: agyStandalonePaths() })
const homes: string[] = []
afterAll(() => { for (const home of homes) rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }) })

describe.runIf(live && binary)('Antigravity on the real agy', () => {
  it('runs the user\'s agy and reads its existing sign-in without signing in', async () => {
    const home = mkdtempSync(join(tmpdir(), 'mousse-live-agy-'))
    homes.push(home)
    const service = new AntigravityProviderService(home, home, new UserQuestionService(), undefined, { findUserAgy: () => binary })
    try {
      const config = await service.cliConfig()
      expect(config.resolvedBinaryPath).toBe(binary)
      expect(config.version).toMatch(/^\d+\.\d+\.\d+/)
      const started = Date.now()
      // True only where this computer's agy is signed in; the run says which.
      const signedIn = await service.checkSignedIn(home)
      console.info(`agy ${config.version}: signed in ${signedIn}, checked in ${Date.now() - started} ms`)
      if (signedIn) expect(service.models().length).toBeGreaterThan(0)
    } finally { service.stop() }
  }, 60_000)

  it('keeps an added entry\'s sign-in in its own home: a home never signed in reads no sign-in, whatever this computer\'s agy has', async () => {
    const home = mkdtempSync(join(tmpdir(), 'mousse-live-agy-'))
    homes.push(home)
    const stateDir = join(home, 'harness', 'antigravity_antigravity-2')
    const entry = { instanceId: 'antigravity:antigravity-2', stateDir, home: join(stateDir, 'home') }
    const service = new AntigravityProviderService(home, home, new UserQuestionService(), undefined, { entry, findUserAgy: () => binary })
    try {
      // `agy` answers "Authentication required" in the home, never with the keyring's sign-in.
      expect(await service.checkSignedIn(home)).toBe(false)
      expect(service.isolationProblem()).toBeUndefined()
      const logs = join(entry.home, 'gemini-home', 'antigravity-acp', 'log')
      const text = readdirSync(logs).map((name) => readFileSync(join(logs, name), 'utf8')).join('\n')
      expect(text).toContain('Using file-based token storage because AGY_CLI_FORCE_FILE_TOKEN_STORAGE is set')
    } finally { service.stop() }
  }, 60_000)

  it('reads the plan limits with `agy -p /usage`, without a turn', async () => {
    const home = mkdtempSync(join(tmpdir(), 'mousse-live-agy-'))
    homes.push(home)
    const service = new AntigravityProviderService(home, home, new UserQuestionService(), undefined, { findUserAgy: () => binary })
    try {
      const started = Date.now()
      const usage = await service.usage(AbortSignal.timeout(30_000))
      console.info(`agy limits in ${Date.now() - started} ms: ${usage.windows.map((window) => `${window.label} ${window.remainingPercent}%`).join(', ')}`)
      expect(usage.status).toBe('available')
      expect(usage.windows.length).toBeGreaterThan(0)
    } finally { service.stop() }
  }, 60_000)
})
