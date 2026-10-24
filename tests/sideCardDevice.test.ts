import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import { DeviceSection } from '../src/renderer/components/sideCard/DeviceSection'
import {
  activeWorkspaceChoice,
  buildDeviceMenu,
  connectedRemoteDevices,
  hasDeviceChoices,
  localDeviceName,
  menuRowLabel,
  workspaceDraftForChoice
} from '../src/renderer/components/sideCard/deviceMenu'
import type { Device } from '../src/renderer/lib/netDevices'
import { composerWorkspaceFor, isComposerWorkspaceLocked, isNewEmptyThread } from '../src/renderer/lib/newThread'
import { useAppStore } from '../src/renderer/stores/appStore'
import type { Thread } from '../src/shared/types'

const device = (patch: Partial<Device>): Device => ({
  node: 'node-1' as Device['node'],
  name: 'Studio',
  caps: [],
  keyEpoch: 1,
  expiresAt: 0,
  self: false,
  revoked: false,
  state: 'open',
  ...patch
})

const thread = (patch: Partial<Thread>): Thread => ({
  id: 't1', name: 'New Thread', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', ...patch
}) as Thread

describe('isNewEmptyThread', () => {
  it('is true before any thread is selected', () => {
    expect(isNewEmptyThread(null, undefined, 0)).toBe(true)
  })

  it('is true for an unstarted thread with no messages', () => {
    expect(isNewEmptyThread('t1', thread({}), 0)).toBe(true)
  })

  it('is false once the thread has messages, a start time, or a real name', () => {
    expect(isNewEmptyThread('t1', thread({}), 1)).toBe(false)
    expect(isNewEmptyThread('t1', thread({ startedAt: '2026-01-01T00:00:01Z' }), 0)).toBe(false)
    expect(isNewEmptyThread('t1', thread({ name: 'Fix the parser' }), 0)).toBe(false)
  })

  it('is false while the selected thread is not loaded yet', () => {
    expect(isNewEmptyThread('t1', undefined, 0)).toBe(false)
  })
})

describe('composerWorkspaceFor', () => {
  it('prefers the draft and otherwise falls back to the thread', () => {
    expect(composerWorkspaceFor({ projectId: 'p', worktreeEnabled: true }, thread({ projectId: 'q' })))
      .toEqual({ projectId: 'p', worktreeEnabled: true })
    expect(composerWorkspaceFor(undefined, thread({ projectId: 'q', worktreeEnabled: true })))
      .toEqual({ projectId: 'q', worktreeEnabled: true })
    expect(composerWorkspaceFor(undefined, undefined)).toEqual({ projectId: undefined, worktreeEnabled: false })
  })
})

describe('isComposerWorkspaceLocked', () => {
  const turn = (phase: string) => ({ t1: { phase } as never })
  it('locks while loading or while the selected thread has an active turn', () => {
    expect(isComposerWorkspaceLocked({ loading: true, activeThreadId: null, turnStates: {} })).toBe(true)
    expect(isComposerWorkspaceLocked({ loading: false, activeThreadId: 't1', turnStates: turn('streaming') })).toBe(true)
    expect(isComposerWorkspaceLocked({ loading: false, activeThreadId: 't1', turnStates: turn('queued') })).toBe(true)
  })

  it('stays open when idle, or when only another thread is busy', () => {
    expect(isComposerWorkspaceLocked({ loading: false, activeThreadId: 't1', turnStates: turn('idle') })).toBe(false)
    expect(isComposerWorkspaceLocked({ loading: false, activeThreadId: 't2', turnStates: turn('streaming') })).toBe(false)
    expect(isComposerWorkspaceLocked({ loading: false, activeThreadId: null, turnStates: turn('streaming') })).toBe(false)
  })
})

