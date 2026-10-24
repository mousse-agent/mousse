import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import { DownloadsIndicator, DownloadsList } from '../src/renderer/components/downloads/DownloadsIndicator'
import { applyLocalModelStatus, applyUpdateState, resetDownloadsStore, useDownloadsStore, type DownloadEntry } from '../src/renderer/stores/downloadsStore'
import { useUpdateStore } from '../src/renderer/stores/updateStore'
import type { UpdateState } from '../src/shared/updates'

const update = (patch: Partial<UpdateState>): UpdateState => ({
  phase: 'idle', currentVersion: '1.0.0', channel: 'stable', releaseNotes: [], omittedReleaseCount: 0, ...patch
})

// Server rendering reads a store's initial state, so the seed goes there too.
const seed = (entries: DownloadEntry[]) => {
  useDownloadsStore.setState({ entries })
  Object.assign(useDownloadsStore.getInitialState(), { entries })
}
const indicator = (variant: 'rail' | 'nav') => renderToStaticMarkup(createElement(DownloadsIndicator, { variant }))
const list = (entries: DownloadEntry[]) => renderToStaticMarkup(createElement(DownloadsList, {
  entries, notesOpen: false, onToggleNotes: () => undefined, onInstall: () => undefined, onOpen: () => undefined
}))
const text = (html: string) => html.replace(/<[^>]+>/g, '|')

const twoModels = () => {
  let entries = applyLocalModelStatus([], 'dictation-model', 'Moonshine Base', { modelId: 'moonshine-base', state: { status: 'downloading', receivedBytes: 57_000_000, totalBytes: 136_000_000 } }, 1)
  entries = applyLocalModelStatus(entries, 'voice-model', 'Kokoro 82M', { modelId: 'kokoro-82m', state: { status: 'downloading', receivedBytes: 0, totalBytes: 100_000_000 } }, 1)
  return entries
}

describe('downloads indicator rendering', () => {
  afterEach(() => {
    seed([])
    resetDownloadsStore()
    useUpdateStore.setState(update({}), true)
  })

  it('renders nothing when there is nothing to show', () => {
    expect(indicator('rail')).toBe('')
    expect(indicator('nav')).toBe('')
  })

  it('shows a ring and a count in the rail and a short label in the Settings nav', () => {
    seed(twoModels())
    const rail = indicator('rail')
    expect(rail).toContain('navigation-rail-button downloads-rail')
    expect(rail).toContain('downloads-ring')
    expect(rail).toMatch(/class="downloads-count"[^>]*>2</)
    expect(rail).toContain('aria-label="Downloading 2 · 24%"')

    const nav = indicator('nav')
    expect(nav).toContain('downloads-nav-slot')
    expect(nav).not.toContain('downloads-count')
    expect(text(nav)).toContain('|Downloading 2 · 24%|')
  })

  it('keeps showing an available or ready update the way the rail did', () => {
    seed(applyUpdateState([], update({ phase: 'available', availableVersion: '1.1.0' })))
    expect(indicator('rail')).toMatch(/class="downloads-dot"/)
    seed(applyUpdateState([], update({ phase: 'downloaded', availableVersion: '1.1.0' })))
    expect(indicator('rail')).toContain('downloads-dot ready')
    expect(text(indicator('nav'))).toContain('|Restart to update|')
  })

  it('lists each download with its progress and icon-only actions', () => {
    const html = list(twoModels())
    const plain = text(html)
    expect(plain).toContain('|Moonshine Base|')
    expect(plain).toContain('|41% · 57 of 136 MB|')
    expect(html).toContain('aria-label="Cancel download"')
    expect(html).toContain('title="Cancel download"')
    expect(html).toContain('role="progressbar"')
  })

  it('offers retry and dismiss for a failure, and the restart for a downloaded update', () => {
    let entries = applyLocalModelStatus([], 'dictation-model', 'Parakeet TDT 110M', { modelId: 'parakeet-tdt-110m', state: { status: 'error', message: 'Download failed with HTTP 503' } }, 1)
    entries = applyUpdateState(entries, update({ phase: 'downloaded', availableVersion: '1.1.0' }))
    const html = list(entries)
    expect(text(html)).toContain('|Mousse 1.1.0|')
    expect(text(html)).toContain('|Ready to install|')
    expect(html).toMatch(/<button[^>]*class="downloads-btn"[^>]*>Restart to update</)
    expect(html).toContain('aria-label="Try again"')
    expect(html).toContain('aria-label="Dismiss"')
    expect(html).toMatch(/class="downloads-row-detail downloads-bad" role="alert">Download failed with HTTP 503/)
  })
})
