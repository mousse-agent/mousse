import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DownloadsIndicator, DownloadsList, shortUpdateError } from '../src/renderer/components/downloads/DownloadsIndicator'
import {
  applyProviderOffers,
  applyProviderOperation,
  applyUpdateState,
  downloadsActions,
  providerUpdateOffers,
  receiveProviderOffers,
  receiveProviderOperation,
  resetDownloadsStore,
  summarizeDownloads,
  useDownloadsStore,
  type DownloadEntry
} from '../src/renderer/stores/downloadsStore'
import { useUpdateStore } from '../src/renderer/stores/updateStore'
import type { InstanceSnapshot, UpdateAffordance } from '../src/shared/harness/status'
import type { ProviderOperationEvent } from '../src/shared/harness/types'
import type { UpdateState } from '../src/shared/updates'

const appState = (patch: Partial<UpdateState>): UpdateState => ({
  phase: 'idle', currentVersion: '1.0.0', channel: 'stable', releaseNotes: [], omittedReleaseCount: 0, ...patch
})

function snapshot(instanceId: string, patch: { driver?: InstanceSnapshot['driver']; displayName?: string; version?: string; path?: string; update?: UpdateAffordance; enabled?: boolean; builtIn?: boolean }): InstanceSnapshot {
  return {
    instanceId,
    driver: patch.driver ?? 'claude',
    displayName: patch.displayName ?? 'Claude Code',
    builtIn: patch.builtIn ?? true,
    enabled: { device: patch.enabled ?? true, effective: patch.enabled ?? true, setBy: 'device' },
    binary: { path: patch.path ?? `/bin/${instanceId}`, version: patch.version ?? '2.1.300', source: 'path' },
    ...(patch.update ? { update: patch.update } : {})
  } as InstanceSnapshot
}

const claudeUpdate = snapshot('claude', { update: { kind: 'advisory', command: 'claude update', latestVersion: '2.1.320' } })
const codexUpdate = snapshot('codex', {
  driver: 'codex', displayName: 'Codex', version: '0.160.0', update: { kind: 'advisory', command: 'npm install -g @openai/codex@latest', latestVersion: '0.170.0', untested: true }
})

// Server rendering reads a store's initial state, so the seed goes there too.
const seed = (entries: DownloadEntry[]) => {
  useDownloadsStore.setState({ entries })
  Object.assign(useDownloadsStore.getInitialState(), { entries })
}
const list = (entries: DownloadEntry[]) => renderToStaticMarkup(createElement(DownloadsList, {
  entries, notesOpen: false, onToggleNotes: () => undefined, onInstall: () => undefined, onOpen: () => undefined
}))
const text = (html: string) => html.replace(/<[^>]+>/g, '|')
const op = (patch: Partial<ProviderOperationEvent> & Pick<ProviderOperationEvent, 'phase'>): ProviderOperationEvent =>
  ({ operationId: 'op-1', instanceId: 'claude', kind: 'update', ...patch }) as ProviderOperationEvent

afterEach(() => {
  seed([])
  resetDownloadsStore()
  useUpdateStore.setState(appState({}), true)
  vi.unstubAllGlobals()
})

describe('agent updates offered from the snapshots', () => {
  it('offers one row per CLI on this computer, with the versions, the tested note and manual updates', () => {
    const offers = providerUpdateOffers([
      claudeUpdate,
      // Another entry on the same executable shares its row.
      snapshot('claude:api', { displayName: 'Claude Code (API key)', builtIn: false, path: '/bin/claude', update: { kind: 'advisory', command: 'claude update', latestVersion: '2.1.320' } }),
      codexUpdate,
      snapshot('grok', { driver: 'grok', displayName: 'Grok', enabled: false, update: { kind: 'notice', latestVersion: '1.0.0' } }),
      snapshot('cursor', { driver: 'cursor', displayName: 'Cursor' }),
      snapshot('gemini', { driver: 'acp', displayName: 'Gemini', update: { kind: 'advisory', command: 'npm install -g gemini@latest', latestVersion: '1.2.0', manual: true } })
    ])
    expect(offers).toEqual([
      { instanceId: 'claude', driver: 'claude', label: 'Claude Code', fromVersion: '2.1.300', toVersion: '2.1.320', untested: false, manual: false },
      { instanceId: 'codex', driver: 'codex', label: 'Codex', fromVersion: '0.160.0', toVersion: '0.170.0', untested: true, manual: false },
      { instanceId: 'gemini', driver: 'acp', label: 'Gemini', fromVersion: '2.1.300', toVersion: '1.2.0', untested: false, manual: true, command: 'npm install -g gemini@latest' }
    ])
  })

  it('shows the update dot when only an agent has an update', () => {
    receiveProviderOffers(providerUpdateOffers([claudeUpdate]))
    seed(useDownloadsStore.getState().entries)
    const rail = renderToStaticMarkup(createElement(DownloadsIndicator, { variant: 'rail' }))
    expect(rail).toMatch(/class="downloads-dot"/)
    expect(rail).toContain('aria-label="Update available"')
    expect(summarizeDownloads(applyProviderOffers([], providerUpdateOffers([claudeUpdate, codexUpdate]))).label).toBe('2 updates available')
  })

  it('lists the app and each agent with current → new, the untested note and Update all', () => {
    let entries = applyUpdateState([], appState({ phase: 'available', availableVersion: '1.1.0' }))
    entries = applyProviderOffers(entries, providerUpdateOffers([claudeUpdate, codexUpdate]))
    expect(entries.map((entry) => entry.id)).toEqual(['update', 'agent:claude', 'agent:codex'])
    const html = list(entries)
    const plain = text(html)
    expect(plain).toContain('|Mousse||v1.0.0 → v1.1.0|')
    expect(plain).toContain('|Claude Code||v2.1.300 → v2.1.320|')
    expect(plain).toContain('|Codex||v0.160.0 → v0.170.0||Not yet tested with Mousse|')
    expect(html).toContain('aria-label="Update Claude Code · applies to new runs"')
    expect(html).toMatch(/<button[^>]*class="downloads-btn"[^>]*>Update all</)
  })

  it('shows a manual update with its command to copy and no Update button', () => {
    const entries = applyProviderOffers([], providerUpdateOffers([
      snapshot('codex', { driver: 'codex', displayName: 'Codex', update: { kind: 'advisory', command: 'npm install -g @openai/codex@latest', latestVersion: '0.170.0', manual: true } })
    ]))
    const html = list(entries)
    expect(text(html)).toContain('|Update manually|')
    expect(html).toContain('<code title="npm install -g @openai/codex@latest">npm install -g @openai/codex@latest</code>')
    expect(html).not.toContain('aria-label="Update Codex')
    expect(html).not.toContain('Update all')
  })
})

