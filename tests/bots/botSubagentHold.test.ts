/**
 * The hold rule for a bot's subagents (docs/bots.md, "How each runtime holds a subagent"): a subagent is never held less
 * tightly than its work. For the work's entry and the subagent's entry on Linux, macOS and Windows, every pairing of the
 * runtimes that can hold a bot, power by power: kept as the work has it, withheld (its entry would hold it less tightly
 * and can run without it), or refused (it can't run without it there).
 *
 * The inputs, listed first (test-the-claim §4):
 * - platforms: linux, darwin, win32;
 * - runtimes: Claude Code with its sandbox, Claude Code without it (Linux without bubblewrap or socat; Windows always),
 *   Codex, Pi, and a runtime whose driver says nothing;
 * - powers: run commands without file access, run commands with it, the web granted or not (Codex's hosted search
 *   switched off for a bot without the web, or offered whatever it holds), files, the browser, MCP tools, skills;
 * - the same entry, another entry on the same runtime, another runtime.
 */
import { describe, expect, it } from 'vitest'
import { commandHold, subagentHold, type BotHoldDecision, type BotRuntimeHold } from '../../src/shared/bots/personal/subagentHold'

const CLAUDE: BotRuntimeHold = { runtime: 'claude', sandbox: 'available' }
const CLAUDE_NO_SANDBOX: BotRuntimeHold = { runtime: 'claude', sandbox: 'missing' }
const CLAUDE_WINDOWS: BotRuntimeHold = { runtime: 'claude', sandbox: 'unsupported' }
const CODEX: BotRuntimeHold = { runtime: 'codex', hostedSearch: 'off_without_web' }
const PI: BotRuntimeHold = { runtime: 'pi' }

type Runtime = 'claude' | 'claude, no sandbox' | 'codex' | 'pi'
const HOLDS: Record<string, Partial<Record<Runtime, BotRuntimeHold>>> = {
  linux: { claude: CLAUDE, 'claude, no sandbox': CLAUDE_NO_SANDBOX, codex: CODEX, pi: PI },
  darwin: { claude: CLAUDE, codex: CODEX, pi: PI },
  win32: { 'claude, no sandbox': CLAUDE_WINDOWS, codex: CODEX, pi: PI }
}

const S: BotHoldDecision = 'same'
const W: BotHoldDecision = 'withheld'

/**
 * Commands: what a subagent on the column's runtime gets when its work, on the row's runtime, may run commands. `files`:
 * with "use files on this computer" too. The table docs/bots.md shows.
 */
const COMMANDS: Record<string, Record<'without files' | 'with files', Partial<Record<Runtime, Partial<Record<Runtime, BotHoldDecision>>>>>> = {
  linux: {
    'without files': {
      claude: { claude: S, 'claude, no sandbox': W, codex: S, pi: W },
      'claude, no sandbox': { claude: S, 'claude, no sandbox': S, codex: S, pi: S },
      codex: { claude: W, 'claude, no sandbox': W, codex: S, pi: W },
      pi: { claude: S, 'claude, no sandbox': S, codex: S, pi: S }
    },
    'with files': {
      // Codex's sandbox with file access reads every file, Mousse's own data included; Claude Code's doesn't.
      claude: { claude: S, 'claude, no sandbox': W, codex: W, pi: W },
      'claude, no sandbox': { claude: S, 'claude, no sandbox': S, codex: S, pi: S },
      codex: { claude: S, 'claude, no sandbox': W, codex: S, pi: W },
      pi: { claude: S, 'claude, no sandbox': S, codex: S, pi: S }
    }
  },
  darwin: {
    'without files': {
      // Claude Code's sandbox on macOS closes only the home folder; Codex's profile, everything but the system's folders.
      claude: { claude: S, codex: S, pi: W },
      codex: { claude: W, codex: S, pi: W },
      pi: { claude: S, codex: S, pi: S }
    },
    'with files': {
      claude: { claude: S, codex: W, pi: W },
      codex: { claude: S, codex: S, pi: W },
      pi: { claude: S, codex: S, pi: S }
    }
  },
  win32: {
    'without files': {
      // No sandbox for Claude Code or Pi; Codex writes only the bot's folders and has no network.
      'claude, no sandbox': { 'claude, no sandbox': S, codex: S, pi: S },
      codex: { 'claude, no sandbox': W, codex: S, pi: W },
      pi: { 'claude, no sandbox': S, codex: S, pi: S }
    },
    'with files': {
      'claude, no sandbox': { 'claude, no sandbox': S, codex: S, pi: S },
      codex: { 'claude, no sandbox': W, codex: S, pi: W },
      pi: { 'claude, no sandbox': S, codex: S, pi: S }
    }
  }
}

