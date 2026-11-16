// @vitest-environment jsdom
import { act, createElement, Fragment } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chatStatusFromTurn, mousseToUIMessages } from '../../src/renderer/chat/adapters/mousseToUI'
import { collectNativeSubagentCards } from '../../src/renderer/chat/adapters/nativeSubagents'
import { MessageList } from '../../src/renderer/chat/components/agent-elements/message-list'
import { LOCATED_CLASS } from '../../src/renderer/chat/components/agent-elements/reveal-message'
import { SubagentCardsContext } from '../../src/renderer/chat/components/agent-elements/tools/subagent-cards-context'
import { LineageSection } from '../../src/renderer/components/sideCard/LineageSection'
import { useAppStore } from '../../src/renderer/stores/appStore'
import { useChatNavigationStore } from '../../src/renderer/stores/chatNavigationStore'
import type { AgentActivityItem } from '../../src/shared/agentActivity'
import type { ChatMessage } from '../../src/shared/types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const T0 = Date.parse('2026-11-16T09:00:00.000Z')
const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString()
const RUN = 'run:thread:t1:ordinal:1'

const user = (id: string, seconds: number, content: string): ChatMessage =>
  ({ id, role: 'user', content, timestamp: at(seconds), turnId: RUN }) as ChatMessage
const row = (id: string, seconds: number, activity: Partial<AgentActivityItem> & { kind: AgentActivityItem['kind'] }): ChatMessage =>
  ({
    id,
    role: 'system',
    kind: 'mcp_tool_call',
    content: '',
    timestamp: at(seconds),
    turnId: RUN,
    toolCall: { title: activity.toolName ?? 'Agent', summary: activity.toolName ?? 'Agent', details: [], status: 'complete' },
    activity: { id, callId: `toolu_${id}`, toolName: 'Agent', status: 'done', startedAt: at(seconds), runId: RUN, ...activity }
  }) as ChatMessage

/** Claude Code's own Explore agent, still running: it has no thread, only its card in the transcript. */
const runningExplore = (id: string, seconds: number, description: string) =>
  row(id, seconds, { kind: 'subagent', agentType: 'Explore', description, status: 'running' } as never)
const nestedCommand = (id: string, seconds: number, parentId: string) =>
  row(id, seconds, { kind: 'command', toolName: 'Bash', command: `ls ${id}`, output: 'ok', parentId } as never)

// Two agents started together, as in the report: their cards share one group, which starts folded.
const messages: ChatMessage[] = [
  user('u1', 0, 'Look into bots'),
  runningExplore('a1', 2, 'Explore bot work and threads'),
  runningExplore('a2', 3, 'Explore bot metering and tools'),
  nestedCommand('c1', 5, 'a1'),
  nestedCommand('c2', 6, 'a2')
]

describe('Lineage rows of a thread', () => {
  let host: HTMLDivElement
  let root: Root

  beforeEach(() => {
    ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    ;(window as unknown as { mousse: unknown }).mousse = {
      orchestrator: { getMessages: async () => [] },
      subagents: { list: async () => [], onUpdated: () => () => undefined }
    }
    useAppStore.setState({ activeThreadId: 't1', messages })
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    useAppStore.setState(useAppStore.getInitialState())
    useChatNavigationStore.setState({ subagent: null })
  })

  it('open a running subagent of Claude Code from its row: the transcript lands on its card, opened', async () => {
    const ui = mousseToUIMessages(messages)
    await act(async () => {
      root.render(createElement(Fragment, null,
        createElement(SubagentCardsContext.Provider, { value: collectNativeSubagentCards(ui, true) },
          createElement(MessageList, { messages: ui, status: chatStatusFromTurn({ phase: 'completed', turnId: RUN }) })),
        createElement('aside', null, createElement(LineageSection, { threadId: 't1', projectId: null }))))
    })
    // The group is folded, so neither card is on the page before the click.
    expect(host.querySelector('[data-native-subagent="a2"]')).toBeNull()

    const lineageRow = [...host.querySelectorAll<HTMLButtonElement>('aside button.lineage-row')]
      .find((button) => button.textContent?.includes('Explore bot metering and tools'))!
    expect(lineageRow.textContent).toContain('Working')
    await act(async () => lineageRow.click())

    const card = host.querySelector<HTMLElement>('[data-native-subagent="a2"]')
    expect(card).not.toBeNull()
    await act(async () => {
      for (let frame = 0; frame < 30 && !card!.classList.contains(LOCATED_CLASS); frame += 1) {
        await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)))
      }
    })
    expect(card!.classList.contains(LOCATED_CLASS)).toBe(true)
    const cardButton = card!.querySelector<HTMLButtonElement>('button.subagent-card')!
    expect(cardButton.getAttribute('aria-expanded')).toBe('true')
    expect(document.activeElement).toBe(cardButton)
    expect(useChatNavigationStore.getState().subagent).toBeNull()
  })
})
