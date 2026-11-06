/**
 * Bot Phase 1 §5.1.1 and §5.9: the authority's third outcome, `refused` (an unattended run's missing
 * permission, asked of the owner), at each check point. The call fails with the ask's text as its
 * tool error, and nothing ends the dispatch: the next call is decided as usual and the activation's
 * time signal stays live. Locked Claude Code's gate and the Mousse app-tool registry here; Pi's gate
 * against the real child in `piBotGate.test.ts`.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createBotAuthority } from '../../src/mms/bots/authority/botAuthority'
import { RunCounters } from '../../src/mms/harness/budget'
import { ClaudeLockedGate, CLAUDE_NATIVE_TOOLS } from '../../src/mms/harness/claude/locked'
import { CLAUDE_MOUSSE_TOOL_PREFIX } from '../../src/mms/run/mcp/attachment'
import type { BotAuthority, BotCheck, NormalisedCall } from '../../src/shared/bots/personal/authority'
import { botAppToolRefusal, checkBuiltinCall, checkMessage } from '../../src/shared/bots/personal/walls'
import type { NeutralTool } from '../../src/shared/harness/tools'
import { appToolRegistry, appTurn, fakeAppToolHost } from '../run/appToolsFixture'
import { delegationFixture, type DelegationFixture } from '../run/delegationFixture'

const ASKED = 'Asked the owner; carry on without it.'

const cleanups: Array<() => void> = []
let fx: DelegationFixture | undefined
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
  fx?.dispose()
  fx = undefined
})

function folders() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'mousse-bot-refused-')))
  cleanups.push(() => rmSync(base, { recursive: true, force: true }))
  const root = join(base, 'root')
  const scratch = join(base, 'scratch')
  mkdirSync(root)
  mkdirSync(scratch)
  writeFileSync(join(root, 'a.txt'), 'a')
  return { root, scratch }
}

/**
 * A run's authority granted `tools` and `appTools`; anything `asks` names is refused with an ask
 * (as WP3's authority does for a run lane's missing permission), everything else decided as usual.
 */
function runAuthority(input: { tools: NeutralTool[]; appTools?: string[]; root?: string; scratch?: string; asks: (call: NormalisedCall) => boolean }) {
  const signal = new AbortController().signal
  const base = createBotAuthority({
    activationId: 'act-1',
    role: 'activation',
    permissions: { tools: input.tools, appTools: input.appTools ?? [], mcp: [], skills: [], workspace: input.root ? { roots: [input.root], access: 'read', scratch: input.scratch! } : null },
    waiting: () => false,
    counters: new RunCounters(),
    time: { deadline: () => Number.MAX_SAFE_INTEGER, signal },
    spend: null
  })
  const asked: NormalisedCall[] = []
  const check = (call: NormalisedCall): BotCheck => {
    if (input.asks(call)) {
      asked.push(call)
      return { ok: false, refused: { text: ASKED, askId: `ask-${asked.length}` } }
    }
    return base.check(call)
  }
  const authority: BotAuthority = {
    ...base,
    check,
    checkAny: (calls) => {
      let denied: BotCheck | undefined
      for (const call of calls) {
        const decided = check(call)
        if (decided.ok) return decided
        denied ??= decided
      }
      return denied!
    }
  }
  return { authority, asked, signal }
}

