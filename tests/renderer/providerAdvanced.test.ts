// @vitest-environment jsdom
/**
 * A provider's Advanced opens on what can be changed, in one compact list, then the provider's own
 * settings (Claude's settings.json), and last a collapsed, dimmed Info with the read-only facts.
 * A key arrives masked and is only replaced; a file shared with the terminal asks once first.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentEditor } from '../../src/renderer/components/providers/ProviderEditor'
import type { InstanceActions } from '../../src/renderer/components/providers/CliSections'
import { describeStatus, type InstanceSnapshot } from '../../src/shared/harness/status'
import type { VendorSettingsView } from '../../src/shared/harness/vendorSettings'
import { snapshot } from '../providerSnapshotFixture'

const PATH = '/tmp/fake-home/.claude/settings.json'
const view = (patch: Partial<VendorSettingsView> = {}): VendorSettingsView => ({
  path: PATH,
  shared: true,
  confirmed: false,
  exists: true,
  revision: 'r1',
  entries: [
    { key: 'env.ANTHROPIC_BASE_URL', label: 'API base URL', secret: false, value: 'https://proxy.example.com' },
    { key: 'env.ANTHROPIC_API_KEY', label: 'API key', secret: true, masked: '•••• 1234' }
  ],
  addable: [{ key: 'model', label: 'Default model', secret: false }],
  ...patch
})

const noop = async () => {}
const actions = { configure: noop, enable: noop, install: noop, cancelInstall: noop, update: noop, signIn: noop, signOut: noop, recheck: noop, allowKnownProblem: noop, removeInstall: async () => ({ removed: true }) } as unknown as InstanceActions

describe('Advanced of a Claude Code entry', () => {
  let host: HTMLDivElement
  let root: Root
  let setVendorSetting: ReturnType<typeof vi.fn>
  let vendorSettings: ReturnType<typeof vi.fn>
  const entry: InstanceSnapshot = snapshot({
    config: { home: 'default', args: [], env: {} },
    settingsFile: { path: PATH, shared: true, revision: 1 }
  })
  const settle = async () => {
    for (let round = 0; round < 6; round += 1) await act(async () => { await new Promise((done) => setTimeout(done, 0)) })
  }
  const mount = async () => {
    act(() => root.render(createElement(AgentEditor, { snapshot: entry, status: describeStatus(entry), actions, onSaveModelPrefs: noop, onRefreshModels: noop })))
    await settle()
  }
  // Models folds the same way; Advanced is the last one.
  const advanced = () => [...host.querySelectorAll('.settings-advanced-body')].at(-1)!
  const button = (text: string) => [...document.body.querySelectorAll('button')].find((item) => item.textContent === text)!
  const input = (label: string) => host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!
  const type = (field: HTMLInputElement, value: string) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    act(() => {
      field.focus()
      setter.call(field, value)
      field.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }

  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    // The service answers with the file as written: agreed to, at a new revision.
    setVendorSetting = vi.fn(async (input: { key: string; value: string | null }) => view({ confirmed: true, revision: `r-${input.key}`, entries: view().entries.map((item) => (item.key === input.key && !item.secret ? { ...item, value: input.value ?? '' } : item)) }))
    vendorSettings = vi.fn(async () => view())
    ;(window as unknown as { mousse: unknown }).mousse = {
      platform: 'linux',
      dialog: { pickExecutable: async () => null },
      providers: { instances: { vendorSettings, setVendorSetting } }
    }
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })
  afterEach(() => {
    act(() => root.unmount())
    host.remove()
  })

  it('opens on what can be changed, then the Claude settings, then a closed and dimmed Info with the facts', async () => {
    await mount()
    const sections = [...advanced().children].map((child) => child.getAttribute('data-testid') ?? child.querySelector('.settings-group-title')?.textContent)
    expect(sections).toEqual(['prov-advanced-list', 'Claude settings', 'prov-info'])
    const editable = host.querySelector('[data-testid="prov-advanced-list"]')!.textContent!
    for (const title of ['Display name', 'Executable path', 'Launch arguments', 'Variables']) expect(editable).toContain(title)
    // No read-only fact sits among the editable rows.
    for (const fact of ['Executable in use', 'Account home', '/usr/local/bin/claude', 'set up the way you use it']) expect(advanced().textContent).not.toContain(fact)

    const info = host.querySelector('[data-testid="prov-info"]')!
    expect(info.className).toBe('prov-info')
    const toggle = info.querySelector('button')!
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(info.querySelectorAll('.prov-info-row')).toHaveLength(0)
    await act(async () => { toggle.click() })
    const rows = [...info.querySelectorAll('.prov-info-row')].map((row) => [row.querySelector('dt')!.textContent, row.querySelector('.prov-info-value')!.textContent])
    expect(rows).toEqual(expect.arrayContaining([
      ['Executable', '/usr/local/bin/claude'],
      ['Version', 'v2.1.0'],
      ['Account home', 'Shared with terminal · ~/.claude'],
      ['Settings file', PATH]
    ]))
    // A long path is cut on screen, whole in the tooltip, and can be copied.
    const settingsRow = [...info.querySelectorAll('.prov-info-row')].find((row) => row.textContent?.startsWith('Settings file'))!
    expect(settingsRow.querySelector('dd')!.getAttribute('title')).toBe(PATH)
    expect(settingsRow.querySelector('button[aria-label="Copy settings file"]')).not.toBeNull()
  })

  it('Info is muted until pointed at or focused', () => {
    const css = readFileSync(join(__dirname, '../../src/renderer/styles/providers.css'), 'utf8')
    expect(css).toMatch(/\.prov-info \{[^}]*opacity: 0\.7;/)
    expect(css).toMatch(/\.prov-info:hover,\s*\.prov-info:focus-within \{\s*opacity: 1;/)
  })

  it('shows a key masked, replaces it after asking once about the shared file, and never asks again', async () => {
    await mount()
    expect(advanced().textContent).toContain('•••• 1234')
    act(() => button('Change').click())
    type(input('New API key'), 'sk-ant-new-key-5678')
    await act(async () => { button('Save').click() })
    await settle()
    // The file is the terminal's too: nothing is written before the user agrees.
    expect(document.body.textContent).toContain('This also changes Claude in your terminal.')
    expect(setVendorSetting).not.toHaveBeenCalled()
    await act(async () => { button('Change it').click() })
    await settle()
    expect(setVendorSetting).toHaveBeenCalledWith({ instanceId: 'claude', key: 'env.ANTHROPIC_API_KEY', value: 'sk-ant-new-key-5678', expectedRevision: 'r1', confirmShared: true })
    expect(host.querySelector('input[type="password"]')).toBeNull()

    // The service now holds the answer: a second change goes straight through, without the flag,
    // on the revision the first one wrote.
    const url = input('API base URL')
    type(url, 'https://other.example.com')
    await act(async () => { url.blur() })
    await settle()
    expect(document.body.textContent).not.toContain('This also changes Claude in your terminal.')
    expect(setVendorSetting).toHaveBeenLastCalledWith({ instanceId: 'claude', key: 'env.ANTHROPIC_BASE_URL', value: 'https://other.example.com', expectedRevision: 'r-env.ANTHROPIC_API_KEY' })
  })

  it('a file already agreed to is not asked about', async () => {
    vendorSettings.mockImplementation(async () => view({ confirmed: true }))
    await mount()
    const url = input('API base URL')
    type(url, 'https://other.example.com')
    await act(async () => { url.blur() })
    await settle()
    expect(document.body.textContent).not.toContain('This also changes Claude in your terminal.')
    expect(setVendorSetting).toHaveBeenCalledWith({ instanceId: 'claude', key: 'env.ANTHROPIC_BASE_URL', value: 'https://other.example.com', expectedRevision: 'r1' })
  })

  it('a file changed on disk is refused with "File changed, reload", and Reload reads it again', async () => {
    vendorSettings.mockImplementation(async () => view({ confirmed: true }))
    setVendorSetting.mockImplementation(async () => { throw new Error("Error invoking remote method 'providers:instances:setVendorSetting': Error: File changed, reload.") })
    await mount()
    const url = input('API base URL')
    type(url, 'https://other.example.com')
    await act(async () => { url.blur() })
    await settle()
    expect(advanced().textContent).toContain('File changed, reload.')
    expect(vendorSettings).toHaveBeenCalledTimes(1)
    vendorSettings.mockImplementation(async () => view({ confirmed: true, revision: 'r2', entries: [{ key: 'env.ANTHROPIC_BASE_URL', label: 'API base URL', secret: false, value: 'https://theirs.example.com' }] }))
    await act(async () => { button('Reload').click() })
    await settle()
    expect(vendorSettings).toHaveBeenCalledTimes(2)
    expect(input('API base URL').value).toBe('https://theirs.example.com')
    expect(advanced().textContent).not.toContain('File changed, reload.')
    expect([...document.body.querySelectorAll('button')].some((item) => item.textContent === 'Reload')).toBe(false)
  })

  it('refuses a URL that is not one, without asking the service', async () => {
    vendorSettings.mockImplementation(async () => view({ confirmed: true }))
    await mount()
    const url = input('API base URL')
    type(url, 'proxy dot example')
    await act(async () => { url.blur() })
    await settle()
    expect(advanced().textContent).toContain('Enter a full URL')
    expect(setVendorSetting).not.toHaveBeenCalled()
  })
})
