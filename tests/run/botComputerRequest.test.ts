/**
 * A bot asks its owner to set up computer use only from work its owner asked for in its chat: its run holds
 * `computer_use_request` only with "use the computer" and the owner's tools of a main turn, and a call (directly, or
 * through `use_tool`) runs only when the run is that work (`BotAuthority.ownerRequested`), never a schedule, a reminder,
 * a run started by hand or another bot's message. Its catalogue says which: ask, or say it in the report.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { ownerRequestedWork } from '../../src/mms/bots/activation/BotEngine'
import { createBotAuthority } from '../../src/mms/bots/authority/botAuthority'
import { botManifestDigest, compileBotThread, type CompileInput } from '../../src/mms/bots/grants/compile'
import { baseInstructionsWithout, botAllowedText, botAllowedOf } from '../../src/mms/bots/instructions'
import { AppToolTurns, createAppToolRegistry, type AppToolHost, type AppToolTurn, type BotAppToolDeps, type McpCallRequest } from '../../src/mms/run/mcp/appTools'
import type { ComputerUseToolHost } from '../../src/mms/run/mcp/appTools/computer'
import type { BotActivationRow } from '../../src/mms/bots/activation/BotEngine'
import { BOT_COMPUTER_PERMISSION, botStarterManifest } from '../../src/shared/bots/personal/manifest'
import { appTurn, fakeAppToolHost } from './appToolsFixture'
import { delegationFixture } from './delegationFixture'

const THREAD = 'bot-run'
const base = mkdtempSync(join(tmpdir(), 'mousse-bot-computer-request-'))
afterAll(() => rmSync(base, { recursive: true, force: true }))

const JOB: CompileInput['botTools'] = {
  workWaiting: false, escalate: true, consult: false, memory: true, scheduled: false, frontDesk: false, watcherStart: false, threads: 'read', profiler: false,
  themes: false, owner: true, tasks: true, images: false, applets: false, subagents: true, questions: false, cards: false, bots: false
}

function compiled(opts: { computer?: boolean; botTools?: CompileInput['botTools'] }) {
  const starter = botStarterManifest()
  const grant = { ...starter, appTools: [...starter.appTools, ...(opts.computer === false ? [] : [BOT_COMPUTER_PERMISSION])] }
  const scratch = join(base, 'scratch', Math.random().toString(36).slice(2))
  mkdirSync(scratch, { recursive: true })
  const result = compileBotThread({
    grant, digest: botManifestDigest(grant), thread: {}, scratch, profileHome: base,
    nativeNames: (tools) => ({ ok: true, names: [...tools] }), remaining: { deadlineMs: 600_000 }, botTools: opts.botTools ?? JOB
  })
  if (!result.ok) throw new Error(result.error.message)
  return result
}

describe('which bot turns hold the setup request', () => {
  it.each([
    ['a main run with "use the computer"', { computer: true }, true],
    ['a main run without it', { computer: false }, false],
    ['the chat (its computer is its work\'s)', { botTools: { ...JOB, frontDesk: true } }, false],
    ['a subagent', { botTools: { escalate: false, consult: false, subagent: true, tasks: true } as CompileInput['botTools'] }, false],
    ['a consult', { botTools: { escalate: false, consult: false } as CompileInput['botTools'] }, false]
  ] as const)('%s: %s', (_name, opts, holds) => {
    const { permissions, policy } = compiled(opts)
    expect(permissions.appTools.includes('computer_use_request')).toBe(holds)
    expect((policy.tools?.allow ?? []).includes('computer_use_request')).toBe(holds)
  })
})

describe('which work its owner asked for', () => {
  type Row = Pick<BotActivationRow, 'botId' | 'lane' | 'idempotencyKey' | 'trigger'>
  const rows: Record<string, Row> = {
    'chat-owner': { botId: 'b1', lane: 'chat', idempotencyKey: 'chat:m1', trigger: { kind: 'manual', input: 'open Figma' } },
    'chat-answer': { botId: 'b1', lane: 'chat', idempotencyKey: 'answer:q1', trigger: { kind: 'manual', input: 'yes' } },
    'chat-from-bot': { botId: 'b1', lane: 'chat', idempotencyKey: 'chat:m2', trigger: { kind: 'manual', input: 'hi', fromBot: { botId: 'b2', name: 'Bo', hop: 1 } as never } },
    'chat-other-bot': { botId: 'b2', lane: 'chat', idempotencyKey: 'chat:m3', trigger: { kind: 'manual', input: 'open Figma' } },
    'chat-notice': { botId: 'b1', lane: 'chat', idempotencyKey: 'notice:n1', trigger: { kind: 'manual', input: 'thread done' } },
    'rem_1': { botId: 'b1', lane: 'run', idempotencyKey: 'reminder:rem_1', trigger: { kind: 'schedule', input: '', scheduleId: 's', occurrenceAt: '' } }
  }
  const work = (from: string): Pick<BotActivationRow, 'botId' | 'lane' | 'trigger'> => ({ botId: 'b1', lane: 'run', trigger: { kind: 'work', input: 'do it', title: 'Do it', from } })
  const read = (id: string) => rows[id]

  it.each([
    ['work the owner\'s message started in the chat', work('chat-owner'), true],
    ['work the owner\'s tapped answer started', work('chat-answer'), true],
    ['work another bot\'s message led to', work('chat-from-bot'), false],
    ['work started from another bot\'s chat', work('chat-other-bot'), false],
    ['work a notice turn started', work('chat-notice'), false],
    ['a reminder\'s work (its from is the reminder)', work('rem_1'), false],
    ['work whose start is gone', work('gone'), false],
    ['a schedule', { botId: 'b1', lane: 'run', trigger: { kind: 'schedule', input: '', scheduleId: 's', occurrenceAt: '' } }, false],
    ['a run started by hand', { botId: 'b1', lane: 'run', trigger: { kind: 'manual', input: 'go' } }, false],
    ['the chat itself', { botId: 'b1', lane: 'chat', trigger: { kind: 'work', input: '', title: '', from: 'chat-owner' } }, false]
  ] as const)('%s → %s', (_name, row, expected) => {
    expect(ownerRequestedWork(row as never, read)).toBe(expected)
  })

  it('an activation that cannot be read is not', () => {
    expect(ownerRequestedWork(work('chat-owner'), () => { throw new Error('database closed') })).toBe(false)
  })
})

describe('a bot run calling the setup request', () => {
  async function run(opts: { ownerRequested?: boolean; computer?: boolean; catalogue?: 'use_tool'; known?: 'missing' | 'found' }) {
    const fx = delegationFixture({ profileHome: mkdtempSync(join(base, 'profile-')) })
    const runRow = await fx.runningRun(THREAD)
    const requestSetup = vi.fn(async () => ({ text: '[computer-use:setup_needed] Computer use is not set up on Ada: off.' }))
    const cu: ComputerUseToolHost = {
      enabled: () => true,
      known: () => ({ state: opts.known ?? 'missing', enabled: true, installable: true }),
      allowedFor: () => true,
      listTools: async () => ({ tools: [] }),
      call: async () => ({ content: [] }),
      requestSetup
    }
    const fake = fakeAppToolHost({ botRole: () => 'activation', computerUse: () => cu } as Partial<AppToolHost>)
    const turns = new AppToolTurns()
    const deps = { host: { activationOf: () => ({ botId: 'b1', activationId: 'act-1', lane: 'run' }) }, activity: { onAppResult: vi.fn(), onAllowed: vi.fn(), drain: () => [] } } as unknown as BotAppToolDeps
    const { registry } = createAppToolRegistry({ host: fake.host, engine: fx.engine, turns, bots: () => deps, botMemory: () => undefined })
    const { permissions } = compiled({ computer: opts.computer, botTools: { ...JOB, ...(opts.catalogue ? { catalogue: opts.catalogue } : {}) } })
    const authority = {
      ...createBotAuthority({
        activationId: 'act-1', role: 'activation', permissions, waiting: () => false,
        counters: { charge: () => ({ ok: true, count: 1 }) }, time: { deadline: () => 0, signal: new AbortController().signal }, spend: null
      }),
      ...(opts.ownerRequested ? { ownerRequested: true } : {})
    }
    turns.register(appTurn({ threadId: THREAD, runId: runRow.runId, turnToken: 'turn-1', bot: authority, approvals: 'never' }) as AppToolTurn)
    const request = (): McpCallRequest => ({
      credential: { threadId: THREAD, runId: runRow.runId, provider: 'codex', accessLevel: 'manage', binding: 'drained_turn', current: () => true },
      toolCallId: `mcp:call-${Math.random()}`,
      signal: new AbortController().signal
    })
    const call = async (name: string, args: Record<string, unknown>) => (await registry.call(name, args, request())) as { text: string; isError?: boolean }
    return { fx, registry, requestSetup, call, listed: () => registry.listForThread(THREAD, runRow.runId).map((tool) => tool.name) }
  }

  it.each([
    ['directly', undefined],
    ['through use_tool', 'use_tool' as const]
  ])('runs only in work its owner asked for (%s)', async (_how, catalogue) => {
    for (const ownerRequested of [false, true]) {
      const r = await run({ ownerRequested, catalogue })
      try {
        const outcome = catalogue
          ? await r.call('use_tool', { tool: 'computer_use_request', arguments: { reason: 'Open Figma' } })
          : await r.call('computer_use_request', { reason: 'Open Figma' })
        if (ownerRequested) {
          expect(outcome.text).toContain('[computer-use:setup_needed]')
          expect(r.requestSetup).toHaveBeenCalledWith(expect.objectContaining({ threadId: THREAD, reason: 'Open Figma' }))
        } else {
          expect(outcome.text).toMatch(/Only work your owner asked for/)
          expect(r.requestSetup).not.toHaveBeenCalled()
        }
      } finally {
        r.fx.dispose()
      }
    }
  })

  it('the computer group of its catalogue says to ask once when the driver is not set up here, and to escalate without the permission', async () => {
    const listing = await run({ ownerRequested: true })
    const r = await run({ ownerRequested: true, catalogue: 'use_tool' })
    const without = await run({ computer: false, catalogue: 'use_tool' })
    try {
      // Listed while the driver is missing; the tools that act are not.
      expect(listing.listed()).toContain('computer_use_request')
      expect(listing.listed()).not.toContain('computer_use')
      const text = (await r.call('tool_catalogue', { group: 'computer' })).text
      expect(text).toMatch(/isn't set up on this computer yet/)
      expect(text).toMatch(/Call computer_use_request once/)
      expect(text).toContain('## computer_use_request')
      const asks = (await without.call('tool_catalogue', { group: 'computer' })).text
      expect(asks).toMatch(/escalate/)
      expect(asks).not.toMatch(/Call computer_use_request once/)
    } finally {
      listing.fx.dispose()
      r.fx.dispose()
      without.fx.dispose()
    }
  })
})

describe('what the bot is told of the computer', () => {
  it('a computer switched off drops its ask line, keeps the line about secrets, and says asking won\'t help', () => {
    const text = baseInstructionsWithout({ computer: true })
    expect(text).not.toMatch(/use the computer/)
    expect(text).toContain('- Never ask for a secret in a message, and never repeat one.')
    expect(baseInstructionsWithout()).toContain('- You can ask to "use the computer"')
    const allowed = { ...botAllowedOf(botStarterManifest()), off: { computer: true as const } }
    expect(botAllowedText(allowed, 'run').split('\n').find((line) => line.startsWith('- Use apps on this computer'))).toMatch(/switched off/)
  })
})
