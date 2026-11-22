import { describe, expect, it } from 'vitest'
import { failureText } from '../../src/mms/bots/activation/BotEngine'
import { CODEX_BOT_VERSION_TEXT, codexBotSettingText } from '../../src/shared/harness/codexBotVersion'

/** What a bot's chat says when its turn ends failed, from the error its run recorded (`[code] message`, or a code). */
describe('bot failure text', () => {
  it("keeps a Codex refusal's own sentence when the run recorded it with its code in front", () => {
    expect(failureText(`[policy_unenforceable] ${CODEX_BOT_VERSION_TEXT}`)).toBe(CODEX_BOT_VERSION_TEXT)
    const setting = codexBotSettingText(['multi_env_copy_file'])
    expect(failureText(`[policy_unenforceable] ${setting}`)).toBe(setting)
  })

  it("says an unknown error's own words, on one line and capped, never a line that names no reason", () => {
    expect(failureText('[orchestrator_turn_failed] spawn codex ENOENT\n  at x')).toBe('I hit an error, so I stopped: spawn codex ENOENT at x')
    const long = failureText(`[some_new_code] ${'x'.repeat(500)}`)
    expect(long.length).toBeLessThan(260)
    expect(long.endsWith('…')).toBe(true)
    expect(failureText('The Codex app-server exited.')).toBe('I hit an error, so I stopped: The Codex app-server exited.')
    expect(failureText('some_new_code')).toBe('I hit an error (some_new_code), so I stopped. Try again.')
    expect(failureText('')).toBe('I hit an error, so I stopped. Try again.')
    expect(failureText('constructor')).toBe('I hit an error (constructor), so I stopped. Try again.')
    for (const reason of ['constructor', '[toString] x', '[x] y', 'bot_state_invalid', 'cancelled', 'failed', 'whatever', '[provider_error] rate limited'])
      expect(failureText(reason)).not.toMatch(/something went wrong/i)
  })

  it("keeps a provider's words and Mousse's own fixed lines, with or without the code in front", () => {
    expect(failureText('[provider_error] Rate limited (3 retries)')).toBe('The provider failed, so I stopped: Rate limited (3 retries)')
    expect(failureText('provider_error')).toBe('The provider failed, so I stopped. Try again.')
    expect(failureText('bot_grant_revoked')).toBe('My permissions changed, so I stopped.')
    expect(failureText('[bot_grant_revoked] revoked while running')).toBe('My permissions changed, so I stopped.')
  })
})
