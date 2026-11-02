import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import { DeviceSection } from '../src/renderer/components/sideCard/DeviceSection'
import {
  activeWorkspaceChoice,
  buildDeviceMenu,
  canPickComputer,
  connectedRemoteDevices,
  hasDeviceChoices,
  localDeviceName,
  menuRowLabel,
  runOnLabel,
  notSharingReason,
  thisComputerLacksGrant,
  workspaceDraftForChoice
} from '../src/renderer/components/sideCard/deviceMenu'
import type { Device } from '../src/renderer/lib/netDevices'
import {
  composerWorkspaceFor,
  isComposerWorkspaceLocked,
  isNewEmptyThread,
  localProjectIdOf,
  localWorkspaceFor,
  workspaceOnOtherComputer,
  workspaceOnThisComputer
} from '../src/renderer/lib/newThread'
import { workspaceOnDevice } from '../src/renderer/lib/remoteComputers'
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
    expect(composerWorkspaceFor({ projectId: 'p', worktreeEnabled: true }, thread({ projectId: 'q' }), false))
      .toEqual({ projectId: 'p', worktreeEnabled: true })
    expect(composerWorkspaceFor(undefined, thread({ projectId: 'q', worktreeEnabled: true }), false))
      .toEqual({ projectId: 'q', worktreeEnabled: true })
    expect(composerWorkspaceFor(undefined, undefined, false)).toEqual({ projectId: undefined, worktreeEnabled: false })
  })

  it('takes the "Start new chats in a worktree" setting until the thread or draft chooses', () => {
    expect(composerWorkspaceFor(undefined, undefined, true)).toEqual({ projectId: undefined, worktreeEnabled: true })
    expect(composerWorkspaceFor(undefined, thread({ projectId: 'q' }), true)).toEqual({ projectId: 'q', worktreeEnabled: true })
    // A thread that chose its project's folder keeps it, whatever the setting says.
    expect(composerWorkspaceFor(undefined, thread({ projectId: 'q', worktreeEnabled: false }), true)).toEqual({ projectId: 'q', worktreeEnabled: false })
    expect(composerWorkspaceFor({ projectId: 'q', worktreeEnabled: false }, thread({ projectId: 'q' }), true)).toEqual({ projectId: 'q', worktreeEnabled: false })
  })
})