describe('device menu options', () => {
  const workspace = { projectId: 'p', worktreeEnabled: false }

  it('names this computer, with a fallback', () => {
    expect(localDeviceName(' Mac mini ')).toBe('Mac mini')
    expect(localDeviceName('')).toBe('This computer')
    expect(localDeviceName(undefined)).toBe('This computer')
  })

  it('hides the Run on group with no other connected device', () => {
    expect(buildDeviceMenu({ localName: 'Mac', devices: [], workspace }).runOn).toBeNull()
    const ignored = [device({ self: true }), device({ revoked: true }), device({ state: 'closed' })]
    expect(connectedRemoteDevices(ignored)).toEqual([])
    expect(buildDeviceMenu({ localName: 'Mac', devices: ignored, workspace }).runOn).toBeNull()
  })

  it('lists this computer first and selected, and disables remote devices', () => {
    const { runOn } = buildDeviceMenu({ localName: 'Mac', devices: [device({ name: 'Studio' })], workspace })
    expect(runOn).toEqual([
      { id: 'local', name: 'Mac', active: true, disabled: false },
      { id: 'node-1', name: 'Studio', active: false, disabled: true, reason: 'Not available yet' }
    ])
  })

  it('says why remote devices are dimmed once, not on every row', () => {
    const model = buildDeviceMenu({
      localName: 'Mac', devices: [device({ name: 'Studio' }), device({ node: 'node-2' as Device['node'], name: 'Laptop' })], workspace
    })
    expect(model.runOnNote).toBe('Not available yet')
    expect(buildDeviceMenu({ localName: 'Mac', devices: [], workspace }).runOnNote).toBeUndefined()
  })

  it('puts the reason for a disabled row in its accessible name', () => {
    expect(menuRowLabel('Current checkout', 'Needs a project')).toBe('Current checkout, needs a project')
    expect(menuRowLabel('Current checkout', undefined)).toBe('Current checkout')
  })

  it('has choices only with a project or a pickable device', () => {
    const noProject = { worktreeEnabled: false }
    expect(hasDeviceChoices(buildDeviceMenu({ localName: 'Mac', devices: [], workspace }))).toBe(true)
    expect(hasDeviceChoices(buildDeviceMenu({ localName: 'Mac', devices: [], workspace: noProject }))).toBe(false)
    // Another device that cannot be picked yet, and this computer already selected, change nothing.
    expect(hasDeviceChoices(buildDeviceMenu({ localName: 'Mac', devices: [device({})], workspace: noProject }))).toBe(false)
  })

  it('marks the active workspace choice', () => {
    const checkout = buildDeviceMenu({ localName: 'Mac', devices: [], workspace }).workspace
    expect(checkout.map((option) => [option.id, option.label, option.active])).toEqual([
      ['checkout', 'Current checkout', true],
      ['worktree', 'New worktree', false]
    ])
    const worktree = buildDeviceMenu({ localName: 'Mac', devices: [], workspace: { ...workspace, worktreeEnabled: true } }).workspace
    expect(worktree.map((option) => option.active)).toEqual([false, true])
  })

  it('disables the workspace choices without a project, as the composer toolbar does', () => {
    const { workspace: options } = buildDeviceMenu({
      localName: 'Mac', devices: [], workspace: { worktreeEnabled: true }
    })
    expect(options.every((option) => option.disabled)).toBe(true)
    expect(options[0]?.active).toBe(true)
  })

  it('writes a choice into the draft and keeps the project', () => {
    expect(workspaceDraftForChoice(workspace, 'worktree')).toEqual({ projectId: 'p', worktreeEnabled: true })
    expect(workspaceDraftForChoice({ projectId: 'p', worktreeEnabled: true }, 'checkout')).toEqual({ projectId: 'p', worktreeEnabled: false })
    expect(activeWorkspaceChoice({ projectId: 'p', worktreeEnabled: true })).toBe('worktree')
  })
})

describe('DeviceSection rendering', () => {
  const initial = useAppStore.getInitialState()
  // Server rendering reads a store's initial state, so the seed goes there too.
  const seed = (state: Partial<ReturnType<typeof useAppStore.getState>>) => {
    useAppStore.setState(state)
    Object.assign(initial, state)
  }
  const render = () => renderToStaticMarkup(createElement(DeviceSection, { threadId: 't1', projectId: null }))

  afterEach(() => {
    seed({ activeThreadId: null, threads: [], messages: [], appInfo: null, loading: false, turnStates: {} })
  })

  it('shows a running thread as plain text with no button or chevron', () => {
    seed({
      activeThreadId: 't1',
      threads: [thread({ startedAt: '2026-01-01T00:00:01Z' })],
      messages: [],
      appInfo: { platform: 'darwin', repoRoot: '/', llmProvider: 'x', deviceName: 'Mac mini' }
    })
    const html = render()
    expect(html).toContain('Mac mini')
    expect(html).not.toContain('<button')
    expect(html).not.toContain('<svg')
    expect(html).not.toContain('aria-haspopup')
  })

  it('falls back to This computer', () => {
    seed({ activeThreadId: 't1', threads: [thread({ startedAt: '2026-01-01T00:00:01Z' })], appInfo: null })
    expect(render()).toContain('This computer')
  })

  it('shows a button with a chevron on a new, empty thread with a project', () => {
    seed({ activeThreadId: 't1', threads: [thread({ projectId: 'p' })], messages: [], appInfo: null })
    const html = render()
    expect(html).toContain('<button')
    expect(html).toContain('aria-haspopup="menu"')
    expect(html).toContain('<svg')
    // The visible name is not repeated as a tooltip.
    expect(html).not.toContain('title=')
  })

  it('shows plain text when there is nothing to pick', () => {
    seed({ activeThreadId: 't1', threads: [thread({})], messages: [], appInfo: null })
    const html = render()
    expect(html).toContain('This computer')
    expect(html).not.toContain('<button')
    expect(html).not.toContain('<svg')
  })

  it('shows plain text while a send is in flight', () => {
    seed({ activeThreadId: 't1', threads: [thread({ projectId: 'p' })], messages: [], loading: true })
    expect(render()).not.toContain('<button')
    seed({
      loading: false,
      turnStates: { t1: { threadId: 't1', phase: 'thinking' } as never }
    })
    expect(render()).not.toContain('<button')
  })
})
