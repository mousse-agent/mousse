import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it } from 'vitest'
import { selectSubagents, useSubagents } from '../src/renderer/hooks/useSubagents'
import { useAppStore } from '../src/renderer/stores/appStore'
import type { SubagentSummary } from '../src/shared/subagents'

const row = (id: string): SubagentSummary => ({
  childThreadId: id, title: `Title ${id}`, activity: 'idle', state: 'done', latestDelegationId: `d-${id}`, unread: false,
  provider: null, model: null, workspace: null, role: null, createdAt: 't', updatedAt: 't', tasks: []
})

function Count({ threadId }: { threadId: string | null }) {
  return createElement('p', null, useSubagents(threadId).length)
}

describe('subagents in the renderer store', () => {
  beforeEach(() => { useAppStore.setState({ subagentsByParent: {} }) })

  it('the hook renders empty before the daemon has answered, and for no thread', () => {
    expect(renderToStaticMarkup(createElement(Count, { threadId: 'p' }))).toBe('<p>0</p>')
    expect(renderToStaticMarkup(createElement(Count, { threadId: null }))).toBe('<p>0</p>')
  })

  it('the selector reads the list held for that thread only, and shares one empty array', () => {
    useAppStore.getState().setSubagents('p', [row('a'), row('b')])
    useAppStore.getState().setSubagents('q', [row('c')])
    const state = useAppStore.getState()
    expect(selectSubagents(state, 'p').map((entry) => entry.title)).toEqual(['Title a', 'Title b'])
    expect(selectSubagents(state, 'q').map((entry) => entry.title)).toEqual(['Title c'])
    expect(selectSubagents(state, 'other')).toBe(selectSubagents(state, null))
    expect(selectSubagents(state, undefined)).toEqual([])
  })

  it('setSubagents replaces one thread’s list and leaves the others', () => {
    useAppStore.getState().setSubagents('p', [row('a')])
    useAppStore.getState().setSubagents('q', [row('c')])
    useAppStore.getState().setSubagents('p', [])
    expect(useAppStore.getState().subagentsByParent).toEqual({ p: [], q: [row('c')] })
  })

  it('a profile switch drops every list', () => {
    useAppStore.getState().setSubagents('p', [row('a')])
    useAppStore.getState().activateProfile('another-profile')
    expect(useAppStore.getState().subagentsByParent).toEqual({})
  })
})
