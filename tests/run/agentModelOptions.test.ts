/**
 * What `list_models` offers an agent is what the model picker offers a person (`pickerProviders`): entries switched on
 * in the scope, less locked ones (bot turns only), with their models less the hidden ones. An entry that cannot run
 * now is listed with the reason, so the agent can repeat it.
 */
import { describe, expect, it } from 'vitest'
import { agentModelEntries } from '../../src/mms/orchestrator/agentModelOptions'
import type { InstanceSnapshot } from '../../src/shared/harness/status'

const snapshot = (instanceId: string, patch: Record<string, unknown> = {}): InstanceSnapshot => ({
  instanceId,
  driver: 'pi',
  displayName: instanceId,
  builtIn: false,
  scope: { kind: 'device' },
  enabled: { device: true, effective: true, setBy: 'device' },
  install: { state: 'installed', canInstall: false },
  runs: { state: 'yes' },
  auth: { state: 'signed_in' },
  compatibility: { state: 'tested' },
  caps: { toolControl: 'exact' },
  checkedAt: '2026-11-13T00:00:00.000Z',
  models: {
    entries: [
      { id: 'shown', label: 'Shown', source: 'catalog', capabilities: { efforts: ['low', 'high'], defaultEffort: 'low' }, hidden: false, favorite: false },
      { id: 'hidden', label: 'Hidden', source: 'catalog', capabilities: { efforts: [] }, hidden: true, favorite: false }
    ]
  },
  ...patch
}) as unknown as InstanceSnapshot

describe('agentModelEntries', () => {
  it.each([
    ['an entry that can run', snapshot('ok'), { instanceId: 'ok', ready: true, subagents: true }],
    ['a signed-out entry, with why', snapshot('out', { auth: { state: 'signed_out' } }), { instanceId: 'out', ready: false, status: 'Not signed in' }],
    ['an expired sign-in', snapshot('old', { auth: { state: 'expired' } }), { instanceId: 'old', ready: false, status: 'Sign-in expired' }],
    ['an agent that approves tools itself: no subagents', snapshot('self', { caps: { toolControl: 'uncontrolled' } }), { instanceId: 'self', ready: true, subagents: false }]
  ])('lists %s', (_name, input, expected) => {
    const [entry] = agentModelEntries([input])
    expect(entry).toMatchObject(expected)
    // Hidden models are left out; levels come with each model.
    expect(entry!.models).toEqual([{ id: 'shown', name: 'Shown', efforts: ['low', 'high'], defaultEffort: 'low' }])
  })

  it.each([
    ['switched off in the scope', snapshot('off', { enabled: { device: false, effective: false, setBy: 'device' } })],
    ['locked to bot turns', snapshot('locked', { config: { profile: 'locked' } })]
  ])('leaves out an entry %s, as the picker does', (_name, input) => {
    expect(agentModelEntries([input])).toEqual([])
  })
})
