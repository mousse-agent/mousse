import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import { SideCardSections, ThreadSideCard } from '../src/renderer/components/sideCard/ThreadSideCard'
import {
  SIDE_CARD_MIN_THREAD_WIDTH,
  deriveSideCardState,
  isSideCardVisible,
  nextSideCardToggleState,
  sideCardButtonTitle,
  sideCardFitsThreadWidth,
  type SideCardVisibilityInput
} from '../src/renderer/components/sideCard/sideCardLogic'
import { useAppStore } from '../src/renderer/stores/appStore'

const open: SideCardVisibilityInput = {
  sideCardOn: true,
  mainAreaOpen: false,
  settingsOpen: false,
  usageOpen: false,
  scheduledOpen: false,
  channelsOpen: false,
  sidebarMode: 'projects',
  sideCardFits: true
}

describe('side card visibility', () => {
  it('shows over a full-width thread view when switched on', () => {
    expect(isSideCardVisible(open)).toBe(true)
  })

  it.each<[string, Partial<SideCardVisibilityInput>]>([
    ['switched off', { sideCardOn: false }],
    ['the app panel is open', { mainAreaOpen: true }],
    ['Settings is open', { settingsOpen: true }],
    ['Usage is open', { usageOpen: true }],
    ['Scheduled is open', { scheduledOpen: true }],
    ['Channels is open', { channelsOpen: true }],
    ['the Chats view is showing', { sidebarMode: 'chats' }],
    ['the thread area is too narrow', { sideCardFits: false }]
  ])('hides when %s', (_name, patch) => {
    expect(isSideCardVisible({ ...open, ...patch })).toBe(false)
  })

  it('needs a thread area of at least the minimum width', () => {
    expect(sideCardFitsThreadWidth(SIDE_CARD_MIN_THREAD_WIDTH)).toBe(true)
    expect(sideCardFitsThreadWidth(SIDE_CARD_MIN_THREAD_WIDTH - 1)).toBe(false)
  })

  it('is on at launch, with the width unmeasured and so not fitting', () => {
    expect(useAppStore.getInitialState().sideCardOn).toBe(true)
    expect(useAppStore.getInitialState().sideCardFits).toBe(false)
  })
})

describe('title-bar button availability', () => {
  it('works, and is pressed only when the card is visible', () => {
    expect(deriveSideCardState(open)).toEqual({ visible: true, unavailable: null })
    expect(deriveSideCardState({ ...open, sideCardOn: false })).toEqual({ visible: false, unavailable: null })
  })

  it('stays enabled while the app panel is open so a click can swap it for the card', () => {
    expect(deriveSideCardState({ ...open, mainAreaOpen: true })).toEqual({ visible: false, unavailable: null })
    expect(deriveSideCardState({ ...open, mainAreaOpen: true, sideCardOn: false })).toEqual({ visible: false, unavailable: null })
  })

  it.each<[string, Partial<SideCardVisibilityInput>]>([
    ['Settings', { settingsOpen: true }],
    ['Usage', { usageOpen: true }],
    ['Scheduled', { scheduledOpen: true }],
    ['Channels', { channelsOpen: true }],
    ['Chats', { sidebarMode: 'chats' }]
  ])('is disabled over %s, even with the card switched on', (_name, patch) => {
    expect(deriveSideCardState({ ...open, ...patch })).toEqual({ visible: false, unavailable: 'view' })
  })

  it('is disabled in a narrow window, whatever the panel or the switch say', () => {
    for (const patch of [{}, { mainAreaOpen: true }, { sideCardOn: false }]) {
      expect(deriveSideCardState({ ...open, ...patch, sideCardFits: false })).toEqual({ visible: false, unavailable: 'narrow' })
    }
  })

  it('names the view before the width when both apply', () => {
    expect(deriveSideCardState({ ...open, settingsOpen: true, sideCardFits: false }).unavailable).toBe('view')
  })

  it('agrees with the visibility the card uses', () => {
    for (const sideCardFits of [true, false]) {
      for (const sideCardOn of [true, false]) {
        for (const mainAreaOpen of [true, false]) {
          const input = { ...open, sideCardFits, sideCardOn, mainAreaOpen }
          expect(isSideCardVisible(input)).toBe(deriveSideCardState(input).visible)
        }
      }
    }
  })

  it('explains a disabled button in its tooltip and otherwise just names it', () => {
    expect(sideCardButtonTitle('narrow')).toBe('Widen the window to show thread details')
    expect(sideCardButtonTitle('view')).toMatch(/thread/i)
    expect(sideCardButtonTitle(null)).toBe('Thread details')
  })
})

describe('title-bar button click', () => {
  it('closes the app panel and turns the card on when it is not showing', () => {
    expect(nextSideCardToggleState(false, { sideCardOn: false, mainAreaOpen: true })).toEqual({ sideCardOn: true, mainAreaOpen: false })
    expect(nextSideCardToggleState(false, { sideCardOn: true, mainAreaOpen: true })).toEqual({ sideCardOn: true, mainAreaOpen: false })
  })

  it('turns the card on without touching a closed app panel', () => {
    expect(nextSideCardToggleState(false, { sideCardOn: false, mainAreaOpen: false })).toEqual({ sideCardOn: true, mainAreaOpen: false })
  })

  it('switches the card off when it is showing', () => {
    expect(nextSideCardToggleState(true, { sideCardOn: true, mainAreaOpen: false })).toEqual({ sideCardOn: false, mainAreaOpen: false })
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
    sideCardFits: false,
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
    // Without a project folder Git collapses to one quiet line between Device and Actions, and
    // without agents Lineage collapses to one quiet line at the end; neither keeps its heading.
    expect(titles).toEqual(['Device', 'Actions'])
    expect(html.indexOf('lineage-collapsed')).toBeGreaterThan(html.indexOf('>Actions<'))
    expect(html.indexOf('side-card-git-collapsed')).toBeGreaterThan(html.indexOf('>Device<'))
    expect(html.indexOf('side-card-git-collapsed')).toBeLessThan(html.indexOf('>Actions<'))
    expect(html).toContain('data-thread-id="thread-1"')
  })

  it('renders no card until the width is measured, so a narrow window never flashes it', () => {
    seed({ activeThreadId: 'thread-1' })
    expect(render()).not.toContain('thread-side-card"')
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
