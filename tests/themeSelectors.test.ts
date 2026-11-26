/**
 * The stable selectors theme CSS may rely on (#1142) are a contract with theme authors and agents: the guide lists
 * them (`THEME_SELECTORS`) and the app's markup carries them. This is a repository rule with no behaviour of its own,
 * so it reads the source: removing or renaming one of the attributes, or adding one without listing it, fails here.
 */
import { readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { THEME_SELECTORS, themeStylingGuide } from '../src/shared/themes/userThemes'

/** Where each part's attribute lives. A part may be drawn by more than one component (the settings page's two states). */
const OWNERS: Record<string, string[]> = {
  rail: ['src/renderer/components/NavigationRail.tsx'],
  'rail-item': ['src/renderer/components/NavigationRail.tsx', 'src/renderer/components/profiles/ProfileSwitcher.tsx'],
  sidebar: ['src/renderer/components/ThreadsSidebar.tsx'],
  titlebar: ['src/renderer/components/TitleBar.tsx'],
  'chat-header': ['src/renderer/components/TitleBarNav.tsx', 'src/renderer/components/chats/ChatWorkspace.tsx', 'src/renderer/components/bots/BotChatView.tsx', 'src/renderer/components/bots/BotThreadHeader.tsx'],
  chat: ['src/renderer/components/OrchestratorChat.tsx', 'src/renderer/components/bots/BotChatView.tsx'],
  transcript: ['src/renderer/chat/components/agent-elements/message-list.tsx', 'src/renderer/components/bots/BotChatView.tsx'],
  'user-message': ['src/renderer/chat/components/agent-elements/user-message.tsx', 'src/renderer/components/bots/BotChatView.tsx'],
  'assistant-message': ['src/renderer/chat/components/agent-elements/message-list.tsx', 'src/renderer/components/bots/BotChatView.tsx'],
  composer: ['src/renderer/components/ChatComposer.tsx'],
  'project-icon': ['src/renderer/components/ProjectIcon.tsx'],
  'side-card': ['src/renderer/components/sideCard/ThreadSideCard.tsx'],
  panel: ['src/renderer/App.tsx'],
  settings: ['src/renderer/components/SettingsPage.tsx'],
  wallpaper: ['src/renderer/components/ChatWallpaper.tsx']
}

const partOf = (selector: string): string => /^\[data-mousse="([a-z-]+)"\]$/.exec(selector)?.[1] ?? selector

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name)
    if (statSync(path).isDirectory()) return sourceFiles(path)
    return /\.tsx?$/.test(name) ? [path] : []
  })
}

describe('stable theme selectors', () => {
  it.each(THEME_SELECTORS.map((entry) => [partOf(entry.selector)]))('[data-mousse="%s"] is on the part it names', (part) => {
    const owners = OWNERS[part]
    expect(owners, `no owner listed for ${part}`).toBeDefined()
    for (const file of owners!) expect(readFileSync(file, 'utf8'), file).toContain(`data-mousse="${part}"`)
  })

  it('lists every data-mousse attribute the app carries, in the guide agents read', () => {
    const used = new Set(sourceFiles('src/renderer').flatMap((file) => [...readFileSync(file, 'utf8').matchAll(/data-mousse="([a-z-]+)"/g)].map((match) => match[1]!)))
    const listed = new Set(THEME_SELECTORS.map((entry) => partOf(entry.selector)))
    expect([...used].sort()).toEqual([...listed].sort())
    for (const entry of THEME_SELECTORS) expect(themeStylingGuide()).toContain(entry.selector)
  })
})

/**
 * Where a person approves, denies, allows or trusts something. Each carries `data-mousse-decision` while the decision is
 * open, and the theme's CSS is off while one is on the page (tests/renderer/theme-css-electron.test.ts shows it).
 * Two checks: these named surfaces, some of whose labels are variables, and a scan for any button labelled Allow,
 * Approve, Deny, Reject or Trust… in a file without the marker, so a new decision surface cannot ship unmarked.
 */
const DECISIONS: Record<string, string> = {
  'a thread\'s permission request': 'src/renderer/chat/components/agent-elements/tools/permission-request.tsx',
  'a tool\'s approval footer': 'src/renderer/chat/components/agent-elements/tools/tool-approval-footer.tsx',
  'an agent-made quick action': 'src/renderer/chat/components/agent-elements/tools/quick-action-tool.tsx',
  'an approval in the composer\'s dock': 'src/renderer/components/ComposerNotice.tsx',
  'an approval in the composer (a plain question is not a decision)': 'src/renderer/components/ComposerQuestionModal.tsx',
  'Needs you asks (bots, workflows, first-creation)': 'src/renderer/components/asks/AskCard.tsx',
  'an automation\'s ask in the inbox': 'src/renderer/components/automations/inbox/AutomationsInbox.tsx',
  'a workflow run\'s approval': 'src/renderer/components/workflows/WorkflowRunPanel.tsx',
  'a bot\'s ask in its chat': 'src/renderer/components/bots/BotAskReplies.tsx',
  'a bot owner\'s permission decision': 'src/renderer/components/chats/BotPermissionDecision.tsx',
  'a group chat\'s browser access': 'src/renderer/components/chats/ChatBrowserAccess.tsx',
  'a device enrollment request': 'src/renderer/components/EnrollmentRequestPrompt.tsx',
  'a phone enrollment left in Settings': 'src/renderer/components/MousseIdSection.tsx',
  'a device asking to be let in (Allow, over any screen)': 'src/renderer/components/netEngine/AllowPrompt.tsx',
  'an editor access request': 'src/renderer/components/EditorAskPrompt.tsx',
  'an editor access request left in Settings': 'src/renderer/components/devices/DeviceAccessRows.tsx',
  'an SSH route approval': 'src/renderer/components/devices/ApproveSshRouteDialog.tsx',
  'an SSH host key to trust (every dialog that shows one)': 'src/renderer/components/devices/HostKeyConfirm.tsx',
  'trusting a repository\'s Git settings': 'src/renderer/components/ThreadsContextMenu.tsx'
}

