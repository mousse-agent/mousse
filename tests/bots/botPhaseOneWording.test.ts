import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { BOT_BASE_INSTRUCTIONS } from '../../src/mms/bots/instructions'
import { BOT_CHANGELOG } from '../../src/mms/bots/changelog'
import { BOT_TOOLS } from '../../src/mms/run/mcp/appTools/bots'
const doc = readFileSync('docs/bots.md', 'utf8')
it('documents current reminder ownership, telling, schedule removal and stored wishes', () => {
  expect(doc).not.toContain('They do not change reminder or prompt-schedule telling')
  expect(doc).not.toContain('work reports, unattended replies')
  expect(doc).not.toContain('or its own run cancels')
  expect(doc).not.toContain('Later writers will store 0 or 1')
  expect(doc).not.toContain('telling wishes column is reserved')
  expect(doc).not.toContain('it notifies as a question does')
  expect(doc).toContain('fixed lines still fire during a usage-limit pause')
})
it('explains owner-only fixed lines, the file list limit and quiet-hour terms', () => {
  for (const text of [BOT_BASE_INSTRUCTIONS, BOT_CHANGELOG.find(row => row.id === 14)!.text, JSON.stringify(BOT_TOOLS.find(tool => tool.name === 'bot_schedule_add'))]) expect(text).toMatch(/say.*only.*owner.*(?:message|tap)|only.*owner.*(?:message|tap).*say/i)
  expect(BOT_BASE_INSTRUCTIONS).toContain('newest twelve files')
  const glossary = readFileSync('docs/GLOSSARY.md', 'utf8')
  expect(glossary).toMatch(/\*\*Fixed line:\*\*.*schedule/)
  expect(glossary).toMatch(/\*\*Quiet hours:\*\*.*nudges.*defaults/)
  expect(glossary.indexOf('**Can wake me:**')).toBeLessThan(glossary.indexOf('**Nudge:**'))
})
