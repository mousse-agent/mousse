import { describe, expect, it } from 'vitest'
import { CODEX_BOT_VERSION_NEWER_TEXT, CODEX_BOT_VERSION_UNKNOWN_TEXT, codexBotVersionRefusal, codexVersionOf } from '../../src/shared/harness/codexBotVersion'

/**
 * Which Codex runs a bot's turn: only a version whose tools were read from the real binary and accounted for. The real
 * user agent's form is checked on the pinned binary in `codexBotTools.test.ts`.
 */
describe('a bot turn on Codex runs only on a checked version', () => {
  const checked = ['0.162.1']
  it.each([
    // [user agent Codex reports at initialize, what the bot's chat says (undefined: the turn runs)]
    ['codex_cli_rs/0.162.1 (Ubuntu 24.4.0; x86_64) xterm (mousse; 0.1.1)', undefined],
    ['mousse/0.162.1 (Mac OS 15.0.0; arm64) unknown', undefined],
    ['codex_cli_rs/0.163.0 (Ubuntu 24.4.0; x86_64) xterm', CODEX_BOT_VERSION_NEWER_TEXT],
    ['codex_cli_rs/1.0.0-alpha.2 (Windows 11; x86_64)', CODEX_BOT_VERSION_NEWER_TEXT],
    ['codex_cli_rs/0.150.0 (Ubuntu 24.4.0; x86_64)', CODEX_BOT_VERSION_UNKNOWN_TEXT],
    ['codex_cli_rs/0.162.1-alpha.1 (Ubuntu 24.4.0; x86_64)', CODEX_BOT_VERSION_UNKNOWN_TEXT],
    ['test', CODEX_BOT_VERSION_UNKNOWN_TEXT],
    [undefined, CODEX_BOT_VERSION_UNKNOWN_TEXT]
  ])('%s', (userAgent, said) => {
    expect(codexBotVersionRefusal(codexVersionOf(userAgent), checked)).toBe(said)
  })
})
