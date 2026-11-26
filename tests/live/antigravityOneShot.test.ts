/**
 * Live check of an Antigravity single request (a chat title) on the real `agy`, on this computer's existing sign-in:
 * it never signs in or out. It runs one title prompt that needs no tools, on the one-shot launch, and reads what
 * `agy` logged and left behind. Only with MOUSSE_LIVE_AGY=1; MOUSSE_AGY_BINARY may name the executable. Skipped
 * (with a line saying so) where `agy` is not signed in.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { AntigravityProviderService } from '../../src/mms/harness/acp/presets/antigravity/AntigravityProviderService'
import { agyStandalonePaths, cliNames, findOnPath } from '../../src/mms/harness/env'
import { UserQuestionService } from '../../src/mms/orchestrator/UserQuestionService'

const live = process.env.MOUSSE_LIVE_AGY === '1'
const binary = process.env.MOUSSE_AGY_BINARY || findOnPath(cliNames('agy'), { env: process.env, searchPath: agyStandalonePaths() })
const homes: string[] = []
afterAll(() => { for (const home of homes) rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }) })

describe.runIf(live && binary)('an Antigravity single request on the real agy', () => {
  it('names a chat on the one-shot launch, with its own settings, and leaves no session behind', async (context) => {
    const home = mkdtempSync(join(tmpdir(), 'mousse-live-agy-one-shot-'))
    homes.push(home)
    const service = new AntigravityProviderService(home, home, new UserQuestionService(), undefined, { findUserAgy: () => binary })
    try {
      if (!(await service.checkSignedIn(home))) {
        console.info('agy is not signed in on this computer: the single request was not run')
        context.skip()
      }
      const appData = join(home, 'providers', 'antigravity', 'gemini-home', 'antigravity-acp')
      const model = service.models()[0]!.id
      // What agy logged while it ran, read before its settings folder is removed.
      let log = ''
      const readLog = () => {
        for (const dir of existsSync(appData) ? readdirSync(appData).filter((name) => name.startsWith('one-shot-')) : []) {
          const logs = join(appData, dir, 'log')
          if (existsSync(logs)) log = readdirSync(logs).map((name) => readFileSync(join(logs, name), 'utf8')).join('\n')
        }
      }
      // The sign-in check's own session is saved already; the request adds none.
      const conversations = () => (existsSync(join(appData, 'conversations')) ? readdirSync(join(appData, 'conversations')) : []).filter((name) => name.endsWith('.db'))
      const before = conversations()
      const warned = vi.spyOn(console, 'warn')
      const started = Date.now()
      const { text } = await service.oneShot({
        model,
        system: 'You name chats. Reply with a title of at most six words.',
        prompt: 'User request: the login page loops back to itself after Google sign-in',
        onActivity: readLog
      }, AbortSignal.timeout(120_000))
      console.info(`agy one-shot on ${model} in ${Date.now() - started} ms: ${JSON.stringify(text)}`)
      expect(text.trim().length).toBeGreaterThan(0)
      // agy read the request's own settings file.
      expect(log).toContain('one-shot-')
      expect(log).not.toContain('Failed to load CLI settings')
      const lines = log.split('\n').filter((line) => /toolPermission|allowNonWorkspaceAccess|agentMode|customization/i.test(line))
      console.info(`agy log lines on permissions:\n${lines.map((line) => line.slice(0, 300)).join('\n') || '(none)'}`)
      // Nothing of the request stays: its settings folder, its scratch folder, its saved conversation.
      expect(readdirSync(appData).filter((name) => name.startsWith('one-shot-'))).toEqual([])
      expect(readdirSync(join(home, 'providers', 'antigravity', 'one-shot'))).toEqual([])
      expect(conversations()).toEqual(before)
      // The saved conversation named the request's folder, so it was removed, not kept.
      expect(warned).not.toHaveBeenCalledWith(expect.stringContaining('session files were kept'), expect.anything())
    } finally { service.stop() }
  }, 180_000)
})
