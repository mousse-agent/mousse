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
  sidebar: ['src/renderer/components/ThreadsSidebar.tsx'],
  titlebar: ['src/renderer/components/TitleBar.tsx'],
  'chat-header': ['src/renderer/components/TitleBarNav.tsx', 'src/renderer/components/chats/ChatWorkspace.tsx'],
  chat: ['src/renderer/components/OrchestratorChat.tsx'],
  transcript: ['src/renderer/chat/components/agent-elements/message-list.tsx'],
  'user-message': ['src/renderer/chat/components/agent-elements/user-message.tsx'],
  'assistant-message': ['src/renderer/chat/components/agent-elements/message-list.tsx'],
  composer: ['src/renderer/components/ChatComposer.tsx'],
  'project-icon': ['src/renderer/components/ProjectIcon.tsx'],
  'side-card': ['src/renderer/components/sideCard/ThreadSideCard.tsx'],
  settings: ['src/renderer/components/SettingsPage.tsx']
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
