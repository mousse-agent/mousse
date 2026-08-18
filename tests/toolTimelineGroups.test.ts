import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../src/shared/types'
import { groupChatTimeline } from '../src/renderer/utils/toolTimelineGroups'

const message = (id: string, kind?: ChatMessage['kind']): ChatMessage => ({
  id,
  role: kind ? 'system' : 'assistant',
  content: kind ? '' : id,
  timestamp: '2026-07-15T00:00:00.000Z',
  kind,
  toolCall: kind && kind !== 'thinking'
    ? { title: id, summary: id, details: [] }
    : undefined
})

describe('groupChatTimeline', () => {
  it('keeps assistant text chronologically between tool groups', () => {
    const groups = groupChatTimeline([
      message('intro'),
      message('read', 'mcp_tool_call'),
      message('write', 'build_tool_call'),
      message('progress'),
      message('search', 'mcp_tool_call'),
      message('final')
    ])

    expect(groups.map((group) =>
      group.type === 'tool-group' ? group.messages.map((entry) => entry.id) : group.message.id
    )).toEqual(['intro', ['read', 'write'], 'progress', ['search'], 'final'])
  })

  it('does not hide thinking or fold isolated calls into a Used Tools pill', () => {
    const groups = groupChatTimeline([
      message('read', 'mcp_tool_call'),
      message('thinking', 'thinking'),
      message('write', 'mcp_tool_call')
    ])

    expect(groups).toHaveLength(3)
    expect(groups[0]).toMatchObject({ type: 'tool-group', messages: [{ id: 'read' }] })
    expect(groups[2]).toMatchObject({ type: 'tool-group', messages: [{ id: 'write' }] })
  })

  it('does not let empty streaming placeholders split one tool run', () => {
    const placeholder = {
      ...message('placeholder'),
      content: '',
      streaming: true
    }
    const groups = groupChatTimeline([
      message('read', 'mcp_tool_call'),
      placeholder,
      message('write', 'build_tool_call'),
      message('final')
    ])

    expect(groups.map((group) =>
      group.type === 'tool-group' ? group.messages.map((entry) => entry.id) : group.message.id
    )).toEqual([['read', 'write'], 'final'])
  })

  it('retains an empty streaming placeholder when it is not between tools', () => {
    const placeholder = {
      ...message('placeholder'),
      content: '',
      streaming: true
    }
    const groups = groupChatTimeline([placeholder, message('read', 'mcp_tool_call')])

    expect(groups.map((group) => group.type === 'tool-group' ? group.messages[0].id : group.message.id))
      .toEqual(['placeholder', 'read'])
  })
})
