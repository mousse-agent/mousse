import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import { SideCardSections, ThreadSideCard } from '../src/renderer/components/sideCard/ThreadSideCard'
import {
  SIDE_CARD_CLEARANCE_WIDTH,
  SIDE_CARD_MIN_THREAD_WIDTH,
  deriveSideCardState,
  nextSideCardToggleState,
  sideCardButtonTitle,
  sideCardFitsThreadWidth,
  sideCardReservedWidth,
  threadViewWidth,
  threadsSidebarReservedWidth,
  type SideCardVisibilityInput
} from '../src/renderer/components/sideCard/sideCardLogic'
import { shouldCloseSideCardOverlay, useAppStore } from '../src/renderer/stores/appStore'

const open: SideCardVisibilityInput = {
  sideCardOn: true,
  mainAreaOpen: false,
  settingsOpen: false,
  usageOpen: false,
  scheduledOpen: false,
  channelsOpen: false,
  sidebarMode: 'projects',
  sideCardOverlayOpen: false,
  sideCardFits: true
}

const visible = (input: SideCardVisibilityInput) => deriveSideCardState(input).visible

describe('side card visibility', () => {
  it('shows over a full-width thread view when switched on', () => {
    expect(visible(open)).toBe(true)
  })

  it.each<[string, Partial<SideCardVisibilityInput>]>([
    ['switched off', { sideCardOn: false }],
    ['the app panel is open', { mainAreaOpen: true }],
    ['Settings is open', { settingsOpen: true }],
    ['Usage is open', { usageOpen: true }],
    ['Scheduled is open', { scheduledOpen: true }],
    ['Channels is open', { channelsOpen: true }],
    ['the Chats view is showing', { sidebarMode: 'chats' }],
    ['the thread area is too narrow and the overlay is closed', { sideCardFits: false }],
    ['the width is not measured yet', { sideCardFits: null }]
  ])('hides when %s', (_name, patch) => {
    expect(visible({ ...open, ...patch })).toBe(false)
  })

  it('needs a thread area of at least the minimum width', () => {
    expect(sideCardFitsThreadWidth(SIDE_CARD_MIN_THREAD_WIDTH)).toBe(true)
    expect(sideCardFitsThreadWidth(SIDE_CARD_MIN_THREAD_WIDTH - 1)).toBe(false)
  })

  it('is on at launch, with the width unmeasured and the overlay closed', () => {
    expect(useAppStore.getInitialState().sideCardOn).toBe(true)
    expect(useAppStore.getInitialState().sideCardFits).toBeNull()
    expect(useAppStore.getInitialState().sideCardOverlayOpen).toBe(false)
  })
})

describe('side card overlay in a narrow window', () => {
  const narrow: SideCardVisibilityInput = { ...open, sideCardFits: false }

  it('is the mode when the thread area does not fit, and docked otherwise', () => {
    expect(deriveSideCardState(narrow).mode).toBe('overlay')
    expect(deriveSideCardState(open).mode).toBe('docked')
    // Unmeasured is docked: nothing shows until the first measurement.
    expect(deriveSideCardState({ ...open, sideCardFits: null }).mode).toBe('docked')
  })

  it('shows only while the overlay is open, whatever the switch says', () => {
    expect(visible(narrow)).toBe(false)
    expect(visible({ ...narrow, sideCardOverlayOpen: true })).toBe(true)
    expect(visible({ ...narrow, sideCardOverlayOpen: true, sideCardOn: false })).toBe(true)
  })

  it('never opens by itself, so a narrow launch shows no card', () => {
    // The switch is on at launch; in a narrow window it does not open the overlay.
    expect(deriveSideCardState({ ...narrow, sideCardOn: true })).toEqual({ visible: false, mode: 'overlay', unavailable: null })
  })

  it('does not show while the app panel is open or over a view without a thread', () => {
    expect(visible({ ...narrow, sideCardOverlayOpen: true, mainAreaOpen: true })).toBe(false)
    expect(visible({ ...narrow, sideCardOverlayOpen: true, settingsOpen: true })).toBe(false)
  })

  it('ignores a stale overlay flag once the card docks', () => {
    expect(visible({ ...open, sideCardOn: false, sideCardOverlayOpen: true })).toBe(false)
    expect(visible({ ...open, sideCardOn: true, sideCardOverlayOpen: true })).toBe(true)
  })
})

