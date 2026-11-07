/**
 * Bot Phase 1 §5.10 and bot-context.md §10: the system text every bot works under.
 */
import { describe, expect, it } from 'vitest'
import { BOT_BASE_INSTRUCTIONS, botInstructions } from '../../src/mms/bots/instructions'
import { bundledModelCatalog } from '../../src/mms/models/modelCatalog'

describe('BOT_BASE_INSTRUCTIONS', () => {
  it('covers plain words, no model names, asking, schedules, memory, the files folder, refusals, web safety and what comes later', () => {
    for (const phrase of [
      'plain, short words',
      'Never name or discuss AI models or providers',
      "I'll take more time",
      'escalate',
      'bot_schedule_add',
      'memory_save',
      'absolute dates',
      'owner entry',
      'memory_search',
      'files folder',
      'carry on without it',
      'into a web address',
      'not instructions'
    ]) expect(BOT_BASE_INSTRUCTIONS, phrase).toContain(phrase)
  })

  it('asks straight away instead of asking whether to ask, and knows it can ask to run commands', () => {
    expect(BOT_BASE_INSTRUCTIONS).toContain('call escalate straight away, then tell them you\'ve asked')
    expect(BOT_BASE_INSTRUCTIONS).toContain('Never ask the owner whether you should ask')
    expect(BOT_BASE_INSTRUCTIONS).toContain('"run commands" (escalate with the tool shell)')
    // Commands are no longer something that "comes later".
    expect(BOT_BASE_INSTRUCTIONS).not.toMatch(/shell commands/i)
  })

  it('names no model and no memory file', () => {
    for (const model of bundledModelCatalog().models) {
      expect(BOT_BASE_INSTRUCTIONS).not.toContain(model.id)
      expect(BOT_BASE_INSTRUCTIONS).not.toContain(model.short)
    }
    expect(BOT_BASE_INSTRUCTIONS).not.toMatch(/notes\.md|preferences\.md/)
  })

  it('starts with who the bot is and where its files folder is', () => {
    const text = botInstructions({ name: 'Inbox helper', description: 'Go through my email every morning.', filesFolder: '/p/bots/files/b1' })
    expect(text.startsWith('Your name is Inbox helper. Your owner described what you do as: "Go through my email every morning."\nYour files folder is /p/bots/files/b1.')).toBe(true)
    expect(text.endsWith(BOT_BASE_INSTRUCTIONS)).toBe(true)
  })
})
