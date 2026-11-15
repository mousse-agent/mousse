import { describe, expect, it } from 'vitest'
import { NO_LOADED_BROWSER_TABS, nextLoadedBrowserTabs, type LoadedBrowserTabs, type LoadedBrowserTabsInput } from '../../src/renderer/lib/loadedBrowserTabs'

const tabIds = ['t1', 't2', 't3', 't4', 't5', 't6']
const input = (patch: Partial<LoadedBrowserTabsInput> = {}): LoadedBrowserTabsInput =>
  ({ tabIds, shown: true, openedThisSession: new Set(), busy: new Set(), ...patch })
/** Shows each tab in turn, as a person clicking through the tab strip. */
const showInTurn = (ids: string[], start: LoadedBrowserTabs = NO_LOADED_BROWSER_TABS, patch: Partial<LoadedBrowserTabsInput> = {}) =>
  ids.reduce((state, activeTabId) => nextLoadedBrowserTabs(state, input({ ...patch, activeTabId })), start)
const loaded = (state: LoadedBrowserTabs) => [...state.loaded].sort()

describe('which browser tabs keep their page', () => {
  it.each([
    { case: 'the tab on screen and the three used before it', shown: ['t1', 't2', 't3', 't4', 't5', 't6'], busy: [], keep: ['t3', 't4', 't5', 't6'] },
    { case: 'going back to a tab makes it recent again', shown: ['t1', 't2', 't3', 't4', 't1', 't5'], busy: [], keep: ['t1', 't3', 't4', 't5'] },
    { case: 'a busy tab (agent or media) however old', shown: ['t1', 't2', 't3', 't4', 't5', 't6'], busy: ['t1'], keep: ['t1', 't3', 't4', 't5', 't6'] },
    { case: 'a closed tab is forgotten', shown: ['t1', 't2', 't9'], busy: ['t8'], keep: ['t1', 't2'] }
  ])('keeps $case', ({ shown, busy, keep }) => {
    expect(loaded(showInTurn(shown, NO_LOADED_BROWSER_TABS, { busy: new Set(busy) }))).toEqual(keep)
  })

  it('loads a restored tab only once it is shown, and keeps it when the browser hides', () => {
    const hidden = nextLoadedBrowserTabs(NO_LOADED_BROWSER_TABS, input({ activeTabId: 't1', shown: false }))
    expect(loaded(hidden)).toEqual([])
    const seen = nextLoadedBrowserTabs(hidden, input({ activeTabId: 't1' }))
    expect(loaded(nextLoadedBrowserTabs(seen, input({ activeTabId: 't1', shown: false })))).toEqual(['t1'])
  })

  it('loads a tab opened in this session at once, even out of sight, and counts it as used', () => {
    const start = showInTurn(['t1', 't2', 't3'])
    const opened = nextLoadedBrowserTabs(start, input({ activeTabId: 't3', shown: false, openedThisSession: new Set(['t6']) }))
    expect(loaded(opened)).toEqual(['t1', 't2', 't3', 't6'])
    // The newly opened tab pushed out the oldest one once another tab is shown.
    expect(loaded(nextLoadedBrowserTabs(opened, input({ activeTabId: 't4', openedThisSession: new Set(['t6']) })))).toEqual(['t2', 't3', 't4', 't6'])
  })

  it('gives the same answer when run again on the same input', () => {
    const state = showInTurn(['t1', 't2', 't3', 't4', 't5'])
    const again = nextLoadedBrowserTabs(state, input({ activeTabId: 't5', openedThisSession: new Set(['t6']) }))
    expect(nextLoadedBrowserTabs(again, input({ activeTabId: 't5', openedThisSession: new Set(['t6']) }))).toEqual(again)
  })
})
