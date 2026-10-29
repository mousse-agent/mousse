/**
 * The Auto permission mode (issue #419): a thread set to Auto runs in the agent's own auto mode only on
 * an agent that has one (`HarnessCaps.autoPermissionMode`). Anywhere else it runs exactly as
 * Auto-accept edits would, and never gets more access than that. The mode is resolved again for every
 * turn, so moving a thread to another provider applies the rule again.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CLAUDE_AUTO_MODE_MIN_VERSION, CLAUDE_CODE_CAPS, claudeCodeCaps } from '../../src/mms/harness/drivers/claudeCode'
import { CODEX_CAPS, CODEX_PERMISSION_LIMITS } from '../../src/mms/harness/drivers/codex'
import { claudeLockedCaps } from '../../src/mms/harness/claude/locked'
import { autoPermissionModeAvailable, checkPermissionMode } from '../../src/mms/harness/policy'
import { ProviderInstanceService } from '../../src/mms/harness/instanceMap'
import type { ProviderAdapter, TurnInput, TurnResult } from '../../src/mms/harness/adapter'
import { adapterDriver, testHarness } from '../../src/mms/run/testkit/harness'
import type { Harness, TurnSpec } from '../../src/mms/harness/gateway'
import { CLAUDE_AUTO_MODE_DISABLED, CLAUDE_PERMISSION_MODES, claudeModeAsks } from '../../src/mms/harness/vendors/claude/ClaudeSubscriptionProviderService'
import {
  effectivePermissionMode,
  isStricter,
  PERMISSION_MODES,
  permissionModeAllows,
  supportedPermissionModes,
  type PermissionLimits,
  type PermissionMode
} from '../../src/shared/permissionMode'
import type { HarnessCaps } from '../../src/shared/harness/types'

/** A runtime whose turns finish at once and are recorded. */
class Recording implements ProviderAdapter {
  readonly turns: TurnInput[] = []
  readonly capabilities = { ...CODEX_CAPS }
  constructor(readonly driver: 'claude' | 'codex') {}
  async startTurn(input: TurnInput, sink: Parameters<ProviderAdapter['startTurn']>[1]): Promise<TurnResult> {
    this.turns.push(input)
    const providerRef = { provider: input.llmProvider, instanceId: input.instanceId, model: input.model }
    sink.providerRef(providerRef)
    return { text: 'ok', aborted: false, modelName: input.model, totalResponseTimeMs: 1, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextSignature: 's', nativeMessages: [], providerRef }
  }
  async interrupt(): Promise<'interrupted' | 'not_active'> {
    return 'not_active'
  }
}

const caps = (patch: Partial<HarnessCaps> = {}): HarnessCaps => ({ ...CLAUDE_CODE_CAPS, ...patch })

