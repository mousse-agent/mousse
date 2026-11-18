/**
 * Bot Phase 1 §5.4: an ask in plain words for its card ("<name> wants to <title>") and About.
 */
import { describe, expect, it } from 'vitest'
import { askCallNote, askText } from '../../src/shared/bots/personal/askText'
import { BOT_APP_TOOLS } from '../../src/shared/bots/personal/manifest'

describe('askText', () => {
  it('a file ask an older build wrote reads as no longer available', () => {
    expect(askText({ path: '/home/me/Documents/Invoices', access: 'read' })).toEqual({ title: 'use files on this computer', note: 'No longer available: a bot uses only its own files folder.' })
  })

  it('tools, skills and MCP tools in words', () => {
    expect(askText({ tool: 'web_fetch' }).title).toBe('read web pages')
    expect(askText({ tool: 'read' }).title).toBe('read files')
    expect(askText({ tool: 'shell' }).title).toBe('run commands')
    // One permission for any command: the note says where they start and that they reach other files.
    expect(askText({ tool: 'shell' }).note).toBe('Any command, started in its files folder. Commands can reach other files on this computer.')
    // A tool with no words of its own: the card never shows its name, the tooltip does.
    expect(askText({ tool: 'some_tool' })).toEqual({ title: "use another of Mousse's tools", note: '', tip: "Mousse's tool some_tool." })
    expect(askText({ skill: 'release-notes' })).toEqual({ title: 'use the release-notes skill', note: '' })
    // An older row naming one tool still reads plainly; Mousse asks for a server's tools as one ask.
    expect(askText({ mcp: { serverId: 'srv-1', tool: 'create_issue' } }).title).toBe('use the MCP tool create_issue')
    expect(askText({ mcp: { serverId: 'srv-1', name: 'GitHub', tools: ['create_issue', 'list_issues'], changes: 'some' } }))
      .toEqual({ title: 'use your GitHub tools', note: 'GitHub says some of these tools can change things.' })
    expect(askText({ mcp: { serverId: 'srv-1', name: 'GitHub', tools: ['close_issue'], added: true, changes: 'unknown' } }))
      .toEqual({ title: 'use GitHub\'s new tools', note: 'GitHub has new tools. GitHub doesn\'t say whether these tools change things.' })
    expect(askText({ mcp: { serverId: 'srv-1', name: 'Notes', tools: ['read_note'], changes: 'none' } }).note).toBe('Notes says these tools only read.')
  })

  it('limits as their new totals when the current ones are known', () => {
    const budget = { maxActiveMs: 15 * 60_000, maxTurns: 40, maxUsd: 1 }
    // An older build's ask for work time, kept on an answered card, names no time.
    expect(askText({ budget: { key: 'maxActiveMs', amount: 15 * 60_000 } }, { budget })).toEqual({ title: 'keep working', note: '' })
    expect(askText({ budget: { key: 'maxTurns', amount: 20 } }, { budget }).title).toBe('take up to 60 steps per run')
    expect(askText({ budget: { key: 'maxUsd', amount: 0.5 } }, { budget }).title).toBe('spend up to $1.5 per run')
    expect(askText({ budget: { key: 'maxOutputTokens', amount: 1000 } }, { budget }).title).toBe('read and write more on each run')
    expect(askText({ budget: { key: 'maxInputTokens', amount: 200_000 } }, { budget: { ...budget, maxInputTokens: 200_000 } }).title).toBe('read up to 400,000 tokens per run')
    expect(askText({ budget: { key: 'maxOutputTokens', amount: 20_000 } }, { budget: { ...budget, maxOutputTokens: 40_000 } }).title).toBe('write up to 60,000 tokens per run')
  })

  it('the export ask grants nothing', () => {
    expect(askText({ ask: 'export_memory' })).toEqual({ title: 'save its memory to a folder', note: 'You pick the folder. Nothing else changes.' })
  })

  it('every tool a bot can be asked for has words of its own', () => {
    const fallback = askText({ tool: 'some_tool' }).title
    for (const tool of BOT_APP_TOOLS) expect([tool, askText({ tool }).title]).not.toEqual([tool, fallback])
    expect(askText({ tool: 'telling_set' }).title).toBe('change when it tells you')
  })

  it('a telling_set call says what it would set', () => {
    expect(askCallNote('telling_set', { tellMe: 'needs_you', schedules: true, canWakeMe: true })).toBe('It would set: tell you when it needs you, its automations too, it can wake you.')
    // One automation's exception: only that automation changes, never the bot's own.
    expect(askCallNote('telling_set', { scheduleId: 's1', canWakeMe: true })).toBe('It would set: one of its automations can wake you.')
    expect(askCallNote('telling_set', { scheduleId: 's1', canWakeMe: false })).toBe('It would set: one of its automations can’t wake you.')
    expect(askCallNote('telling_set', { quietHours: 'off', canWakeMe: false })).toBe('It would set: no quiet hours, it can’t wake you.')
    // What the model wrote wrongly is left out; nothing left, no note.
    expect(askCallNote('telling_set', { tellMe: 'urgent', quietHours: { from: '25:00', to: '07:00' } })).toBeUndefined()
    expect(askCallNote('set_depth', { depth: 'deep' })).toBeUndefined()
  })
})
