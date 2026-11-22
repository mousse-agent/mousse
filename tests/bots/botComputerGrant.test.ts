/**
 * "Use the computer": one bot permission for both computer tools, asked for in plain words (escalate with the tool
 * computer), shown in the bot's About and compiled into its work. Without it a bot's turns get neither tool.
 */
import { describe, expect, it } from 'vitest'
import { compileBotThread } from '../../src/mms/bots/grants/compile'
import { botAllowedOf, botAllowedText } from '../../src/mms/bots/instructions'
import { askText } from '../../src/shared/bots/personal/askText'
import { grantRequestOf, permissionText, withPermission } from '../../src/shared/bots/personal/escalation'
import { BOT_COMPUTER_TOOLS, botStarterManifest, describeManifest, manifestProblem } from '../../src/shared/bots/personal/manifest'

const compile = (appTools: string[]) => {
  const compiled = compileBotThread({
    grant: { ...botStarterManifest(), appTools }, digest: 'd', thread: {}, scratch: '/tmp/mousse-computer-grant-scratch', profileHome: '/tmp/mousse-computer-grant-home',
    nativeNames: (tools) => ({ ok: true, names: [...tools] }), remaining: { deadlineMs: 60_000 }
  })
  if (!compiled.ok) throw new Error(compiled.error.message)
  return compiled
}

describe('the computer permission', () => {
  it('every computer tool is the one "use the computer" ask', () => {
    for (const tool of [...BOT_COMPUTER_TOOLS, 'computer']) {
      expect(askText({ tool }).title, tool).toBe('use the computer')
      expect(grantRequestOf({ tool })).toEqual({ tool: 'computer' })
      expect(permissionText({ tool })).toBe('Use the computer')
    }
  })

  it('allowing it grants "computer" as a whole, shown in the bot\'s About as "Use the computer"', () => {
    const granted = withPermission(botStarterManifest(), { tool: 'computer_use' })
    expect(granted.appTools.filter((tool) => tool.startsWith('computer'))).toEqual(['computer'])
    expect(manifestProblem(granted)).toBeUndefined()
    expect(describeManifest(granted).map((line) => line.text)).toContain('Use the computer')
    expect(manifestProblem({ ...botStarterManifest(), appTools: [...botStarterManifest().appTools, 'computer_use'] })).toMatch(/computer_use/)
  })

  it('compiles to both computer tools with it, and to neither without it', () => {
    const withComputer = compile([...botStarterManifest().appTools, 'computer'])
    for (const tool of BOT_COMPUTER_TOOLS) {
      expect(withComputer.permissions.appTools).toContain(tool)
      expect(withComputer.policy.tools!.allow).toContain(tool)
    }
    const without = compile(botStarterManifest().appTools)
    expect(without.permissions.appTools.filter((tool) => tool.startsWith('computer'))).toEqual([])
  })

  it('the bot is told whether it holds it, and that its chat hands the job to its work', () => {
    const line = (text: string) => text.split('\n').find((entry) => entry.startsWith('- Use apps on this computer'))
    expect(line(botAllowedText(botAllowedOf(botStarterManifest()), 'run'))).toBe('- Use apps on this computer: no')
    const granted = botAllowedOf(withPermission(botStarterManifest(), { tool: 'computer' }))
    expect(line(botAllowedText(granted, 'run'))).toBe('- Use apps on this computer: yes')
    expect(line(botAllowedText(granted, 'chat'))).toBe('- Use apps on this computer: yes, in your work')
  })
})