describe('Auto on the shared permission model', () => {
  it('sits between Auto-accept edits and Full access', () => {
    expect(PERMISSION_MODES).toEqual(['ask', 'accept_edits', 'auto', 'full'])
    expect(isStricter('accept_edits', 'auto')).toBe(true)
    expect(isStricter('auto', 'full')).toBe(true)
  })

  it('lets nothing more through Mousse\'s own checks than Auto-accept edits', () => {
    for (const action of ['edit', 'command', 'tool'] as const)
      expect(permissionModeAllows('auto', action), action).toBe(permissionModeAllows('accept_edits', action))
  })

  it('is supported only by an agent with an auto mode of its own', () => {
    expect(supportedPermissionModes(caps({ autoPermissionMode: true }))).toEqual(['ask', 'accept_edits', 'auto', 'full'])
    expect(supportedPermissionModes(caps({ autoPermissionMode: false }))).toEqual(['ask', 'accept_edits', 'full'])
    // Caps from before the key existed have no Auto.
    expect(supportedPermissionModes({ toolControl: 'approval_only' })).toEqual(['ask', 'accept_edits', 'full'])
    // An agent that approves tools itself still runs only in Full access.
    expect(supportedPermissionModes(caps({ toolControl: 'uncontrolled', autoPermissionMode: true }))).toEqual(['full'])
    // Settings that turn auto mode off take it away again.
    expect(supportedPermissionModes(caps({ autoPermissionMode: true }), { unavailable: { auto: CLAUDE_AUTO_MODE_DISABLED } })).toEqual(['ask', 'accept_edits', 'full'])
  })

  it('runs in the agent\'s auto mode on a supporting agent', () => {
    expect(effectivePermissionMode('auto', supportedPermissionModes(caps({ autoPermissionMode: true })), { agent: 'Claude Code' })).toEqual({ mode: 'auto' })
  })

  it('falls back to Auto-accept edits with the reason on an agent without an auto mode', () => {
    const supported = supportedPermissionModes(caps({ autoPermissionMode: false }))
    expect(effectivePermissionMode('auto', supported, { agent: 'Grok' })).toEqual({ mode: 'accept_edits', reason: 'Grok has no auto mode' })
    const limits: PermissionLimits = { unavailable: { auto: CLAUDE_AUTO_MODE_DISABLED } }
    expect(effectivePermissionMode('auto', supportedPermissionModes(caps({ autoPermissionMode: true }), limits), { agent: 'Claude Code', limits })).toEqual({ mode: 'accept_edits', reason: CLAUDE_AUTO_MODE_DISABLED })
  })

  it('resolves exactly as Auto-accept edits on every agent without an auto mode, never wider', () => {
    const agents: Array<{ caps: Partial<HarnessCaps>; limits?: PermissionLimits }> = [
      { caps: caps() },
      { caps: CODEX_CAPS, limits: CODEX_PERMISSION_LIMITS },
      { caps: caps({ toolControl: 'uncontrolled' }) },
      { caps: caps({ toolControl: 'exact' }) },
      { caps: {} },
      { caps: caps({ autoPermissionMode: true }), limits: { unavailable: { auto: 'off' } } },
      { caps: caps({ autoPermissionMode: true }), limits: { unavailable: { auto: 'off', accept_edits: 'no' } } }
    ]
    for (const { caps: agentCaps, limits } of agents) {
      const supported = supportedPermissionModes(agentCaps, limits)
      const auto = effectivePermissionMode('auto', supported, { limits })
      const edits = effectivePermissionMode('accept_edits', supported, { limits })
      expect(Boolean(auto.refused)).toBe(Boolean(edits.refused))
      expect(auto.mode).toBe(edits.mode)
      if (auto.mode) expect(isStricter('accept_edits', auto.mode)).toBe(false)
    }
    // Codex cannot auto-accept edits, so Auto there asks, as Auto-accept edits does.
    expect(effectivePermissionMode('auto', supportedPermissionModes(CODEX_CAPS, CODEX_PERMISSION_LIMITS), { agent: 'Codex', limits: CODEX_PERMISSION_LIMITS }))
      .toEqual({ mode: 'ask', reason: 'Codex has no auto mode. Codex cannot auto-accept edits while asking for commands' })
  })

  it('is the nearest mode for Full access on a Claude Code whose settings forbid bypassing permissions', () => {
    const noBypass: PermissionLimits = { bypassDisabled: true }
    expect(effectivePermissionMode('full', supportedPermissionModes(caps({ autoPermissionMode: true }), noBypass), { limits: noBypass }))
      .toEqual({ mode: 'auto', reason: 'Claude Code settings disallow bypassing permissions' })
    expect(effectivePermissionMode('full', supportedPermissionModes(caps({ autoPermissionMode: false }), noBypass), { limits: noBypass }))
      .toEqual({ mode: 'accept_edits', reason: 'Claude Code settings disallow bypassing permissions' })
  })

  it('refuses at dispatch a binding recorded in Auto on an instance without an auto mode', () => {
    expect(autoPermissionModeAvailable({})).toBe(false)
    expect(checkPermissionMode(caps({ autoPermissionMode: true }), { permissionMode: 'auto' }, 'Claude Code')).toEqual({ ok: true })
    expect(checkPermissionMode(caps({ autoPermissionMode: false }), { permissionMode: 'auto' }, 'Claude Code', 'claude'))
      .toMatchObject({ ok: false, error: { code: 'permission_mode_unenforceable', instanceId: 'claude', supportedModes: ['ask', 'accept_edits', 'full'] } })
    expect(checkPermissionMode(caps({ autoPermissionMode: false }), { permissionMode: 'accept_edits' }, 'Claude Code')).toEqual({ ok: true })
  })
})

describe('Claude Code\'s auto mode', () => {
  it('is offered only on a Claude Code version that starts in it with --permission-mode auto alone', () => {
    expect(CLAUDE_AUTO_MODE_MIN_VERSION).toBe('2.1.111')
    expect(claudeCodeCaps(undefined).autoPermissionMode).toBe(false)
    expect(claudeCodeCaps('2.1.110').autoPermissionMode).toBe(false)
    expect(claudeCodeCaps('2.1.111').autoPermissionMode).toBe(true)
    expect(claudeCodeCaps('2.1.311').autoPermissionMode).toBe(true)
    expect(claudeCodeCaps('3.0.0').autoPermissionMode).toBe(true)
    // Everything else about the caps is unchanged.
    expect({ ...claudeCodeCaps('2.1.311'), autoPermissionMode: false }).toEqual(CLAUDE_CODE_CAPS)
  })

  it('is never offered on a locked entry, which runs bots in Claude Code\'s default mode', () => {
    expect(claudeLockedCaps(claudeCodeCaps('2.1.311'), { platform: 'linux', cliVersion: '2.1.311', managedPolicy: false }).autoPermissionMode).toBe(false)
  })

  it('maps Auto to the SDK\'s auto permission mode', () => {
    expect(CLAUDE_PERMISSION_MODES).toEqual({ ask: 'default', accept_edits: 'acceptEdits', auto: 'auto', full: 'bypassPermissions' })
  })

  it('leaves commands to the auto mode classifier, and keeps asking for them in the stricter modes', () => {
    expect(claudeModeAsks('auto', 'command')).toBe(false)
    expect(claudeModeAsks('auto', 'edit')).toBe(false)
    expect(claudeModeAsks('accept_edits', 'command')).toBe(true)
    expect(claudeModeAsks('accept_edits', 'edit')).toBe(false)
    expect(claudeModeAsks('ask', 'edit')).toBe(true)
    expect(claudeModeAsks('ask', 'command')).toBe(true)
    expect(claudeModeAsks('full', 'command')).toBe(false)
    for (const mode of PERMISSION_MODES) {
      expect(claudeModeAsks(mode, 'read')).toBe(false)
      expect(claudeModeAsks(mode, 'tool')).toBe(false)
    }
  })
})

