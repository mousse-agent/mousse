import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it } from 'vitest'
import { SubagentComposerBanner, SubagentComposerBannerView } from '../src/renderer/components/SubagentComposerBanner'
import { collectNeedingInput, needingInputLabel } from '../src/renderer/components/subagentBannerLogic'
import { useAppStore } from '../src/renderer/stores/appStore'
import type { SubagentState, SubagentSummary } from '../src/shared/subagents'

const subagent = (id: string, state: SubagentState, patch: Partial<SubagentSummary> = {}): SubagentSummary => ({
  childThreadId: id,
  title: `Subagent ${id}`,
  activity: 'working',
  state,
  latestDelegationId: `d-${id}`,
  unread: false,
  provider: null,
  model: null,
  workspace: 'shared',
  role: null,
  createdAt: '2026-10-25T12:00:00.000Z',
  updatedAt: '2026-10-25T12:00:00.000Z',
  waitingOn: [],
  tasks: [],
  ...patch
})

describe('collectNeedingInput', () => {
  it('lists the subagents of the thread that ask a question, and nothing else', () => {
    const found = collectNeedingInput({ p: [subagent('a', 'needs_input'), subagent('b', 'working'), subagent('c', 'done')] }, 'p')
    expect(found).toEqual([{ childThreadId: 'a', openId: 'a', title: 'Subagent a', via: null }])
  })

  it('finds a question asked deeper down, under the subagent of this thread it belongs to', () => {
    const found = collectNeedingInput(
      { p: [subagent('a', 'waiting')], a: [subagent('g', 'needs_input')] },
      'p'
    )
    expect(found).toEqual([{ childThreadId: 'g', openId: 'g', title: 'Subagent g', via: 'Subagent a' }])
  })

  it('a remote subagent that asks opens its thread on its computer, where it is answered', () => {
    const computer = { node: 'node-mac', name: 'Studio Mac', online: true, ref: 'node-mac:far-1' }
    const found = collectNeedingInput({ p: [subagent('a', 'needs_input', { computer })] }, 'p')
    expect(found).toEqual([{ childThreadId: 'a', openId: 'node-mac:far-1', title: 'Subagent a', via: null, computer: 'Studio Mac' }])
    expect(needingInputLabel(found[0])).toBe('Subagent a has a question on Studio Mac')
  })

  it('does not look under a subagent that has finished, past the depth limit, or around a cycle', () => {
    expect(collectNeedingInput({ p: [subagent('a', 'done')], a: [subagent('g', 'needs_input')] }, 'p')).toEqual([])
    expect(
      collectNeedingInput({ p: [subagent('a', 'working')], a: [subagent('b', 'working')], b: [subagent('c', 'working')], c: [subagent('d', 'needs_input')] }, 'p')
    ).toEqual([])
    expect(collectNeedingInput({ p: [subagent('a', 'working')], a: [subagent('p', 'working')] }, 'p')).toEqual([])
  })

  it('has nothing for no thread or an unloaded list', () => {
    expect(collectNeedingInput({}, 'p')).toEqual([])
    expect(collectNeedingInput({ p: [subagent('a', 'needs_input')] }, null)).toEqual([])
  })

  it('words a row by the subagent that asks and where it hangs', () => {
    expect(needingInputLabel({ childThreadId: 'a', openId: 'a', title: 'API reviewer', via: null })).toBe('API reviewer has a question')
    expect(needingInputLabel({ childThreadId: 'g', openId: 'g', title: 'Linter', via: 'API reviewer' })).toBe('Linter has a question, via API reviewer')
  })
})

describe('the composer banner', () => {
  const html = (props: Parameters<typeof SubagentComposerBannerView>[0]) => renderToStaticMarkup(createElement(SubagentComposerBannerView, props))

  it('shows a row that opens the question in the subagent, and hides without one', () => {
    const shown = html({ asking: [{ childThreadId: 'a', openId: 'a', title: 'API reviewer', via: null }], onOpen: () => undefined })
    expect(shown).toContain('API reviewer has a question')
    expect(shown).toContain('title="Open API reviewer"')
    expect(html({ asking: [], onOpen: () => undefined })).toBe('')
  })

  // A server render reads a store's initial state, so the rows are checked through the same
  // function the connected banner uses, fed from the store's live state.
  describe('for a thread in the store', () => {
    const banner = () => {
      const state = useAppStore.getState()
      return html({ asking: collectNeedingInput(state.subagentsByParent, 'p'), onOpen: () => undefined })
    }

    beforeEach(() => {
      useAppStore.setState({ subagentsByParent: {} })
    })

    it('renders nothing before the daemon has answered', () => {
      expect(renderToStaticMarkup(createElement(SubagentComposerBanner, { threadId: 'p' }))).toBe('')
      expect(banner()).toBe('')
    })

    it('shows when a subagent of the thread needs input and hides once it is answered', () => {
      useAppStore.getState().setSubagents('p', [subagent('a', 'needs_input')])
      expect(banner()).toContain('Subagent a has a question')
      useAppStore.getState().setSubagents('p', [subagent('a', 'working')])
      expect(banner()).toBe('')
    })

    it('does not show another thread`s subagent', () => {
      useAppStore.getState().setSubagents('other', [subagent('a', 'needs_input')])
      expect(banner()).toBe('')
    })
  })
})

describe('the banner styles', () => {
  it('highlight by background only, with no side or edge bar', () => {
    const css = readFileSync(new URL('../src/renderer/components/subagentComposerBanner.css', import.meta.url), 'utf8')
    expect(css).not.toMatch(/border-(left|right|inline-start|inline-end)\s*:/)
    expect(css).not.toMatch(/inset\s+-?[1-9]\d*px\s+0/)
    expect(css).not.toMatch(/::(before|after)/)
  })
})
