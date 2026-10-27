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
    expect(composerWorkspaceFor({ projectId: 'p', worktreeEnabled: true }, thread({ projectId: 'q' })))
      .toEqual({ projectId: 'p', worktreeEnabled: true })
    expect(composerWorkspaceFor(undefined, thread({ projectId: 'q', worktreeEnabled: true })))
      .toEqual({ projectId: 'q', worktreeEnabled: true })
    expect(composerWorkspaceFor(undefined, undefined)).toEqual({ projectId: undefined, worktreeEnabled: false })
  })
})

describe('picking where a new chat runs', () => {
  const local = [{ id: 'a', name: 'app', path: '/Users/me/app' }, { id: 'b', name: 'lib', path: '/Users/me/lib' }] as never[]
  const node = 'node-1' as Device['node']
  const other = 'node-2' as Device['node']
  const identity = { roots: ['r1'], remotes: ['example.com/app'] }

  /** Platform requests as the daemon answers them; the target's project for `roots` is `match`. */
  function platform(match: Record<string, string | undefined>) {
    const requests: Array<[string, any]> = []
    ;(globalThis as { window?: unknown }).window = {
      mousse: {
        platformRequest: {
          request: async (method: string, params: any) => {
            requests.push([method, params])
            if (method !== 'bridge.hub.matchProject') throw new Error('unexpected ' + method)
            const projectId = match[params.target]
            return projectId ? { projectId } : {}
          }
        }
      }
    }
    return requests
  }
  afterEach(() => { delete (globalThis as { window?: unknown }).window })

  it('carries a project to another computer by repository, sending the identity and no path', async () => {
    const requests = platform({ [node]: 'remote-a' })
    const next = await workspaceOnDevice({ projectId: 'a', worktreeEnabled: true }, local, node, async () => identity)
    expect(next).toEqual({ projectId: 'remote-a', worktreeEnabled: true, node, localProjectId: 'a' })
    expect(requests).toEqual([['bridge.hub.matchProject', { target: node, roots: ['r1'], remotes: ['example.com/app'] }]])
    expect(JSON.stringify(requests)).not.toContain('/Users/me')
  })

  it('starts without a project, and without a worktree, when nothing matches or the folder is not a repository', async () => {
    platform({})
    const none = await workspaceOnDevice({ projectId: 'a', worktreeEnabled: true }, local, node, async () => identity)
    expect(none).toEqual({ projectId: undefined, worktreeEnabled: false, node, localProjectId: 'a' })
    const requests = platform({ [node]: 'never' })
    const plain = await workspaceOnDevice({ projectId: 'b', worktreeEnabled: true }, local, node, async () => null)
    expect(plain).toEqual({ projectId: undefined, worktreeEnabled: false, node, localProjectId: 'b' })
    // Nothing to match without a project here, and a failed match does not stop the pick.
    expect(await workspaceOnDevice({ worktreeEnabled: false }, local, node, async () => identity))
      .toEqual({ projectId: undefined, worktreeEnabled: false, node })
    expect(requests).toEqual([])
    const failing = await workspaceOnDevice({ projectId: 'a', worktreeEnabled: false }, local, node, async () => { throw new Error('gone') })
    expect(failing).toMatchObject({ projectId: undefined, node, localProjectId: 'a' })
  })

  it('restores the project the draft had here when this computer is picked again', async () => {
    platform({ [node]: 'remote-a' })
    const away = await workspaceOnDevice({ projectId: 'a', worktreeEnabled: true }, local, node, async () => identity)
    const back = await workspaceOnDevice(away, local, undefined)
    expect(back).toEqual({ projectId: 'a', worktreeEnabled: true })
    // A project that was removed meanwhile does not come back.
    expect(await workspaceOnDevice(away, local.slice(1), undefined)).toEqual({ projectId: undefined, worktreeEnabled: false })
    // Nothing remembered, nothing restored.
    expect(await workspaceOnDevice({ projectId: 'remote-x', worktreeEnabled: false, node }, local, undefined))
      .toEqual({ projectId: undefined, worktreeEnabled: false })
  })

  it('matches from the remembered local project when going from one computer to another', async () => {
    const requests = platform({ [node]: 'remote-a', [other]: undefined })
    const first = await workspaceOnDevice({ projectId: 'a', worktreeEnabled: false }, local, node, async () => identity)
    const second = await workspaceOnDevice(first, local, other, async (id) => { expect(id).toBe('a'); return identity })
    expect(second).toEqual({ projectId: undefined, worktreeEnabled: false, node: other, localProjectId: 'a' })
    expect(requests.map(([, params]) => params.target)).toEqual([node, other])
    // Without a remembered local project, the next computer starts empty.
    const lost = await workspaceOnDevice({ projectId: 'remote-a', worktreeEnabled: false, node }, local, other, async () => identity)
    expect(lost).toEqual({ projectId: undefined, worktreeEnabled: false, node: other })
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
    expect(localWorkspaceFor({ projectId: 'y', worktreeEnabled: true, node }, undefined)).toEqual({ worktreeEnabled: false })
    expect(localWorkspaceFor({ projectId: 'a', worktreeEnabled: true }, undefined)).toEqual({ projectId: 'a', worktreeEnabled: true })
    expect(localWorkspaceFor(undefined, thread({ projectId: 'q' }))).toEqual({ projectId: 'q', worktreeEnabled: false })
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

  it('lists this computer first and every connected computer as pickable', () => {
    const { runOn } = buildDeviceMenu({ localName: 'Mac', devices: [device({ name: 'Studio' })], workspace })
    expect(runOn).toEqual([
      { id: 'local', name: 'Mac', active: true, disabled: false },
      { id: 'node-1', name: 'Studio', active: false, disabled: false }
    ])
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

describe('device menu stylesheet', () => {
  it('keeps the menu free of transitions, so focus can move in once it is positioned', () => {
    const css = readFileSync(resolve(__dirname, '../src/renderer/components/sideCard/deviceSection.css'), 'utf8')
    const start = css.indexOf('.side-card-device-menu {')
    expect(start).toBeGreaterThan(-1)
    expect(css.slice(start, css.indexOf('}', start))).toMatch(/transition:\s*none/)
  })
})