describe('the gateway with Auto', () => {
  const homes: string[] = []
  const harnesses: Harness[] = []
  afterEach(() => {
    for (const harness of harnesses.splice(0)) harness.stop()
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
  })

  /** A Claude-like instance with an auto mode, and Codex without one (and without Auto-accept edits). */
  function fixture() {
    const home = mkdtempSync(join(tmpdir(), 'mousse-auto-mode-'))
    homes.push(home)
    const claude = new Recording('claude')
    const codex = new Recording('codex')
    let stored: unknown = { claude: { driver: 'claude', enabled: true }, codex: { driver: 'codex', enabled: true } }
    const instances = new ProviderInstanceService({ store: { read: () => ({ instances: stored, seedVersion: 1 }), write: (next) => { stored = next.instances } } })
    const harness = testHarness({
      drivers: [
        adapterDriver(claude, { toolControl: 'approval_only', autoPermissionMode: true }),
        adapterDriver(codex, { toolControl: 'approval_only', runtime: { permissionLimits: () => CODEX_PERMISSION_LIMITS } })
      ],
      instances,
      profileHome: home
    })
    harnesses.push(harness)
    const resolved = (instanceId: 'claude' | 'codex') => harness.resolveStored({ instanceId, llmProvider: '', model: 'm' }, { purpose: 'turn' })
    const spec = (binding: TurnSpec['binding'], instanceId: 'claude' | 'codex'): TurnSpec => ({
      binding,
      // The run engine passes the binding's mode to the runtime; the gateway checks they match.
      input: { threadId: 'thread-1', instanceId, llmProvider: instanceId, model: 'm', mode: 'agent', prompt: 'hi', permissionMode: binding.policy.permissionMode, signal: new AbortController().signal } as unknown as TurnInput,
      sink: { providerRef: () => {} } as unknown as TurnSpec['sink'],
      control: {} as TurnSpec['control'],
      host: {} as TurnSpec['host']
    })
    return { harness, claude, codex, resolved, spec }
  }

  it('binds Auto on the agent with an auto mode, and runs the turn in it', async () => {
    const { harness, claude, resolved, spec } = fixture()
    const binding = await harness.bind(resolved('claude'), { mode: 'agent', permissionMode: 'auto' })
    expect(binding.policy).toMatchObject({ permissionMode: 'auto', approvals: 'ask' })
    expect(binding.policy.requestedPermissionMode).toBeUndefined()
    await expect(harness.startTurn(spec(binding, 'claude')).result).resolves.toMatchObject({ text: 'ok' })
    expect(claude.turns.map((turn) => turn.permissionMode)).toEqual(['auto'])
  })

  it('binds Auto as Auto-accept edits would bind on an agent without one, keeping what the thread asked for', async () => {
    const { harness, codex, resolved, spec } = fixture()
    const auto = await harness.bind(resolved('codex'), { mode: 'agent', permissionMode: 'auto' })
    const edits = await harness.bind(resolved('codex'), { mode: 'agent', permissionMode: 'accept_edits' })
    expect(auto.policy.permissionMode).toBe(edits.policy.permissionMode)
    expect(auto.policy).toMatchObject({ permissionMode: 'ask', requestedPermissionMode: 'auto', approvals: 'ask' })
    await harness.startTurn(spec(auto, 'codex')).result
    expect(codex.turns.map((turn) => turn.permissionMode)).toEqual(['ask'])
  })

  it('applies the rule again when the thread moves to another provider and back', async () => {
    const { harness, resolved } = fixture()
    const modes: Array<PermissionMode | undefined> = []
    for (const instanceId of ['claude', 'codex', 'claude'] as const) {
      const preview = harness.previewPermissionMode(resolved(instanceId), 'auto')
      const binding = await harness.bind(resolved(instanceId), { mode: 'agent', permissionMode: 'auto' })
      expect(preview.mode).toBe(binding.policy.permissionMode)
      modes.push(binding.policy.permissionMode)
    }
    expect(modes).toEqual(['auto', 'ask', 'auto'])
  })

  it('refuses a binding forged in Auto on the agent without an auto mode, before the provider is touched', async () => {
    const { harness, codex, resolved, spec } = fixture()
    const edits = await harness.bind(resolved('codex'), { mode: 'agent', permissionMode: 'full' })
    const forged = { ...structuredClone(edits), policy: { ...edits.policy, approvals: 'ask' as const, permissionMode: 'auto' as const } }
    await expect(harness.startTurn(spec(forged, 'codex')).result).rejects.toMatchObject({ code: 'permission_mode_unenforceable' })
    expect(codex.turns).toEqual([])
  })
})
