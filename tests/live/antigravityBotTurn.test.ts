/**
 * Live check of a bot's turn on the real `agy`: one Ask-mode turn whose permission and file requests are answered by a
 * bot authority (`AcpChatInput.botAuthority`), never a person: the real one, granted files and commands in the turn's
 * folder only; the test records what the real agent asked for, with which ACP kinds and paths, and checks that
 * the allowed file exists and the refused one does not, and that the agent still runs the step after the refusal
 * and replies. It reuses this computer's existing `agy` sign-in and never
 * signs in or out. Only with MOUSSE_LIVE_AGY=1; MOUSSE_LIVE_AGY_MODEL picks the model (default `gemini-4-hydrogen`).
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { AntigravityProviderService } from '../../src/mms/harness/acp/presets/antigravity/AntigravityProviderService'
import { agyStandalonePaths, cliNames, findOnPath } from '../../src/mms/harness/env'
import { UserQuestionService } from '../../src/mms/orchestrator/UserQuestionService'
import { createBotAuthority } from '../../src/mms/bots/authority/botAuthority'
import { RunCounters } from '../../src/mms/harness/budget'
import type { BotAuthority, NormalisedCall } from '../../src/shared/bots/personal/authority'

const live = process.env.MOUSSE_LIVE_AGY === '1'
const binary = process.env.MOUSSE_AGY_BINARY || findOnPath(cliNames('agy'), { env: process.env, searchPath: agyStandalonePaths() })
const model = process.env.MOUSSE_LIVE_AGY_MODEL || 'gemini-4-hydrogen'
const dirs: string[] = []
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }) })

describe.runIf(live && binary)('a bot turn on the real agy', () => {
  it("answers the agent's requests with the bot's authority and asks nobody", async () => {
    const home = mkdtempSync(join(tmpdir(), 'mousse-live-agy-bot-'))
    const cwd = mkdtempSync(join(tmpdir(), 'mousse-live-agy-bot-work-'))
    const outsideDir = mkdtempSync(join(tmpdir(), 'mousse-live-agy-bot-outside-'))
    dirs.push(home, cwd, outsideDir)
    const allowed = join(cwd, 'allowed.txt')
    const refused = join(outsideDir, 'refused.txt')
    const questions = new UserQuestionService()
    const asked = vi.spyOn(questions, 'requestAnswers')
    const service = new AntigravityProviderService(home, home, questions, undefined, { findUserAgy: () => binary })
    const checked: NormalisedCall[] = []
    const scratch = mkdtempSync(join(tmpdir(), 'mousse-live-agy-bot-scratch-'))
    dirs.push(scratch)
    const base = createBotAuthority({
      activationId: 'live-activation',
      role: 'activation',
      permissions: { tools: ['read', 'list', 'search', 'edit', 'write', 'shell'], appTools: [], mcp: [], skills: [], workspace: { roots: [cwd], access: 'write', scratch } },
      waiting: () => false,
      counters: new RunCounters(),
      time: { deadline: () => Number.MAX_SAFE_INTEGER, signal: new AbortController().signal },
      spend: null
    })
    const bot: Pick<BotAuthority, 'check'> = { check: (call) => { checked.push(call); return base.check(call) } }
    try {
      expect(await service.checkSignedIn(home)).toBe(true)
      const started = Date.now()
      const text = await service.chat({
        threadId: 'live-bot-thread',
        cwd,
        model,
        permissionMode: 'ask',
        bot: true,
        botAuthority: bot,
        prompt: [
          'Do these three steps with your tools, one after the other, and do not skip any:',
          `1. Create the file ${allowed} containing exactly: hello from the bot`,
          `2. Create the file ${refused} containing exactly: should not exist`,
          '3. Run the shell command: echo bot-command-ran',
          'If a step is refused, say so and go on with the next one. Finish with one line per step saying what happened.'
        ].join('\n'),
        onText: () => {},
        onTool: (event) => console.info(`tool: ${JSON.stringify(event).slice(0, 300)}`),
        signal: AbortSignal.timeout(240_000)
      })
      console.info(`agy ${model} bot turn in ${Date.now() - started} ms`)
      console.info(`checked: ${JSON.stringify(checked.map((call) => call.kind === 'builtin' ? { tool: call.tool, native: call.nativeName, path: call.args.path } : call))}`)
      console.info(`answer: ${text}`)
      expect(asked).not.toHaveBeenCalled()
      expect(existsSync(refused)).toBe(false)
      expect(existsSync(allowed) ? readFileSync(allowed, 'utf8').trim() : '').toBe('hello from the bot')
      // Antigravity ends its prompt after a denial; Mousse tells it what was refused, and it finishes the rest.
      expect(checked.some((call) => call.kind === 'builtin' && call.tool === 'shell')).toBe(true)
      expect(text.trim().length).toBeGreaterThan(0)
    } finally { service.stop() }
  }, 300_000)
})