describe('overlay lifetime', () => {
  const base = { ...useAppStore.getInitialState(), sideCardFits: false, sideCardOverlayOpen: true, activeThreadId: 'thread-1' }
  const closes = (patch: Partial<typeof base>) => shouldCloseSideCardOverlay({ ...base, ...patch }, base)

  it('stays open while nothing changes', () => {
    expect(closes({})).toBe(false)
  })

  it('has nothing to close when it is not open', () => {
    expect(closes({ sideCardOverlayOpen: false, mainAreaOpen: true })).toBe(false)
  })

  it('closes when the window widens enough to dock the card', () => {
    expect(closes({ sideCardFits: true })).toBe(true)
  })

  it('closes on a thread change and when the app panel opens', () => {
    expect(closes({ activeThreadId: 'thread-2' })).toBe(true)
    expect(closes({ mainAreaOpen: true })).toBe(true)
  })

  it('closes when a view without a thread replaces the conversation', () => {
    expect(closes({ settingsOpen: true })).toBe(true)
    expect(closes({ sidebarMode: 'chats' })).toBe(true)
  })

  it('is cleared in the live store, leaving the switch on so the card docks', () => {
    const store = useAppStore
    store.setState({ sideCardOn: true, sideCardFits: false, sideCardOverlayOpen: true, mainAreaOpen: false, activeThreadId: 'thread-1' })
    store.getState().setSideCardFits(true)
    expect(store.getState().sideCardOverlayOpen).toBe(false)
    expect(store.getState().sideCardOn).toBe(true)
    expect(deriveSideCardState(store.getState())).toEqual({ visible: true, mode: 'docked', unavailable: null })
    store.setState({ sideCardFits: false, sideCardOverlayOpen: true })
    store.getState().setMainAreaOpen(true)
    expect(store.getState().sideCardOverlayOpen).toBe(false)
    store.setState({ sideCardFits: null, mainAreaOpen: false, activeThreadId: null })
  })
})

describe('reserved width beside the docked card', () => {
  it('is nothing once the thread area leaves the card its own gutter', () => {
    expect(sideCardReservedWidth(SIDE_CARD_CLEARANCE_WIDTH)).toBe(0)
    expect(sideCardReservedWidth(1600)).toBe(0)
  })

  it('grows as the area narrows, up to the card width at the docking limit', () => {
    expect(sideCardReservedWidth(1200)).toBe(72)
    expect(sideCardReservedWidth(SIDE_CARD_MIN_THREAD_WIDTH)).toBe(272)
  })
})

describe('thread view width', () => {
  it('is the workspace less the open threads sidebar and its resizer', () => {
    const reserved = threadsSidebarReservedWidth(true, 260)
    expect(reserved).toBe(261)
    expect(threadViewWidth(1400, reserved)).toBe(1139)
  })

  it('takes the whole workspace when the threads sidebar is closed', () => {
    expect(threadsSidebarReservedWidth(false, 260)).toBe(0)
    expect(threadViewWidth(1200, 0)).toBe(1200)
  })

  it('decides fit from the full width, whatever the app panel does to the aside', () => {
    // A 1400px workspace with the sidebar open leaves a thread view that fits,
    // even though opening the app panel would narrow the aside well below the minimum.
    const width = threadViewWidth(1400, threadsSidebarReservedWidth(true, 260))
    expect(width).not.toBeNull()
    expect(sideCardFitsThreadWidth(width as number)).toBe(true)
    // The same window with a wider sidebar no longer fits.
    expect(sideCardFitsThreadWidth(threadViewWidth(1200, threadsSidebarReservedWidth(true, 260)) as number)).toBe(false)
  })

  it('says nothing for a hidden workspace or when nothing is left beside the sidebar', () => {
    expect(threadViewWidth(0, 0)).toBeNull()
    expect(threadViewWidth(0, 261)).toBeNull()
    expect(threadViewWidth(200, 261)).toBeNull()
  })
})

