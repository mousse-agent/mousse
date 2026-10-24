import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import { ThreadSideCard } from '../src/renderer/components/sideCard/ThreadSideCard'
import {
  SIDE_CARD_MIN_THREAD_WIDTH,
  isSideCardVisible,
  nextSideCardToggleState,
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
  sidebarMode: 'projects'
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
    ['the Chats view is showing', { sidebarMode: 'chats' }]
  ])('hides when %s', (_name, patch) => {
    expect(isSideCardVisible({ ...open, ...patch })).toBe(false)
  })

  it('needs a thread area of at least the minimum width', () => {
    expect(sideCardFitsThreadWidth(SIDE_CARD_MIN_THREAD_WIDTH)).toBe(true)
    expect(sideCardFitsThreadWidth(SIDE_CARD_MIN_THREAD_WIDTH - 1)).toBe(false)
  })

  it('is on at launch', () => {
    expect(useAppStore.getInitialState().sideCardOn).toBe(true)
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
  const reset = { sideCardOn: true, mainAreaOpen: false, settingsOpen: false, sidebarMode: 'projects' as const, activeThreadId: null }
  const render = () => renderToStaticMarkup(createElement(ThreadSideCard))

  afterEach(() => seed(reset))

  it('renders the four sections in order inside a scrolling card', () => {
    seed({ activeThreadId: 'thread-1' })
    const html = render()
    const titles = [...html.matchAll(/side-card-section-title">([^<]+)</g)].map((match) => match[1])
    // Without a project folder the Git section collapses to one quiet line between Device and Actions.
    expect(titles).toEqual(['Device', 'Actions', 'Lineage'])
    expect(html.indexOf('side-card-git-collapsed')).toBeGreaterThan(html.indexOf('>Device<'))
    expect(html.indexOf('side-card-git-collapsed')).toBeLessThan(html.indexOf('>Actions<'))
    expect(html).toContain('aria-label="Thread details"')
    expect(html).toContain('data-thread-id="thread-1"')
  })

  it('renders no card while the app panel is open or the card is off', () => {
    seed({ mainAreaOpen: true })
    expect(render()).not.toContain('thread-side-card"')
    seed({ mainAreaOpen: false, sideCardOn: false })
    expect(render()).not.toContain('thread-side-card"')
  })
})
