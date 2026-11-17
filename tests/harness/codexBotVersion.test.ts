import { describe, expect, it } from 'vitest'
import { CODEX_BOT_RUNS_ON_TEXT, CODEX_BOT_VERSION_TEXT, CODEX_BOT_VERSION_UNKNOWN_TEXT, codexBotRunsOnNote, codexBotVersionRefusal, codexVersionOf } from '../../src/shared/harness/codexBotVersion'

/**
 * Which Codex runs a bot's turn: only a version whose tools were read from the real binary and accounted for, older and
 * newer alike. The real user agent's form is checked on each real binary in `codexBotTools.test.ts`.
 */
describe('a bot turn on Codex runs only on a checked version', () => {
  const checked = ['0.162.1', '0.167.0']
  it.each([
    // [user agent Codex reports at initialize, what the bot's chat says (undefined: the turn runs)]
    ['codex_cli_rs/0.162.1 (Ubuntu 24.4.0; x86_64) xterm (mousse; 0.1.1)', undefined],
    ['mousse/0.167.0 (Mac OS 15.0.0; arm64) unknown', undefined],
    ['codex_cli_rs/0.163.0 (Ubuntu 24.4.0; x86_64) xterm', CODEX_BOT_VERSION_TEXT],
    ['codex_cli_rs/1.0.0-alpha.2 (Windows 11; x86_64)', CODEX_BOT_VERSION_TEXT],
    ['codex_cli_rs/0.150.0 (Ubuntu 24.4.0; x86_64)', CODEX_BOT_VERSION_TEXT],
    ['codex_cli_rs/0.162.1-alpha.1 (Ubuntu 24.4.0; x86_64)', CODEX_BOT_VERSION_TEXT],
    ['test', CODEX_BOT_VERSION_UNKNOWN_TEXT],
    [undefined, CODEX_BOT_VERSION_UNKNOWN_TEXT]
  ])('%s', (userAgent, said) => {
    expect(codexBotVersionRefusal(codexVersionOf(userAgent), checked)).toBe(said)
  })

  it('Runs on says it once for an unchecked version, with the versions in its tooltip, and nothing for a checked or unknown one', () => {
    expect(codexBotRunsOnNote('0.150.0', checked)).toEqual({ text: CODEX_BOT_RUNS_ON_TEXT, title: 'Codex 0.150.0 is installed here. Checked for bots: 0.162.1, 0.167.0.' })
    expect(codexBotRunsOnNote('0.167.0', checked)).toBeUndefined()
    expect(codexBotRunsOnNote(undefined, checked)).toBeUndefined()
  })
})