import { expect, it } from 'vitest'
import { BOT_CHANGELOG } from '../../src/mms/bots/changelog'
import { BOT_TOOLS } from '../../src/mms/run/mcp/appTools/bots'
it('tells the model that a fixed line is only available in a turn the owner started', () => {
  for (const text of [BOT_CHANGELOG.find(row => row.id === 14)!.text, JSON.stringify(BOT_TOOLS.find(tool => tool.name === 'bot_schedule_add'))]) expect(text).toMatch(/say.*only.*owner.*(?:message|tap)|only.*owner.*(?:message|tap).*say/i)
})