describe('the shared checks pass a refusal back as the tool error', () => {
  it('a built-in and an app tool', () => {
    const { root, scratch } = folders()
    const { authority } = runAuthority({ tools: ['read'], appTools: ['web_search'], root, scratch, asks: (call) => (call.kind === 'builtin' && call.tool === 'write') || (call.kind === 'app' && call.tool === 'web_fetch') })
    const decided = checkBuiltinCall(authority, CLAUDE_NATIVE_TOOLS, 'Write', { file_path: join(scratch, 'x') })
    expect(decided).toEqual({ ok: false, refused: { text: ASKED, askId: 'ask-1' } })
    expect(checkMessage(decided as Exclude<BotCheck, { ok: true }>)).toBe(ASKED)
    expect(botAppToolRefusal(authority, 'web_fetch', { url: 'https://example.com' })).toBe(ASKED)
    expect(botAppToolRefusal(authority, 'web_search', { query: 'x' })).toBeUndefined()
  })

  it('the skill tools pass an ask on rather than reading it as "not granted"', () => {
    const base = runAuthority({ tools: [], asks: (call) => call.kind === 'app' && call.tool === 'load_skill' })
    const withSkill: BotAuthority = { ...base.authority, skills: new Set(['s1']) }
    expect(botAppToolRefusal(withSkill, 'load_skill', { skill: 's1' })).toBe(ASKED)
  })
})

describe('locked Claude Code’s gate', () => {
  it('denies a refused call with the ask’s text, then decides the next call as usual', () => {
    const { root, scratch } = folders()
    const { authority, asked, signal } = runAuthority({ tools: ['read'], root, scratch, asks: (call) => call.kind === 'builtin' && call.tool === 'write' })
    const rows: string[] = []
    const gate = new ClaudeLockedGate({
      authority,
      ledger: { start: (call) => (rows.push(call.name), `row-${rows.length}`), commit: () => {}, failed: () => {} },
      cwd: scratch, shellContained: false, temps: [], systemPrompt: ''
    }, true)
    // `Write` is not offered (not granted), but a call that reaches the gate is decided by the authority.
    expect(gate.preToolUse('Write', { file_path: join(scratch, 'x.md'), content: 'x' })).toEqual({ ok: false, reason: ASKED })
    expect(asked).toHaveLength(1)
    // The dispatch goes on: the next call runs.
    expect(gate.preToolUse('Read', { file_path: join(root, 'a.txt') })).toEqual({ ok: true })
    expect(gate.canUse('Read', { file_path: join(root, 'a.txt') }, 'toolu_2')).toEqual({ ok: true })
    expect(rows).toEqual(['Read'])
    expect(signal.aborted).toBe(false)
  })

  it('a refused Mousse tool is denied the same way', () => {
    const { authority } = runAuthority({ tools: [], appTools: ['web_search'], asks: (call) => call.kind === 'app' && call.tool === 'web_fetch' })
    const gate = new ClaudeLockedGate({ authority, cwd: '/tmp', shellContained: false, temps: [], systemPrompt: '' }, true)
    expect(gate.preToolUse(`${CLAUDE_MOUSSE_TOOL_PREFIX}web_fetch`, { url: 'https://example.com' })).toEqual({ ok: false, reason: ASKED })
    expect(gate.preToolUse(`${CLAUDE_MOUSSE_TOOL_PREFIX}web_search`, { query: 'x' })).toEqual({ ok: true })
  })
})

describe('the Mousse app-tool registry', () => {
  it('returns the ask’s text as the call’s error and runs the next granted call', async () => {
    fx = delegationFixture()
    const run = await fx.runningRun('thread-a')
    const fake = fakeAppToolHost()
    const { registry, turns, request } = appToolRegistry(fx.engine, fake.host)
    const { authority } = runAuthority({ tools: [], appTools: ['create_task'], asks: (call) => call.kind === 'app' && call.tool === 'ask_user' })
    turns.register(appTurn({ threadId: 'thread-a', runId: run.runId, bot: authority }))
    const ctx = () => request({ threadId: 'thread-a', runId: run.runId })
    expect(await registry.call('ask_user', { questions: [] }, ctx())).toEqual({ text: ASKED, isError: true })
    expect(fake.host.askUser).not.toHaveBeenCalled()
    expect((await registry.call('create_task', { description: 'fine' }, ctx())).isError).toBe(false)
    expect(fx.engine.getRun(run.runId)?.status).toBe('running')
  })
})