describe('title-bar button availability', () => {
  it('works, and is pressed only when the card is visible', () => {
    expect(deriveSideCardState(open)).toEqual({ visible: true, mode: 'docked', unavailable: null })
    expect(deriveSideCardState({ ...open, sideCardOn: false })).toEqual({ visible: false, mode: 'docked', unavailable: null })
  })

  it('stays enabled while the app panel is open so a click can swap it for the card', () => {
    expect(deriveSideCardState({ ...open, mainAreaOpen: true })).toEqual({ visible: false, mode: 'docked', unavailable: null })
    expect(deriveSideCardState({ ...open, mainAreaOpen: true, sideCardOn: false })).toEqual({ visible: false, mode: 'docked', unavailable: null })
  })

  it.each<[string, Partial<SideCardVisibilityInput>]>([
    ['Settings', { settingsOpen: true }],
    ['Usage', { usageOpen: true }],
    ['Scheduled', { scheduledOpen: true }],
    ['Channels', { channelsOpen: true }],
    ['Chats', { sidebarMode: 'chats' }]
  ])('is disabled over %s, even with the card switched on', (_name, patch) => {
    expect(deriveSideCardState({ ...open, ...patch })).toEqual({ visible: false, mode: 'docked', unavailable: 'view' })
  })

  it('is never disabled for width: a narrow window opens the overlay', () => {
    for (const patch of [{}, { mainAreaOpen: true }, { sideCardOn: false }, { sideCardOverlayOpen: true }]) {
      expect(deriveSideCardState({ ...open, ...patch, sideCardFits: false }).unavailable).toBeNull()
    }
  })

  it('names the view when both apply', () => {
    expect(deriveSideCardState({ ...open, settingsOpen: true, sideCardFits: false })).toEqual({ visible: false, mode: 'overlay', unavailable: 'view' })
  })

  it('stays enabled while the width is unmeasured', () => {
    // At launch the width is unmeasured, with the app panel open or not.
    for (const patch of [{}, { mainAreaOpen: true }, { sideCardOn: false }]) {
      expect(deriveSideCardState({ ...open, ...patch, sideCardFits: null })).toEqual({ visible: false, mode: 'docked', unavailable: null })
    }
    // A wide measurement taken with the app panel open keeps the button usable.
    expect(deriveSideCardState({ ...open, mainAreaOpen: true, sideCardFits: true }).unavailable).toBeNull()
  })

  it('still names the view first while unmeasured', () => {
    expect(deriveSideCardState({ ...open, settingsOpen: true, sideCardFits: null }).unavailable).toBe('view')
  })

  it('explains a disabled button in its tooltip and otherwise just names it', () => {
    expect(sideCardButtonTitle('view')).toMatch(/thread/i)
    expect(sideCardButtonTitle(null)).toBe('Thread details')
  })
})

describe('title-bar button click', () => {
  const off = { sideCardOn: false, mainAreaOpen: false, sideCardOverlayOpen: false }

  it('closes the app panel and turns the card on when it is not showing', () => {
    expect(nextSideCardToggleState(false, { ...off, mainAreaOpen: true })).toEqual({ sideCardOn: true, mainAreaOpen: false, sideCardOverlayOpen: false })
    expect(nextSideCardToggleState(false, { ...off, sideCardOn: true, mainAreaOpen: true })).toEqual({ sideCardOn: true, mainAreaOpen: false, sideCardOverlayOpen: false })
  })

  it('turns the card on without touching a closed app panel', () => {
    expect(nextSideCardToggleState(false, off)).toEqual({ sideCardOn: true, mainAreaOpen: false, sideCardOverlayOpen: false })
  })

  it('switches the card off when it is showing', () => {
    expect(nextSideCardToggleState(true, { ...off, sideCardOn: true })).toEqual({ sideCardOn: false, mainAreaOpen: false, sideCardOverlayOpen: false })
  })

  it('opens the overlay in a narrow window, closing the app panel and leaving the switch alone', () => {
    expect(nextSideCardToggleState(false, { sideCardOn: true, mainAreaOpen: true, sideCardOverlayOpen: false }, 'overlay'))
      .toEqual({ sideCardOn: true, mainAreaOpen: false, sideCardOverlayOpen: true })
    expect(nextSideCardToggleState(false, { ...off, sideCardOn: false }, 'overlay'))
      .toEqual({ sideCardOn: false, mainAreaOpen: false, sideCardOverlayOpen: true })
  })

  it('closes the overlay when it is showing, so the card docks again once the window widens', () => {
    expect(nextSideCardToggleState(true, { sideCardOn: true, mainAreaOpen: false, sideCardOverlayOpen: true }, 'overlay'))
      .toEqual({ sideCardOn: true, mainAreaOpen: false, sideCardOverlayOpen: false })
  })
})

