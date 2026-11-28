/**
 * Grok's account route (`acp:grok`) with the account already signed in on this computer: the runtime's transport, on
 * the user's own home, reads that sign-in in place (`GROK_AUTH_PATH`) from a home of the request's own and returns the
 * model's text. It never signs in or out. Only with MOUSSE_LIVE_GROK_ACCOUNT=1 and a
 * Grok sign-in already present; MOUSSE_GROK_BINARY may name the executable (else the `grok` on PATH), MOUSSE_GROK_HOME the home.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { DriverContext } from '../../src/mms/harness/driver'
import { grokDriver } from '../../src/mms/harness/drivers/grok'
import { cliNames, findOnPath, instanceEnv } from '../../src/mms/harness/env'
import { UserQuestionService } from '../../src/mms/orchestrator/UserQuestionService'

const live = process.env.MOUSSE_LIVE_GROK_ACCOUNT === '1'
const binary = process.env.MOUSSE_GROK_BINARY || findOnPath(cliNames('grok'), { env: process.env, searchPath: [] })
// Tests run with a home of their own (`tests/setup`): MOUSSE_GROK_HOME names the real one.
const grokHome = process.env.MOUSSE_GROK_HOME || process.env.GROK_HOME || join(homedir(), '.grok')
const auth = join(grokHome, 'auth.json')
const roots: string[] = []
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }) })

describe.runIf(live && binary && existsSync(auth))('a Grok one-shot on the signed-in account', () => {
  it('names a chat from Mousse’s prompt and leaves the sign-in where it is', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mousse-live-grok-one-shot-'))
    roots.push(root)
    const signedIn = Object.keys(JSON.parse(readFileSync(auth, 'utf8')) as Record<string, unknown>)
    const context: DriverContext = {
      instanceId: 'grok', builtIn: true, config: { binaryPath: binary! },
      env: instanceEnv({ instanceId: 'grok', driver: 'grok', configRevision: 0, searchPath: [], base: { ...process.env, GROK_HOME: grokHome } }),
      profileHome: root, installationHome: root, stateDir: join(root, 'state'), questions: new UserQuestionService(), findBinary: () => binary, changed: () => {}
    }
    const runtime = grokDriver().create(context)
    try {
      const started = Date.now()
      const events = { activity: () => {}, text: () => {}, tool: () => {}, launching: () => {}, sending: () => {} }
      const text = await runtime.oneShotTransport!({ model: 'default' }).send({
        model: 'default',
        system: 'You name chats. Reply with a title of at most six words, and nothing else.',
        prompt: 'User request: the login page shows a blank screen after the password is entered'
      }, events, AbortSignal.timeout(90_000))
      console.log(JSON.stringify({ text, ms: Date.now() - started }))
      expect(text.trim().length).toBeGreaterThan(0)
      expect(text.length).toBeLessThan(120)
      // The account is the same one, in the same file; the request's own place is gone.
      expect(readdirSync(join(root, 'one-shot'))).toEqual([])
      expect(Object.keys(JSON.parse(readFileSync(auth, 'utf8')) as Record<string, unknown>)).toEqual(signedIn)
      expect(statSync(auth).isFile()).toBe(true)
    } finally {
      runtime.stop()
    }
  }, 120_000)
})
