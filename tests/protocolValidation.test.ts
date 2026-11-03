/**
 * Adversarial validation of protocol nested payloads.
 */

import { describe, expect, it } from 'vitest'
import { buildScheduleAddInput } from '../src/cli/commands/schedule'
import { parseArgs } from '../src/cli/parseArgs'
import {
  asCreateScheduledJobInput,
  asCursorMcpConfigPatch,
  asPlainObject,
  asScheduledJobPatch,
  asSettingsPartial,
  asStringEnvMap,
  asTaskStatus
} from '../src/mms/protocol/validators'

describe('protocol nested validators', () => {
  it('rejects prototype pollution keys', () => {
    const polluted = JSON.parse('{"constructor":{"prototype":{"x":1}}}')
    expect(() => asPlainObject(polluted, 'o')).toThrow(/forbidden/)
    const settingsPolluted = JSON.parse(
      '{"profile":{"username":"a"},"constructor":{"evil":true}}'
    )
    expect(() => asSettingsPartial(settingsPolluted)).toThrow()
  })

  it('validates schedule discriminants and ranges', () => {
    expect(
      asCreateScheduledJobInput({
        name: 'n',
        prompt: 'p',
        schedule: { kind: 'interval', minutes: 30 }
      }).schedule.minutes
    ).toBe(30)
    expect(() =>
      asCreateScheduledJobInput({
        name: 'n',
        prompt: 'p',
        schedule: { kind: 'interval', minutes: 0 }
      })
    ).toThrow(/minutes/)
    expect(() =>
      asCreateScheduledJobInput({
        name: 'n',
        prompt: 'p',
        schedule: { kind: 'once' }
      })
    ).toThrow(/runAt/)
    expect(() =>
      asCreateScheduledJobInput({
        name: 'n',
        prompt: 'p',
        schedule: { kind: 'cron', expr: 'bad' }
      })
    ).toThrow(/cron/)
    expect(() =>
      asCreateScheduledJobInput({
        name: 'n',
        prompt: 'p',
        schedule: { kind: 'interval', minutes: 5 },
        evil: true
      })
    ).toThrow(/not allowed/)
  })

  it('validates job patches', () => {
    expect(asScheduledJobPatch({ enabled: false }).enabled).toBe(false)
    expect(() => asScheduledJobPatch({ state: 'running' })).toThrow(/not allowed/)
  })

  it('accepts a manual schedule and rejects unknown kinds', () => {
    expect(asCreateScheduledJobInput({ name: 'n', prompt: 'p', schedule: { kind: 'manual' } }).schedule).toEqual({ kind: 'manual' })
    expect(() => asCreateScheduledJobInput({ name: 'n', prompt: 'p', schedule: { kind: 'sometimes' } })).toThrow(/once\|interval\|cron\|manual/)
  })

  it('validates a job\'s model, mode and workspace', () => {
    const input = asCreateScheduledJobInput({
      name: 'n',
      prompt: 'p',
      schedule: { kind: 'manual' },
      selection: { instanceId: 'codex', model: 'gpt-x' },
      mode: 'plan',
      workspace: { kind: 'worktree', path: '/repo/wt' }
    })
    expect(input.selection).toEqual({ instanceId: 'codex', llmProvider: '', model: 'gpt-x' })
    expect(input.mode).toBe('plan')
    expect(input.workspace).toEqual({ kind: 'worktree', path: '/repo/wt' })
    expect(asCreateScheduledJobInput({ name: 'n', prompt: 'p', schedule: { kind: 'manual' }, workspace: { kind: 'newWorktree' } }).workspace).toEqual({ kind: 'newWorktree' })
    const base = { name: 'n', prompt: 'p', schedule: { kind: 'manual' } }
    expect(() => asCreateScheduledJobInput({ ...base, mode: 'yolo' })).toThrow(/agent\|plan/)
    expect(() => asCreateScheduledJobInput({ ...base, workspace: { kind: 'elsewhere' } })).toThrow(/project\|newWorktree\|worktree/)
    expect(() => asCreateScheduledJobInput({ ...base, workspace: { kind: 'worktree' } })).toThrow(/path/)
    expect(() => asCreateScheduledJobInput({ ...base, selection: { model: 'm' } })).toThrow(/instanceId or selection.llmProvider/)
  })

  it('accepts what `schedule add` sends, and a stored empty provider', () => {
    // CLI to protocol: the flags become the request, and the protocol takes the request.
    const argv = ['schedule', 'add', '--name', 'Check CI', '--prompt', 'Check CI', '--manual', '--instance', 'codex', '--model', 'gpt-x', '--mode', 'plan', '--workspace', 'new-worktree', '--project', 'p1']
    const args = parseArgs(argv)
    const input = buildScheduleAddInput('Check CI', 'Check CI', { kind: 'manual' }, args.flags)
    const parsed = asCreateScheduledJobInput(JSON.parse(JSON.stringify(input)))
    expect(parsed).toMatchObject({ selection: { instanceId: 'codex', model: 'gpt-x' }, mode: 'plan', workspace: { kind: 'newWorktree' }, projectId: 'p1', schedule: { kind: 'manual' } })
    // `--mode json` is the output format, not a job mode.
    const json = parseArgs(['--mode', 'json', ...argv.filter((_, index) => argv[index - 1] !== '--mode' && argv[index] !== '--mode')])
    expect(buildScheduleAddInput('n', 'p', { kind: 'manual' }, json.flags).mode).toBeUndefined()
    expect(() => buildScheduleAddInput('n', 'p', { kind: 'manual' }, parseArgs(['schedule', 'add', '--mode', 'yolo']).flags)).toThrow(/agent or plan/)
    expect(() => buildScheduleAddInput('n', 'p', { kind: 'manual' }, parseArgs(['schedule', 'add', '--model', 'm']).flags)).toThrow(/go together/)
    // A selection saved with an empty provider still passes.
    expect(asCreateScheduledJobInput({ name: 'n', prompt: 'p', schedule: { kind: 'manual' }, selection: { instanceId: 'codex', llmProvider: '', model: 'gpt-x' } }).selection)
      .toEqual({ instanceId: 'codex', llmProvider: '', model: 'gpt-x' })
  })

  it('lets a patch clear the model, mode and workspace with null', () => {
    expect(asScheduledJobPatch({ selection: null, mode: null, workspace: null })).toMatchObject({ selection: null, mode: null, workspace: null })
    expect(asScheduledJobPatch({ mode: 'agent', workspace: { kind: 'project' } })).toMatchObject({ mode: 'agent', workspace: { kind: 'project' } })
  })

  it('bounds settings partials and env maps', () => {
    expect(asSettingsPartial({ profile: { username: 'u' } })).toEqual({
      profile: { username: 'u' }
    })
    expect(asSettingsPartial({ context: { compactionTokens: 256000 } })).toEqual({
      context: { compactionTokens: 256000 }
    })
    expect(asSettingsPartial({ notifications: { threadCompletionSound: false } })).toEqual({
      notifications: { threadCompletionSound: false }
    })
    // Shortcut overrides, including `null` for an unbound command, pass through unchanged.
    expect(asSettingsPartial({ shortcuts: { 'thread.new': 'CommandOrControl+Shift+X', 'thread.next': null } })).toEqual({
      shortcuts: { 'thread.new': 'CommandOrControl+Shift+X', 'thread.next': null }
    })
    expect(() => asSettingsPartial({ notASection: true })).toThrow(/not allowed/)
    // The General page saves the default permission mode and the run settings through this patch.
    expect(asSettingsPartial({ permissions: { defaultMode: 'full' } })).toEqual({ permissions: { defaultMode: 'full' } })
    expect(asSettingsPartial({ runs: { resumeAfterUsageLimit: true, usageLimitPauseCap: 5 } })).toEqual({
      runs: { resumeAfterUsageLimit: true, usageLimitPauseCap: 5 }
    })
    for (const bad of [{ defaultMode: 'root' }, { defaultMode: 1 }, { extra: 'ask' }])
      expect(() => asSettingsPartial({ permissions: bad }), JSON.stringify(bad)).toThrow(/permissions/)
    for (const bad of [{ resumeAfterUsageLimit: 'yes' }, { usageLimitPauseCap: 0 }, { usageLimitPauseCap: 2.5 }, { usageLimitPauseCap: 99 }, { extra: 1 }])
      expect(() => asSettingsPartial({ runs: bad }), JSON.stringify(bad)).toThrow(/runs/)
    expect(asStringEnvMap({ FOO: 'bar' }).FOO).toBe('bar')
    expect(() => asStringEnvMap({ 'bad-key': 'x' })).toThrow()
    expect(() => asStringEnvMap({ FOO: 'x'.repeat(5000) })).toThrow()
  })

  it('validates task status and MCP patch size', () => {
    expect(asTaskStatus('pending')).toBe('pending')
    expect(() => asTaskStatus('nope')).toThrow()
    expect(() => asCursorMcpConfigPatch({ a: 'x'.repeat(250_000) })).toThrow(/max size/)
  })
})
