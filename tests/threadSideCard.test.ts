import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import { SideCardSections, ThreadSideCard } from '../src/renderer/components/sideCard/ThreadSideCard'
import {
  SIDE_CARD_MIN_THREAD_WIDTH,
  deriveSideCardState,
  nextSideCardToggleState,
  sideCardButtonTitle,
  sideCardFitsThreadWidth,
  threadViewWidth,
  threadsSidebarReservedWidth,
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
    ['the thread area is too narrow', { sideCardFits: false }],
    ['the width is not measured yet', { sideCardFits: null }]
  ])('hides when %s', (_name, patch) => {
    expect(visible({ ...open, ...patch })).toBe(false)
  })

  it('needs a thread area of at least the minimum width', () => {
    expect(sideCardFitsThreadWidth(SIDE_CARD_MIN_THREAD_WIDTH)).toBe(true)
    expect(sideCardFitsThreadWidth(SIDE_CARD_MIN_THREAD_WIDTH - 1)).toBe(false)
  })

  it('is on at launch, with the width unmeasured', () => {
    expect(useAppStore.getInitialState().sideCardOn).toBe(true)
    expect(useAppStore.getInitialState().sideCardFits).toBeNull()
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

  it('stays enabled until a measurement comes up short', () => {
    // At launch the width is unmeasured, with the app panel open or not.
    for (const patch of [{}, { mainAreaOpen: true }, { sideCardOn: false }]) {
      expect(deriveSideCardState({ ...open, ...patch, sideCardFits: null })).toEqual({ visible: false, unavailable: null })
    }
    // A wide measurement taken with the app panel open keeps the button usable.
    expect(deriveSideCardState({ ...open, mainAreaOpen: true, sideCardFits: true }).unavailable).toBeNull()
  })

  it('still names the view first while unmeasured', () => {
    expect(deriveSideCardState({ ...open, settingsOpen: true, sideCardFits: null }).unavailable).toBe('view')
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
    sideCardFits: null as boolean | null,
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
    seed({ sideCardFits: false })
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
