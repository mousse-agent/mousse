// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyChatWidth, chatColumnWidth, useChatWidth } from '../../src/renderer/lib/chatWidth'
import { searchSettings } from '../../src/renderer/lib/settingsSearch'
import { AppearanceSettings } from '../../src/renderer/components/settings/AppearanceSettings'
import { getDefaultSettings, THEME_OPTIONS, type SettingsOptions } from '../../src/shared/settings'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const appCss = readFileSync(resolve(process.cwd(), 'src/renderer/styles/app.css'), 'utf8')

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  applyChatWidth('normal')
})

describe('chat width', () => {
  it('marks the root element and tells code that lays out beside the column', () => {
    const seen: string[] = []
    function Probe() {
      seen.push(useChatWidth())
      return null
    }
    act(() => root.render(createElement(Probe)))
    act(() => applyChatWidth('wide'))
    expect(document.documentElement.getAttribute('data-chat-width')).toBe('wide')
    expect(seen.at(-1)).toBe('wide')
    act(() => applyChatWidth('full'))
    expect(document.documentElement.getAttribute('data-chat-width')).toBe('full')
    expect(seen.at(-1)).toBe('full')
  })

  it('sets a 736px text column, 1152px when wide and the whole pane when full', () => {
    expect(appCss).toMatch(/\.chat \{[^}]*--chat-text-width: 736px;\s*--an-max-width: calc\(var\(--chat-text-width\) \+ 48px\);/)
    expect(appCss).toMatch(/html\[data-chat-width='wide'\] \.chat \{\s*--chat-text-width: 1152px;/)
    expect(appCss).toMatch(/html\[data-chat-width='full'\] \.chat \{\s*--an-max-width: 100%;/)
    expect(chatColumnWidth('normal')).toBe(784)
    expect(chatColumnWidth('wide')).toBe(1200)
    expect(chatColumnWidth('full')).toBe(Infinity)
  })

  it('is a Normal / Wide / Full choice in the Chat group of Appearance, and the search finds it', () => {
    const onUpdate = vi.fn(async () => {})
    const options = { themes: THEME_OPTIONS, accentColors: [] } as unknown as SettingsOptions
    act(() => root.render(createElement(AppearanceSettings, {
      settings: getDefaultSettings(),
      options,
      onUpdate,
      restartRequired: false,
      onRestart: () => {},
      onPreviewAcrylicIntensity: () => {},
      onCommitAcrylicIntensity: () => {},
      onPreviewFrostedComposer: () => {},
      onCommitFrostedComposer: () => {}
    })))
    const group = host.querySelector('[data-settings-anchor="appearance-chat"]')
    expect(group?.querySelector('[data-settings-anchor="appearance-chat-width"]')?.textContent).toContain('Chat width')
    // Reply pacing, math and the changed-files line sit with it in the Chat group.
    const text = host.textContent ?? ''
    const chat = text.indexOf('Chat width')
    const composer = text.indexOf('Context ring in composer')
    for (const title of ['Render math', 'Show replies a paragraph at a time', 'Changed files after each turn']) {
      expect(text.indexOf(title)).toBeGreaterThan(chat)
      expect(text.indexOf(title)).toBeLessThan(composer)
    }
    expect(searchSettings('chat width', [{ id: 'appearance', label: 'Appearance', keywords: [] }])[0])
      .toMatchObject({ title: 'Chat width', section: 'appearance', anchor: 'appearance-chat-width' })
  })
})