describe('picking where a new chat runs', () => {
  const local = [{ id: 'a', name: 'app', path: '/Users/me/app' }, { id: 'b', name: 'lib', path: '/Users/me/lib' }] as never[]
  const node = 'node-1' as Device['node']
  const other = 'node-2' as Device['node']
  /** The projects as this computer lists them: its own, and each other computer's with the local project it is the same repository as. */
  const listed = [
    ...local,
    { id: 'node-1:remote-a', name: 'app', path: '/home/studio/app', node, sameAs: 'a' },
    { id: 'node-1:remote-x', name: 'other', path: '/home/studio/other', node },
    { id: 'node-2:other-a', name: 'app', path: 'D:\\app', node: other, sameAs: 'b' }
  ] as never[]

  it('carries a project to another computer when that computer lists the same repository', () => {
    expect(workspaceOnDevice({ projectId: 'a', worktreeEnabled: true }, listed, node))
      .toEqual({ projectId: 'node-1:remote-a', worktreeEnabled: true, node, localProjectId: 'a' })
  })

  it('starts without a project, and without a worktree, when nothing matches or there is no project here', () => {
    expect(workspaceOnDevice({ projectId: 'b', worktreeEnabled: true }, listed, node))
      .toEqual({ projectId: undefined, worktreeEnabled: false, node, localProjectId: 'b' })
    expect(workspaceOnDevice({ worktreeEnabled: false }, listed, node)).toEqual({ projectId: undefined, worktreeEnabled: false, node })
  })

  it('restores the project the draft had here when this computer is picked again', () => {
    const away = workspaceOnDevice({ projectId: 'a', worktreeEnabled: true }, listed, node)
    expect(workspaceOnDevice(away, listed, undefined)).toEqual({ projectId: 'a', worktreeEnabled: true })
    // A project that was removed meanwhile does not come back.
    expect(workspaceOnDevice(away, listed.filter((project) => (project as { id: string }).id !== 'a'), undefined)).toEqual({ projectId: undefined, worktreeEnabled: false })
    // Nothing remembered, nothing restored; another computer's project id never counts as one of this computer's.
    expect(workspaceOnDevice({ projectId: 'node-1:remote-x', worktreeEnabled: false, node }, listed, undefined))
      .toEqual({ projectId: undefined, worktreeEnabled: false })
  })

  it('matches from the remembered local project when going from one computer to another', () => {
    const first = workspaceOnDevice({ projectId: 'a', worktreeEnabled: false }, listed, node)
    // The other computer lists no project for app, only for lib.
    expect(workspaceOnDevice(first, listed, other)).toEqual({ projectId: undefined, worktreeEnabled: false, node: other, localProjectId: 'a' })
    expect(workspaceOnDevice({ projectId: 'b', worktreeEnabled: false }, listed, other))
      .toEqual({ projectId: 'node-2:other-a', worktreeEnabled: false, node: other, localProjectId: 'b' })
    // Without a remembered local project, the next computer starts empty.
    expect(workspaceOnDevice({ projectId: 'node-1:remote-a', worktreeEnabled: false, node }, listed, other))
      .toEqual({ projectId: undefined, worktreeEnabled: false, node: other })
  })

  it('names the project a draft has on this computer, wherever it runs', () => {
    expect(localProjectIdOf({ projectId: 'a', worktreeEnabled: false })).toBe('a')
    expect(localProjectIdOf({ projectId: 'remote-a', worktreeEnabled: false, node, localProjectId: 'a' })).toBe('a')
    expect(localProjectIdOf({ projectId: 'remote-a', worktreeEnabled: false, node })).toBeUndefined()
    expect(workspaceOnThisComputer({ projectId: 'x', worktreeEnabled: true }, local)).toEqual({ projectId: undefined, worktreeEnabled: false })
    expect(workspaceOnOtherComputer({ projectId: 'a', worktreeEnabled: true }, node, undefined))
      .toEqual({ projectId: undefined, worktreeEnabled: false, node, localProjectId: 'a' })
  })

  it('does not use another computer\'s project ids for work that runs here', () => {
    expect(localWorkspaceFor({ projectId: 'y', worktreeEnabled: true, node }, undefined, false)).toEqual({ worktreeEnabled: false })
    expect(localWorkspaceFor({ projectId: 'a', worktreeEnabled: true }, undefined, false)).toEqual({ projectId: 'a', worktreeEnabled: true })
    expect(localWorkspaceFor(undefined, thread({ projectId: 'q' }), false)).toEqual({ projectId: 'q', worktreeEnabled: false })
    // An empty chat that was created on another computer is a chat for it.
    expect(localWorkspaceFor(undefined, thread({ projectId: 'node-1:q', node }), false)).toEqual({ worktreeEnabled: false })
    expect(composerWorkspaceFor(undefined, thread({ projectId: 'node-1:q', node }), false)).toEqual({ projectId: 'node-1:q', worktreeEnabled: false, node })
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

  it('offers no Run on group, and no way to pick, with no other computer connected', () => {
    const ignored = [
      device({ self: true }),
      device({ revoked: true }),
      device({ state: 'closed' }),
      device({ state: 'connecting' })
    ]
    expect(connectedRemoteDevices(ignored)).toEqual([])
    for (const devices of [[], ignored]) {
      expect(canPickComputer(devices, undefined)).toBe(false)
      expect(buildDeviceMenu({ localName: 'Mac', devices, workspace }).runOn).toBeNull()
    }
    // A draft that names a computer keeps the way back to this one, even when that computer dropped offline.
    expect(canPickComputer([], 'node-1' as Device['node'])).toBe(true)
    expect(buildDeviceMenu({ localName: 'Mac', devices: [], workspace: { ...workspace, node: 'node-1' as Device['node'] } }).runOn)
      .toEqual([{ id: 'local', name: 'Mac', active: false, disabled: false }])
  })

  it('leaves phones out, and treats a device without a kind as a computer', () => {
    const devices = [
      device({ node: 'phone' as Device['node'], name: 'Pocket', kind: 'phone' }),
      device({ node: 'old' as Device['node'], name: 'Old daemon' }),
      device({ node: 'big' as Device['node'], name: 'Studio', kind: 'computer' })
    ]
    expect(connectedRemoteDevices(devices).map((entry) => entry.name)).toEqual(['Old daemon', 'Studio'])
    const model = buildDeviceMenu({ localName: 'Mac', devices, workspace })
    expect(model.runOn?.map((option) => option.name)).toEqual(['Mac', 'Old daemon', 'Studio'])
  })

  it('lists this computer first and every connected computer as pickable when this computer works on threads', () => {
    const mine = device({ self: true, node: 'node-0' as Device['node'], name: 'Mac', caps: ['read', 'chat', 'write', 'settings'] })
    // The other computer's own grant is not asked about: routing checks the caller's.
    const { runOn } = buildDeviceMenu({ localName: 'Mac', devices: [mine, device({ name: 'Studio', caps: ['read', 'chat', 'write'] })], workspace })
    expect(runOn).toEqual([
      { id: 'local', name: 'Mac', active: true, disabled: false },
      { id: 'node-1', name: 'Studio', active: false, disabled: false }
    ])
    // A list from a daemon that does not name this computer is taken as able.
    expect(buildDeviceMenu({ localName: 'Mac', devices: [device({ name: 'Studio' })], workspace }).runOn?.[1]).toMatchObject({ disabled: false })
  })

  it('names the connected computers, and says what is missing, when this computer has no grant to work on threads', () => {
    const mine = device({ self: true, node: 'node-0' as Device['node'], name: 'Mac', caps: ['read', 'chat', 'write'] })
    const { runOn } = buildDeviceMenu({ localName: 'Mac', devices: [mine, device({ name: 'Studio', caps: ['read', 'chat', 'write', 'settings'] })], workspace })
    expect(runOn?.[1]).toEqual({ id: 'node-1', name: 'Studio', active: false, disabled: true, reason: thisComputerLacksGrant('Mac') })
    expect(thisComputerLacksGrant('Mac')).toContain('on the computer that manages your devices')
    // Nothing asks for the other computer to be given anything.
    expect(thisComputerLacksGrant('Mac')).not.toContain('Studio')
    // A pick that is already made stays pickable, so a person can see where the chat runs.
    const picked = buildDeviceMenu({ localName: 'Mac', devices: [mine, device({ name: 'Studio' })], workspace: { ...workspace, node: 'node-1' as Device['node'] } })
    expect(picked.runOn?.[1]).toMatchObject({ active: true, disabled: false })
  })

  it('names a computer that stopped sharing its threads, and says how to start again, without granting anything', () => {
    const mine = device({ self: true, node: 'node-0' as Device['node'], name: 'Mac', caps: ['settings'] })
    const { runOn } = buildDeviceMenu({ localName: 'Mac', devices: [mine, device({ name: 'Studio' })], workspace, notSharing: new Set(['node-1']) })
    expect(runOn?.[1]).toEqual({ id: 'node-1', name: 'Studio', active: false, disabled: true, reason: notSharingReason('Studio') })
    expect(notSharingReason('Studio')).toContain('on Studio')
  })

  it('marks the picked computer, and none when it is no longer connected', () => {
    const devices = [device({ name: 'Studio' })]
    const picked = buildDeviceMenu({ localName: 'Mac', devices, workspace: { ...workspace, node: 'node-1' as Device['node'] } })
    expect(picked.runOn?.map((option) => option.active)).toEqual([false, true])
    const gone = buildDeviceMenu({ localName: 'Mac', devices: [], workspace: { ...workspace, node: 'node-1' as Device['node'] } })
    expect(gone.runOn?.map((option) => option.active)).toEqual([false])
  })

  it('labels the button with the picked computer, this one, or a stale pick', () => {
    const devices = [device({ name: 'Studio' }), device({ node: 'node-2' as Device['node'], name: 'Pocket', state: 'closed' })]
    expect(runOnLabel('Mac', devices, undefined)).toBe('Mac')
    expect(runOnLabel('Mac', devices, 'node-1' as Device['node'])).toBe('Studio')
    // A computer that dropped offline keeps its name; one that left the roster does not.
    expect(runOnLabel('Mac', devices, 'node-2' as Device['node'])).toBe('Pocket')
    expect(runOnLabel('Mac', devices, 'node-9' as Device['node'])).toBe('Unavailable computer')
  })

  it('puts the reason for a disabled row in its accessible name', () => {
    expect(menuRowLabel('Current checkout', 'Needs a project')).toBe('Current checkout, needs a project')
    expect(menuRowLabel('Current checkout', undefined)).toBe('Current checkout')
  })

  it('has choices only with a project or a pickable device', () => {
    const noProject = { worktreeEnabled: false }
    expect(hasDeviceChoices(buildDeviceMenu({ localName: 'Mac', devices: [], workspace }))).toBe(true)
    expect(hasDeviceChoices(buildDeviceMenu({ localName: 'Mac', devices: [], workspace: noProject }))).toBe(false)
    // This computer already selected and nothing else to pick changes nothing; a connected computer does.
    expect(hasDeviceChoices(buildDeviceMenu({ localName: 'Mac', devices: [device({ state: 'closed' })], workspace: noProject }))).toBe(false)
    expect(hasDeviceChoices(buildDeviceMenu({ localName: 'Mac', devices: [device({})], workspace: noProject }))).toBe(true)
    // A computer that cannot be picked is not a choice.
    const lacking = device({ self: true, node: 'node-0' as Device['node'], caps: [] })
    expect(hasDeviceChoices(buildDeviceMenu({ localName: 'Mac', devices: [lacking, device({})], workspace: noProject }))).toBe(false)
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

  it('keeps the picked computer when a workspace choice is made', () => {
    expect(workspaceDraftForChoice({ ...workspace, node: 'node-1' as Device['node'], localProjectId: 'l' }, 'worktree'))
      .toEqual({ projectId: 'p', worktreeEnabled: true, node: 'node-1', localProjectId: 'l' })
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
  // The section's heading always has its collapse toggle (a button with a chevron); the picker lives in the body.
  const renderBody = () => {
    const html = render()
    const start = html.indexOf('class="side-card-section-body"')
    expect(start).toBeGreaterThan(-1)
    return html.slice(start)
  }

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
    const html = renderBody()
    expect(html).toContain('Mac mini')
    expect(html).not.toContain('<button')
    expect(html).not.toContain('<svg')
    expect(html).not.toContain('aria-haspopup')
  })

  it('names the other computer, and offers no editor, for a thread that runs there', () => {
    seed({
      activeThreadId: 'nod_studio:t1',
      threads: [thread({ id: 'nod_studio:t1', node: 'nod_studio', startedAt: '2026-01-01T00:00:01Z', projectId: 'nod_studio:p' } as Partial<Thread>)],
      appInfo: { platform: 'darwin', repoRoot: '/', llmProvider: 'x', deviceName: 'Mac mini' }
    })
    const html = render()
    expect(html).toContain('Another computer')
    expect(html).not.toContain('Mac mini')
    expect(html).not.toContain('aria-haspopup')
  })

  it('falls back to This computer', () => {
    seed({ activeThreadId: 't1', threads: [thread({ startedAt: '2026-01-01T00:00:01Z' })], appInfo: null })
    expect(render()).toContain('This computer')
  })

  it('shows a button with a chevron on a new, empty thread with a project', () => {
    seed({ activeThreadId: 't1', threads: [thread({ projectId: 'p' })], messages: [], appInfo: null })
    const html = renderBody()
    expect(html).toContain('<button')
    expect(html).toContain('aria-haspopup="menu"')
    expect(html).toContain('<svg')
    // The visible name is not repeated as a tooltip.
    expect(html).not.toContain('title=')
  })

  it('shows plain text when there is nothing to pick', () => {
    seed({ activeThreadId: 't1', threads: [thread({})], messages: [], appInfo: null })
    const html = renderBody()
    expect(html).toContain('This computer')
    expect(html).not.toContain('<button')
    expect(html).not.toContain('<svg')
  })

  it('shows plain text while a send is in flight', () => {
    seed({ activeThreadId: 't1', threads: [thread({ projectId: 'p' })], messages: [], loading: true })
    expect(renderBody()).not.toContain('<button')
    seed({
      loading: false,
      turnStates: { t1: { threadId: 't1', phase: 'thinking' } as never }
    })
    expect(renderBody()).not.toContain('<button')
  })
})

describe('device menu stylesheet', () => {
  it('keeps the menu free of transitions, so focus can move in once it is positioned', () => {
    const css = readFileSync(resolve(__dirname, '../src/renderer/components/sideCard/deviceSection.css'), 'utf8')
    const start = css.indexOf('.side-card-device-menu {')
    expect(start).toBeGreaterThan(-1)
    expect(css.slice(start, css.indexOf('}', start))).toMatch(/transition:\s*none/)
  })
})
