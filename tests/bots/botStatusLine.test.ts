import { describe, expect, it } from 'vitest'
import { BOT_STATUS_MAX_CHARS, statusLineOf } from '../../src/mms/bots/activity/statusLine'
import type { ChatMessage } from '../../src/shared/types'

/** A bot's status line: its latest words before a step of its turn, shown beside its typing dots. */

const at = (role: ChatMessage['role'], content: string, kind?: ChatMessage['kind'], turnId: string | undefined = 't2'): ChatMessage =>
  ({ id: `${role}-${content}-${kind ?? ''}`, role, content, timestamp: '2026-11-14T10:00:00.000Z', ...(turnId ? { turnId } : {}), ...(kind ? { kind } : {}) })
const step = (kind: ChatMessage['kind'] = 'tool_call') => at('assistant', '', kind)
const owner = (text: string, turnId?: string) => at('user', text, undefined, turnId)

describe('statusLineOf', () => {
  const rows: Array<[string, ChatMessage[], string | undefined]> = [
    ['the words before a step', [owner('prices?'), at('assistant', 'Checking prices at Indian stores now'), step()], 'Checking prices at Indian stores now'],
    ['an MCP step', [owner('prices?'), at('assistant', 'Looking in your notes', 'message'), step('mcp_tool_call')], 'Looking in your notes'],
    ['the latest words, past earlier steps and their results', [owner('go'), at('assistant', 'Opening the store'), step(), at('assistant', '', 'mcp_tool_result'), at('assistant', 'Reading reviews'), step()], 'Reading reviews'],
    ['several steps after one line: still that line', [owner('go'), at('assistant', 'Searching'), step(), step()], 'Searching'],
    ['hidden reasoning is never a status', [owner('go'), at('assistant', 'secret plan', 'thinking'), step()], undefined],
    ['the reply after the last step', [owner('go'), at('assistant', 'Checking'), step(), at('assistant', 'Found three.')], undefined],
    ['no words this turn: not the last turn\'s', [owner('go', 't1'), at('assistant', 'Old line', undefined, 't1'), owner('again'), step()], undefined],
    ['no words this turn, another turn id with no owner row between', [at('assistant', 'Old line', undefined, 't1'), step()], undefined],
    ['blank words are skipped', [owner('go'), at('assistant', 'Checking'), at('assistant', '  \n '), step()], 'Checking'],
    ['whitespace and line breaks fold into one line', [owner('go'), at('assistant', '  Checking prices\n\nat   two stores '), step()], 'Checking prices at two stores'],
    ['an empty transcript', [], undefined]
  ]
  it.each(rows)('%s', (_name, messages, expected) => {
    expect(statusLineOf(messages)).toBe(expected)
  })

  it('bounds a long paragraph without cutting short lines', () => {
    const line = 'word '.repeat(100).trim()
    const status = statusLineOf([owner('go'), at('assistant', line), step()])!
    expect(status.length).toBe(BOT_STATUS_MAX_CHARS)
    expect(status.endsWith('…')).toBe(true)
    expect(line.startsWith(status.slice(0, -1))).toBe(true)
  })
})
