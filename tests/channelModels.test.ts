/**
 * Channel `/model` choices come from capabilities, not instance names: an instance is listed when it
 * resolves for a channel turn and can hold `CHANNEL_POLICY` (approvals refused, never asked). Claude
 * Code and Codex (`approval_only`) are listed; a runtime that approves tools itself is not. The first
 * channel turn on an `approval_only` runtime says once that such tools are refused.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ChannelAuth } from '../src/mms/channels/ChannelAuth'
import { ChannelRouter } from '../src/mms/channels/ChannelRouter'
import { ChannelSessionManager } from '../src/mms/channels/ChannelSessionManager'
import { ChannelStore } from '../src/mms/channels/ChannelStore'
import type { ChannelAdapter } from '../src/mms/channels/types'
import { MousseConfigStore } from '../src/mms/config/MousseConfigStore'
import { ProjectManager } from '../src/mms/data/ProjectManager'
import { ThreadDataStore } from '../src/mms/data/ThreadDataStore'
import { SettingsStore } from '../src/mms/settings/SettingsStore'
import { CHANNEL_APPROVALS_NOTICE, CHANNEL_MODEL_REFUSED, CHANNEL_POLICY, ChannelApprovalNotices, channelGate, channelModelOptions } from '../src/mms/channels/channelModels'
import { OrchestratorService } from '../src/mms/orchestrator/OrchestratorService'
import type { HarnessCaps } from '../src/shared/harness/types'
import type { LlmProviderOption } from '../src/shared/settings'

const caps = (toolControl: HarnessCaps['toolControl']): HarnessCaps => ({ toolControl } as HarnessCaps)

const listing = (instanceId: string): LlmProviderOption => ({ id: instanceId, instanceId, label: instanceId, models: [{ id: 'm', label: 'M' }] })

describe('channel model choices', () => {
  const byInstance: Record<string, HarnessCaps> = {
    'pi:openai': caps('exact'),
    claude: caps('approval_only'),
    'codex:work': caps('approval_only'),
    'acp:generic': caps('uncontrolled')
  }
  const capsOf = (instanceId: string): HarnessCaps => {
    const found = byInstance[instanceId]
    if (!found) throw Object.assign(new Error('turned off'), { code: 'instance_disabled' })
    return found
  }

  it('binds every channel turn with approvals refused, as a person\'s own turn', () => {
    expect(CHANNEL_POLICY).toMatchObject({ approvals: 'never', origin: 'interactive' })
  })

  it('lists instances by capability: exact and approval_only stay, uncontrolled and unresolvable leave', () => {
    const providers = ['pi:openai', 'claude', 'codex:work', 'acp:generic', 'pi:disabled'].map(listing)
    expect(channelModelOptions(providers, capsOf).map((option) => option.instanceId)).toEqual(['pi:openai', 'claude', 'codex:work'])
  })

  it('has no name branch: a vendor id and a pi id with the same caps are treated alike', () => {
    const same = (instanceId: string) => channelModelOptions([listing(instanceId)], () => caps('approval_only')).length
    expect(same('pi:openrouter')).toBe(1)
    expect(same('claude:second-account')).toBe(1)
    // A listing that names no instance cannot be selected for a turn.
    expect(channelModelOptions([{ id: 'openai', label: 'OpenAI', models: [] }], () => caps('exact'))).toEqual([])
  })

  it('gives the approvals notice until it was delivered once, and only on runtimes that ask before tools', () => {
    const notices = new ChannelApprovalNotices()
    expect(notices.pending('t1', caps('approval_only'))).toBe(CHANNEL_APPROVALS_NOTICE)
    // Not delivered yet (the send failed): the next turn offers it again.
    expect(notices.pending('t1', caps('approval_only'))).toBe(CHANNEL_APPROVALS_NOTICE)
    notices.delivered('t1')
    expect(notices.pending('t1', caps('approval_only'))).toBeUndefined()
    expect(notices.pending('t2', caps('approval_only'))).toBe(CHANNEL_APPROVALS_NOTICE)
    expect(notices.pending('t3', caps('exact'))).toBeUndefined()
    expect(notices.pending('t4', null)).toBeUndefined()
    expect(CHANNEL_APPROVALS_NOTICE).toBe('Tools that need approval are refused in channels.')
  })

  it('refuses a runtime that approves tools itself with what to do, never with a capability name', () => {
    expect(channelGate(caps('uncontrolled'))).toEqual({ refusal: CHANNEL_MODEL_REFUSED })
    expect(CHANNEL_MODEL_REFUSED).toBe("This model can't run in channels. Choose another with /model.")
    expect(CHANNEL_MODEL_REFUSED).not.toMatch(/toolControl/)
    expect(channelGate(caps('approval_only'))).toEqual({ approvalOnly: true })
    expect(channelGate(caps('exact'))).toEqual({})
    // No model or an unreadable instance: the turn reports its own error.
    expect(channelGate(null)).toEqual({})
  })

  it('a provider continuation keeps `never` when the thread\'s previous binding had it', () => {
    const previous = { policy: { approvals: 'never' } }
    const orch = Object.assign(Object.create(OrchestratorService.prototype), {
      runEngine: { previousBinding: (threadId: string) => (threadId === 'channel' ? previous : { policy: { approvals: 'ask' } }) }
    }) as { turnApprovals: (threadId: string, runId: string | undefined, opts?: { approvals?: string; source?: string }) => { approvals?: string } }
    expect(orch.turnApprovals('channel', 'run-2', { source: 'provider-continuation' })).toEqual({ approvals: 'never' })
    expect(orch.turnApprovals('gui', 'run-2', { source: 'provider-continuation' })).toEqual({})
    // Only continuations inherit; a person's own message binds by the thread's mode.
    expect(orch.turnApprovals('channel', 'run-2', { source: 'protocol' })).toEqual({})
    expect(orch.turnApprovals('gui', 'run-2', { approvals: 'never' })).toEqual({ approvals: 'never' })
  })
})

describe('the approvals notice in a channel', () => {
  it('is sent before the first turn on an approval_only runtime, once', async () => {
    const previousHome = process.env.MOUSSE_HOME
    const home = mkdtempSync(join(tmpdir(), 'mousse-channel-notice-'))
    process.env.MOUSSE_HOME = home
    try {
      const configStore = MousseConfigStore.load()
      const store = new ChannelStore(configStore)
      store.updateConfig({ platforms: { telegram: { enabled: true, allowAllUsers: true }, discord: { enabled: false }, webhook: { enabled: false } } })
      const projects = new ProjectManager()
      const threads = new ThreadDataStore(projects)
      projects.setThreadStore(threads)
      const sent: string[] = []
      const order: string[] = []
      const runner = { runChannelTurn: vi.fn(async () => { order.push('turn'); return { text: 'reply', silent: false } }) }
      const adapter: ChannelAdapter = {
        platform: 'telegram',
        connect: async () => {},
        disconnect: async () => {},
        getStatus: () => ({ platform: 'telegram', state: 'connected' }),
        setInboundHandler: () => {},
        send: async (msg) => { sent.push(msg.text); order.push(`send:${msg.text}`); return { success: true, messageId: String(sent.length) } }
      }
      const notices = new ChannelApprovalNotices()
      const router = new ChannelRouter(store, new ChannelSessionManager(store, threads), new ChannelAuth(), runner, () => adapter, () => store.getConfig(), {
        settingsStore: new SettingsStore(configStore),
        threadStore: threads,
        listModels: () => [],
        channelGate: (threadId) => {
          const notice = notices.pending(threadId, caps('approval_only'))
          return notice ? { notice } : {}
        },
        noticeDelivered: (threadId) => notices.delivered(threadId)
      })
      const inbound = (text: string, messageId: string) => router.handleInbound({ platform: 'telegram', chatId: '7', chatType: 'dm', userId: 'u', userName: 'u', text, messageId })
      await inbound('first', 'm1')
      await inbound('second', 'm2')
      expect(runner.runChannelTurn).toHaveBeenCalledTimes(2)
      expect(sent.filter((text) => text === CHANNEL_APPROVALS_NOTICE)).toHaveLength(1)
      expect(order.indexOf(`send:${CHANNEL_APPROVALS_NOTICE}`)).toBeLessThan(order.indexOf('turn'))

      // A runtime that cannot run in channels: the reply says what to do, and no turn runs.
      const refusing = new ChannelRouter(store, new ChannelSessionManager(store, threads), new ChannelAuth(), runner, () => adapter, () => store.getConfig(), {
        settingsStore: new SettingsStore(configStore),
        threadStore: threads,
        listModels: () => [],
        channelGate: () => channelGate(caps('uncontrolled'))
      })
      await refusing.handleInbound({ platform: 'telegram', chatId: '8', chatType: 'dm', userId: 'u', userName: 'u', text: 'hi', messageId: 'm3' })
      expect(runner.runChannelTurn).toHaveBeenCalledTimes(2)
      expect(sent.at(-1)).toBe(CHANNEL_MODEL_REFUSED)

      // A notice whose send fails (a throw, or the platform refusing it) is not remembered and does not block the turn.
      const failing = new ChannelApprovalNotices()
      let failNext = true
      const flaky: ChannelAdapter = { ...adapter, send: async (msg) => { if (failNext) { failNext = false; return { success: false, error: 'telegram down' } } return adapter.send(msg) } }
      const third = new ChannelRouter(store, new ChannelSessionManager(store, threads), new ChannelAuth(), runner, () => flaky, () => store.getConfig(), {
        settingsStore: new SettingsStore(configStore),
        threadStore: threads,
        listModels: () => [],
        channelGate: (threadId) => {
          const notice = failing.pending(threadId, caps('approval_only'))
          return notice ? { notice } : {}
        },
        noticeDelivered: (threadId) => failing.delivered(threadId)
      })
      await third.handleInbound({ platform: 'telegram', chatId: '9', chatType: 'dm', userId: 'u', userName: 'u', text: 'one', messageId: 'm4' })
      expect(runner.runChannelTurn).toHaveBeenCalledTimes(3)
      const before = sent.filter((text) => text === CHANNEL_APPROVALS_NOTICE).length
      await third.handleInbound({ platform: 'telegram', chatId: '9', chatType: 'dm', userId: 'u', userName: 'u', text: 'two', messageId: 'm5' })
      expect(sent.filter((text) => text === CHANNEL_APPROVALS_NOTICE)).toHaveLength(before + 1)
    } finally {
      if (previousHome === undefined) delete process.env.MOUSSE_HOME
      else process.env.MOUSSE_HOME = previousHome
      rmSync(home, { recursive: true, force: true })
    }
  })
})
