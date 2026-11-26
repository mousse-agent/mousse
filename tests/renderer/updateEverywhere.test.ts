// @vitest-environment jsdom
/**
 * Update everywhere, as the person uses it: the update button's list offers "Update everywhere · N computers" beside
 * "This computer only"; the confirmation names each computer with its version and state and the turns that will stop;
 * Install confirms with the turns it showed; the results stay in the list with a retry on a failed row until dismissed.
 * The window talks to its service only through the bridge, stubbed here.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UpdateState } from '../../src/shared/updates'
import type { Rollout, RolloutRow } from '../../src/shared/updateRollout'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { DownloadsIndicator } = await import('../../src/renderer/components/downloads/DownloadsIndicator')
const { applyUpdateState, receiveComputers, resetDownloadsStore, useDownloadsStore } = await import('../../src/renderer/stores/downloadsStore')
const { useUpdateStore } = await import('../../src/renderer/stores/updateStore')
const { useComputersStore, NO_COMPUTERS } = await import('../../src/renderer/lib/computers')
const { resetRolloutStore, readRollout } = await import('../../src/renderer/lib/updateRollout')
type Device = import('../../src/renderer/lib/netDevices').Device

const appState: UpdateState = { phase: 'downloaded', currentVersion: '0.9.2', availableVersion: '0.9.4', channel: 'stable', releaseNotes: [], omittedReleaseCount: 0 }
const laptop: Device = {
  node: 'laptop' as Device['node'], name: 'Laptop', caps: [], keyEpoch: 1, expiresAt: 0, kind: 'computer', self: false, revoked: false,
  state: 'open', version: '0.9.3', update: { channel: 'stable', self: true, requests: true }
}
const planRows: RolloutRow[] = [
  { node: 'self', name: 'Studio', via: 'self', from: '0.9.2', phase: 'ready' },
  { node: 'laptop', name: 'Laptop', via: 'request', from: '0.9.3', phase: 'ready' },
  { node: 'desk', name: 'Desk', via: 'manual', from: '0.9.1', phase: 'manual', error: "Mousse isn't open there" }
]

let current: Rollout | null = null
let changed: ((change: { profileId?: string }) => void) | undefined
const calls: Array<[string, any]> = []
const request = vi.fn(async (method: string, params: any) => {
  calls.push([method, params])
  switch (method) {
    case 'updates.rollout.get':
      return { rollout: current, ...(params?.version ? { plan: planRows } : {}) }
    case 'updates.rollout.start':
      current = {
        id: 'r1', version: params.version, startedAt: 1, step: 'preparing',
        rows: [
          { ...planRows[0], runningTurns: 1 },
          { ...planRows[1], phase: 'downloading', percent: 40, runningTurns: 2 },
          planRows[2]
        ]
      }
      return { rollout: current }
    case 'updates.rollout.confirm':
      current = { ...current!, confirmedAt: 2, step: 'installing' }
      return { rollout: current }
    case 'updates.rollout.cancel':
      current = null
      return { rollout: null }
    case 'updates.rollout.retry':
      return { rollout: current }
    case 'updates.rollout.dismiss':
      current = null
      return { rollout: null }
    default:
      return {}
  }
})

let root: Root
let host: HTMLElement
beforeEach(() => {
  current = null
  calls.length = 0
  window.localStorage.clear()
  ;(window as unknown as { mousse: unknown }).mousse = {
    platformRequest: { request },
    updates: {
      getState: async () => appState,
      onState: () => () => undefined,
      onRolloutChanged: (cb: typeof changed) => {
        changed = cb
        return () => undefined
      }
    }
  }
  resetDownloadsStore()
  resetRolloutStore()
  useUpdateStore.setState(appState, true)
  useDownloadsStore.setState({ entries: applyUpdateState([], appState) })
  useComputersStore.setState({ loaded: true, routed: true, byNode: {}, devices: [laptop] })
  receiveComputers()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  document.body.innerHTML = ''
  useComputersStore.setState(NO_COMPUTERS)
})

const button = (name: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (item) => item.textContent?.trim() === name || item.getAttribute('aria-label') === name
  )
const click = async (name: string) => {
  const target = button(name)
  if (!target) throw new Error(`No button "${name}" in: ${document.body.textContent}`)
  await act(async () => target.click())
}
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]:not(.downloads-popover)')

describe('Update everywhere', () => {
  it('offers both choices, confirms with the turns it showed, and keeps the results until dismissed', async () => {
    await act(async () => root.render(createElement(DownloadsIndicator, { variant: 'nav' })))
    await click('Restart to update · 1 computer behind')
    // The list asked which computers it would reach; the one by hand is not counted.
    expect(calls).toContainEqual(['updates.rollout.get', { version: '0.9.4' }])
    expect(button('Update everywhere · 2 computers')).toBeDefined()
    // This computer's own step moved to the footer: one control, not two.
    expect(button('This computer only')).toBeDefined()
    expect(button('Restart to update')).toBeUndefined()

    await click('Update everywhere · 2 computers')
    // Opening the confirmation starts the downloads; nothing installs yet.
    expect(calls.map(([method]) => method)).toContain('updates.rollout.start')
    expect(calls.map(([method]) => method)).not.toContain('updates.rollout.confirm')
    const confirm = dialog()!
    expect(confirm.textContent).toContain('Update 2 computers to v0.9.4?')
    const rows = [...confirm.querySelectorAll('li')].map((row) => row.textContent)
    expect(rows).toEqual(['This computerv0.9.2Ready', 'Laptopv0.9.3Downloading 40%', 'Deskv0.9.1Update by hand'])
    expect(confirm.querySelectorAll('li')[2].getAttribute('title')).toBe("Mousse isn't open there")
    expect(confirm.textContent).toContain('3 running agent turns will be stopped')

    await click('Install')
    expect(calls.find(([method]) => method === 'updates.rollout.confirm')?.[1]).toEqual({ turns: { self: 1, laptop: 2 } })
    expect(dialog()).toBeNull()

    // The results: the laptop failed; a retry, then Dismiss once everything settled.
    current = {
      ...current!, step: 'done',
      rows: [
        { ...current!.rows[0], phase: 'updated' },
        { ...current!.rows[1], phase: 'failed', error: 'Needs Full control there' },
        current!.rows[2]
      ]
    }
    await act(async () => {
      changed?.({})
      await readRollout()
    })
    expect(document.body.textContent).toContain("1 computer didn't update")
    await click('Restart to update · 1 computer didn\'t update')
    const results = [...document.querySelectorAll('.downloads-rollout li')].map((row) => row.textContent)
    expect(results).toEqual(['This computerUpdated', 'LaptopFailed', 'DeskUpdate by hand'])
    await click('Try Laptop again')
    expect(calls).toContainEqual(['updates.rollout.retry', { node: 'laptop' }])
    await click('Dismiss')
    expect(calls.map(([method]) => method)).toContain('updates.rollout.dismiss')
  })

  it('cancelling the confirmation drops the downloads it started', async () => {
    await act(async () => root.render(createElement(DownloadsIndicator, { variant: 'nav' })))
    await click('Restart to update · 1 computer behind')
    await click('Update everywhere · 2 computers')
    await click('Cancel')
    expect(calls.map(([method]) => method)).toContain('updates.rollout.cancel')
    expect(calls.map(([method]) => method)).not.toContain('updates.rollout.confirm')
  })
})