/**
 * Pages, panels and menus that hold access settings in their own layout, rather than a request waiting for an answer.
 * Each carries `data-mousse-guarded` while open: the theme's CSS is off there (its colors stay), so it cannot relabel,
 * hide or move those controls.
 */
const GUARDED: Record<string, string> = {
  'Settings pages other than Appearance': 'src/renderer/components/SettingsPage.tsx',
  'the Automations page (permission modes, schedules)': 'src/renderer/components/AutomationsPage.tsx',
  'the composer\'s permission mode menu': 'src/renderer/components/ComposerPermissionPicker.tsx',
  'an automation draft, also in a chat': 'src/renderer/components/automations/DraftCard.tsx',
  'an agent definition (grants, scripts)': 'src/renderer/components/agentDefinitions/AgentEditor.tsx',
  'a device\'s limits': 'src/renderer/components/devices/DeviceLimitsDialog.tsx',
  'a bot\'s About panel (what it may use, which devices reach it)': 'src/renderer/components/bots/BotAboutPanel.tsx'
}

/**
 * Files that use permission modes without a marker of their own, each reviewed: it chooses no mode, or it is only shown
 * on a page that is already guarded. A new file that uses permission modes must be marked or added here with its reason.
 */
const PERMISSION_MODE_REVIEWED: Record<string, string> = {
  'src/renderer/lib/permissionModeIcon.tsx': 'icons only',
  'src/renderer/components/ComposerFooter.tsx': 'shows the chip; the menu is ComposerPermissionPicker',
  'src/renderer/components/ComposerEffortPicker.tsx': 'hosts the menu; the choices are ComposerPermissionPicker',
  'src/renderer/components/OrchestratorChat.tsx': 'the handler, no control',
  'src/renderer/components/sideChats/SideChatsPanel.tsx': 'a side chat\'s handler, no control; the menu is ComposerPermissionPicker',
  'src/renderer/components/settings/GeneralSettings.tsx': 'Settings → General, guarded with the page',
  'src/renderer/components/automations/AutomationDetail.tsx': 'only on the Automations page, guarded with it',
  'src/renderer/components/automations/inbox/EditDetailsPane.tsx': 'only on the Automations page, guarded with it'
}

/** A button whose visible label is a decision word. */
const DECISION_BUTTON = /(?:>|\/>|<\/[A-Za-z]+>)\s*(?:Allow|Approve|Deny|Reject|Trust[^<{]{0,40})\s*<\/button>|label: '(?:Allow|Approve|Deny|Reject)'/

describe('decisions turn the theme CSS off', () => {
  it.each(Object.entries(DECISIONS))('%s is marked data-mousse-decision', (_what, file) => {
    expect(readFileSync(file, 'utf8')).toContain('data-mousse-decision')
  })

  it.each(Object.entries(GUARDED))('%s is marked data-mousse-guarded', (_what, file) => {
    expect(readFileSync(file, 'utf8')).toContain('data-mousse-guarded')
  })

  it('every file that uses permission modes is marked or reviewed', () => {
    // Forward slashes on every system, as the reviewed list is written.
    const unreviewed = sourceFiles('src/renderer').map((file) => file.split('\\').join('/')).filter((file) => file.endsWith('.tsx')).filter((file) => {
      const text = readFileSync(file, 'utf8')
      return /shared\/permissionMode'/.test(text) && !text.includes('data-mousse-decision') && !text.includes('data-mousse-guarded') && !(file in PERMISSION_MODE_REVIEWED)
    })
    expect(unreviewed).toEqual([])
  })

  it('every file with an Allow, Approve, Deny, Reject or Trust button marks its decision', () => {
    const unmarked = sourceFiles('src/renderer').filter((file) => {
      const text = readFileSync(file, 'utf8')
      // An approval in the composer's dock is marked by ComposerNotice, from its priority.
      return DECISION_BUTTON.test(text) && !text.includes('data-mousse-decision') && !text.includes("priority: 'approval'")
    })
    expect(unmarked).toEqual([])
  })
})