describe('thread side card rendering', () => {
  const initial = useAppStore.getInitialState()
  // Server rendering reads a store's initial state, so seed it there as well.
  const seed = (patch: Partial<typeof initial>) => {
    useAppStore.setState(patch)
    Object.assign(initial, patch)
  }
  const reset = {
    sideCardOn: true,
    sideCardFits: null as boolean | null,
    sideCardOverlayOpen: false,
    mainAreaOpen: false,
    settingsOpen: false,
    sidebarMode: 'projects' as const,
    activeThreadId: null
  }
  const render = () => renderToStaticMarkup(createElement(ThreadSideCard))

  afterEach(() => seed(reset))

  it('renders the four sections in order', () => {
    seed({ activeThreadId: 'thread-1' })
    const html = renderToStaticMarkup(createElement(SideCardSections, { threadId: 'thread-1', projectId: null }))
    const titles = [...html.matchAll(/side-card-section-title">([^<]+)</g)].map((match) => match[1])
    // Without a project folder Git collapses to one quiet line between Device and Actions (after Permissions), and
    // without subagents Lineage collapses to one quiet line at the end; neither keeps its heading.
    expect(titles).toEqual(['Device', 'Permissions', 'Actions'])
    expect(html.indexOf('lineage-collapsed')).toBeGreaterThan(html.indexOf('>Actions<'))
    expect(html.indexOf('side-card-git-collapsed')).toBeGreaterThan(html.indexOf('>Device<'))
    expect(html.indexOf('side-card-git-collapsed')).toBeLessThan(html.indexOf('>Actions<'))
    expect(html).toContain('data-thread-id="thread-1"')
  })

  it('renders no card until the width is measured, so a narrow window never flashes it', () => {
    seed({ activeThreadId: 'thread-1' })
    expect(render()).not.toContain('thread-side-card"')
    seed({ sideCardFits: false })
    expect(render()).not.toContain('thread-side-card"')
  })

  it('renders no card in a narrow window until the overlay is opened, even with the card switched on', () => {
    seed({ activeThreadId: 'thread-1', sideCardFits: false, sideCardOn: true })
    const closed = render()
    expect(closed).not.toContain('thread-side-card"')
    expect(closed).toContain('thread-side-card-layer--overlay')
  })

  it('renders the overlay with its scrim and dialog role once opened', () => {
    seed({ activeThreadId: 'thread-1', sideCardFits: false, sideCardOverlayOpen: true })
    const html = render()
    expect(html).toContain('thread-side-card-layer--overlay')
    expect(html).toContain('thread-side-card-scrim')
    expect(html).toContain('role="dialog"')
    expect(html).toContain('aria-label="Thread details"')
  })

  it('renders the docked card without a scrim or dialog role', () => {
    seed({ activeThreadId: 'thread-1', sideCardFits: true })
    const html = render()
    expect(html).not.toContain('thread-side-card-scrim')
    expect(html).not.toContain('role="dialog"')
    expect(html).not.toContain('thread-side-card-layer--overlay')
  })

  it('renders the card once the thread area is known to fit', () => {
    seed({ activeThreadId: 'thread-1', sideCardFits: true })
    const html = render()
    expect(html).toContain('aria-label="Thread details"')
    expect(html).toContain('data-shown="true"')
  })

  it('renders no card while the app panel is open or the card is off', () => {
    seed({ sideCardFits: true, mainAreaOpen: true })
    expect(render()).not.toContain('thread-side-card"')
    seed({ mainAreaOpen: false, sideCardOn: false })
    expect(render()).not.toContain('thread-side-card"')
    seed({ sideCardOn: true, sideCardFits: false })
    expect(render()).not.toContain('thread-side-card"')
  })
})