describe('an agent update in its row', () => {
  it('shows progress, then success that applies to new runs', () => {
    let entries = applyProviderOffers([], providerUpdateOffers([claudeUpdate]))
    entries = applyProviderOperation(entries, op({ phase: 'progress', message: 'Running claude update' }), 'Claude Code', 1)
    expect(entries).toMatchObject([{ id: 'agent:claude', phase: 'downloading', operation: 'update', toVersion: '2.1.320' }])
    expect(text(list(entries))).toContain('|Updating…|')
    expect(summarizeDownloads(entries).label).toBe('Updating…')
    entries = applyProviderOperation(entries, op({ phase: 'completed' }), 'Claude Code', 2)
    expect(text(list(entries))).toContain('|Updated · applies to new runs|')
    expect(list(entries)).not.toContain('Open Speech settings')
    // The snapshot taken before the new version is read still offers it: the finished row stays.
    expect(applyProviderOffers(entries, providerUpdateOffers([claudeUpdate]))).toMatchObject([{ phase: 'done' }])
  })

  it('shows a failure in its row with Retry, and Retry runs the update again', async () => {
    let entries = applyProviderOffers([], providerUpdateOffers([claudeUpdate]))
    entries = applyProviderOperation(entries, op({ phase: 'failed', error: { code: 'protocol', message: 'claude update failed (exit 1): network unreachable', instanceId: 'claude' } }), 'Claude Code', 1)
    // Still offered: the failure stays.
    entries = applyProviderOffers(entries, providerUpdateOffers([claudeUpdate]))
    const html = list(entries)
    expect(html).toMatch(/class="downloads-row-detail downloads-bad" role="alert">Update failed: network unreachable</)
    expect(html).toContain('title="claude update failed (exit 1): network unreachable"')
    expect(shortUpdateError('npm install -g @openai/codex@latest failed (exit 1): npm ERR! code ECONNRESET\nnpm ERR! network request to https://registry.npmjs.org/x failed'))
      .toBe('network request to https://registry.npmjs.org/x failed')
    expect(html).toContain('aria-label="Try again"')

    const update = vi.fn(async () => ({ operationId: 'op-2', instanceId: 'claude', kind: 'update' }))
    vi.stubGlobal('window', { mousse: { providers: { instances: { update, install: vi.fn() } } } })
    seed(entries)
    downloadsActions.retry(useDownloadsStore.getState().entries[0])
    expect(useDownloadsStore.getState().entries[0]).toMatchObject({ phase: 'queued', error: undefined })
    await vi.waitFor(() => expect(update).toHaveBeenCalledWith('claude'))
  })

  it('a refused update fails its row with the reason', async () => {
    const update = vi.fn(async () => { throw new Error("Error invoking remote method 'providers:instances:update': Error: Updating needs administrator rights.") })
    vi.stubGlobal('window', { mousse: { providers: { instances: { update } } } })
    receiveProviderOffers(providerUpdateOffers([claudeUpdate]))
    await downloadsActions.updateAgent(useDownloadsStore.getState().entries[0])
    expect(useDownloadsStore.getState().entries[0]).toMatchObject({ phase: 'failed', error: 'Updating needs administrator rights.' })
  })
})

describe('Update all', () => {
  it('starts the app download and updates every agent one after another', async () => {
    const calls: string[] = []
    let n = 0
    const update = vi.fn(async (instanceId: string) => {
      calls.push(`start ${instanceId}`)
      const operationId = `op-${++n}`
      setTimeout(() => {
        calls.push(`end ${instanceId}`)
        receiveProviderOperation({ operationId, instanceId, kind: 'update', phase: 'completed' })
      }, 5)
      return { operationId, instanceId, kind: 'update' as const }
    })
    const download = vi.fn(async () => appState({ phase: 'downloading', availableVersion: '1.1.0' }))
    vi.stubGlobal('window', { mousse: { providers: { instances: { update } }, updates: { download } } })
    useUpdateStore.setState(appState({ phase: 'available', availableVersion: '1.1.0' }), true)
    receiveProviderOffers(providerUpdateOffers([claudeUpdate, codexUpdate]))
    const running = downloadsActions.updateAll()
    expect(download).toHaveBeenCalledTimes(1)
    expect(useDownloadsStore.getState().entries.map((entry) => entry.phase)).toEqual(['queued', 'queued'])
    await running
    expect(calls).toEqual(['start claude', 'end claude', 'start codex', 'end codex'])
    expect(useDownloadsStore.getState().entries.map((entry) => entry.phase)).toEqual(['done', 'done'])
  })
})
