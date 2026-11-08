/**
 * Bot Phase 1 §5.4: an ask in plain words for its card ("<name> wants to <title>") and About.
 */
import { describe, expect, it } from 'vitest'
import { askText } from '../../src/shared/bots/personal/askText'

describe('askText', () => {
  it('folders by access, shortened to ~', () => {
    expect(askText({ path: '/home/me/Documents/Invoices', access: 'read' }, { home: '/home/me' })).toEqual({ title: 'read files in ~/Documents/Invoices', note: "Only this folder. It can't change anything." })
    expect(askText({ path: '/home/me/Notes', access: 'write' }, { home: '/home/me' })).toEqual({ title: 'change files in ~/Notes', note: 'Only this folder.' })
  })

  it('tools, skills and MCP tools in words', () => {
    expect(askText({ tool: 'web_fetch' }).title).toBe('read web pages')
    expect(askText({ tool: 'read' }).title).toBe('read files')
    expect(askText({ tool: 'shell' }).title).toBe('run commands')
    // One permission for any command: the note says where they start and that they are not held to the folders.
    expect(askText({ tool: 'shell' }).note).toBe('Any command, started in its files folder. Commands can reach files outside the folders you allow.')
    expect(askText({ tool: 'some_tool' }).title).toBe('use the some tool tool')
    expect(askText({ skill: 'release-notes' })).toEqual({ title: 'use the release-notes skill', note: '' })
    expect(askText({ mcp: { serverId: 'github', tool: 'create_issue' } }).title).toBe('use create_issue from github')
  })

  it('limits as their new totals when the current ones are known', () => {
    const budget = { maxActiveMs: 15 * 60_000, maxTurns: 40, maxUsd: 1 }
    expect(askText({ budget: { key: 'maxActiveMs', amount: 15 * 60_000 } }, { budget }).title).toBe('work for up to 30 minutes per run')
    // Whole hours read as hours.
    expect(askText({ budget: { key: 'maxActiveMs', amount: 60 * 60_000 } }, { budget: { maxActiveMs: 60 * 60_000 } }).title).toBe('work for up to 2 hours per run')
    expect(askText({ budget: { key: 'maxActiveMs', amount: 30 * 60_000 } }, { budget: { maxActiveMs: 60 * 60_000 } }).title).toBe('work for up to 90 minutes per run')
    expect(askText({ budget: { key: 'maxActiveMs' } }, { budget }).title).toBe('work longer on each run')
    expect(askText({ budget: { key: 'maxTurns', amount: 20 } }, { budget }).title).toBe('take up to 60 steps per run')
    expect(askText({ budget: { key: 'maxUsd', amount: 0.5 } }, { budget }).title).toBe('spend up to $1.5 per run')
    expect(askText({ budget: { key: 'maxOutputTokens', amount: 1000 } }, { budget }).title).toBe('read and write more on each run')
    expect(askText({ budget: { key: 'maxInputTokens', amount: 200_000 } }, { budget: { ...budget, maxInputTokens: 200_000 } }).title).toBe('read up to 400,000 tokens per run')
    expect(askText({ budget: { key: 'maxOutputTokens', amount: 20_000 } }, { budget: { ...budget, maxOutputTokens: 40_000 } }).title).toBe('write up to 60,000 tokens per run')
  })

  it('the export ask grants nothing', () => {
    expect(askText({ ask: 'export_memory' })).toEqual({ title: 'save its memory to a folder', note: 'You pick the folder. Nothing else changes.' })
  })
})