const rows = Object.entries(COMMANDS).flatMap(([platform, byFiles]) => Object.entries(byFiles).flatMap(([files, byWork]) =>
  Object.entries(byWork).flatMap(([work, bySub]) => Object.entries(bySub).map(([sub, decision]) => [platform, files, work, sub, decision] as const))))

describe('a subagent is never held less tightly than its work', () => {
  it.each(rows)('%s, commands %s: work on %s, subagent on %s: %s', (platform, files, work, sub, decision) => {
    const hold = subagentHold({
      work: HOLDS[platform]![work as Runtime], sub: HOLDS[platform]![sub as Runtime], sameEntry: false, platform,
      holds: { shell: true, files: files === 'with files', web: true }
    })
    expect(hold.decisions.shell).toBe(decision)
    expect(hold.withheld.includes('shell')).toBe(decision === W)
    // Commands are never what refuses a start: every runtime runs with no command tool.
    expect(hold.refused).toBeUndefined()
  })

  it('every pairing on every platform is in the table', () => {
    for (const [platform, holds] of Object.entries(HOLDS))
      for (const files of ['without files', 'with files'] as const)
        for (const work of Object.keys(holds)) for (const sub of Object.keys(holds))
          expect(COMMANDS[platform]![files][work as Runtime]?.[sub as Runtime], `${platform} ${files} ${work} → ${sub}`).toBeDefined()
  })

  it.each(Object.entries(HOLDS).flatMap(([platform, holds]) => Object.entries(holds).flatMap(([work, workHold]) => Object.entries(holds).map(([sub, subHold]) => [platform, work, sub, workHold, subHold] as const))))(
    '%s, work on %s, subagent on %s: files, the browser, MCP tools and skills are kept, and the web whether the work has it or not',
    (platform, _work, _sub, work, sub) => {
      for (const web of [true, false]) {
        const hold = subagentHold({ work, sub, sameEntry: false, platform, holds: { shell: false, files: true, web, browser: true, mcp: true, skills: true } })
        expect(hold.decisions).toEqual({ files: S, browser: S, mcp: S, skills: S, web: S })
        expect(hold.withheld).toEqual([])
      }
    }
  )

  it('a runtime that searches the web whatever the bot holds refuses a subagent of work without the web, unless the work\'s own runtime does too', () => {
    const alwaysSearches: BotRuntimeHold = { runtime: 'codex', hostedSearch: 'always' }
    for (const platform of Object.keys(HOLDS))
      for (const work of [CLAUDE, PI, CODEX]) {
        const hold = subagentHold({ work, sub: alwaysSearches, sameEntry: false, platform, holds: { shell: false, files: false, web: false } })
        expect(hold, `${platform} ${work.runtime}`).toMatchObject({ refused: 'web', decisions: { web: 'refused' } })
        // The control: with the web granted, it starts.
        expect(subagentHold({ work, sub: alwaysSearches, sameEntry: false, platform, holds: { shell: false, files: false, web: true } }).refused).toBeUndefined()
      }
    expect(subagentHold({ work: alwaysSearches, sub: alwaysSearches, sameEntry: false, platform: 'linux', holds: { shell: false, files: false, web: false } }).refused).toBeUndefined()
  })

  it('the same entry is always the same, and another entry on the same runtime is the same', () => {
    for (const [platform, holds] of Object.entries(HOLDS))
      for (const hold of Object.values(holds)) {
        for (const files of [true, false]) {
          expect(subagentHold({ work: hold, sub: hold, sameEntry: true, platform, holds: { shell: true, files, web: false } }).withheld).toEqual([])
          expect(subagentHold({ work: hold, sub: { ...hold }, sameEntry: false, platform, holds: { shell: true, files, web: false } }).withheld).toEqual([])
        }
      }
  })

  it('a runtime whose driver says nothing is held as tightly as nothing: commands withheld under a sandboxed work, and no start without the web', () => {
    const hold = subagentHold({ work: CLAUDE, sub: undefined, sameEntry: false, platform: 'linux', holds: { shell: true, files: false, web: false } })
    expect(hold).toMatchObject({ withheld: ['shell'], refused: 'web' })
    expect(commandHold(undefined, 'linux', false)).toEqual({ reads: 3, writes: 2, network: true })
  })
})
