import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { describeStatus } from '../src/shared/harness/status'
import type { RegistryAgentView } from '../src/shared/harness/types'
import { addChoices } from '../src/renderer/components/providers/AddProviderDialog'
import type { InstanceActions } from '../src/renderer/components/providers/CliSections'
import { AgentEditor } from '../src/renderer/components/providers/ProviderEditor'
import { RegistryAgentRows, RegistryConfirmStep, RemoveProviderDialog } from '../src/renderer/components/providers/RegistryAgents'
import {
  UNVERIFIED_NOTE,
  checksumLabel,
  distributionLabel,
  formatMegabytes,
  registryAgentMeta,
  registrySourceLabel,
  registrySourceOf,
  registryUpdateOf,
  usedByLabel
} from '../src/renderer/components/providers/providerView'
import { snapshot } from './providerSnapshotFixture'

const noop = async () => undefined
const actions: InstanceActions = {
  enable: noop, install: noop, cancelInstall: noop, update: noop, signIn: noop, signOut: noop, recheck: noop, configure: noop,
  removeInstall: async () => ({ removed: true, bytes: 0 })
}
const buttons = (html: string) =>
  [...html.matchAll(/<button[^>]*>(.*?)<\/button>/g)].map((match) => match[1].replace(/<[^>]+>/g, '').trim()).filter(Boolean)
const unescape = (html: string) => html.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&')

function agent(patch: Partial<RegistryAgentView> = {}): RegistryAgentView {
  return {
    id: 'gemini',
    name: 'Gemini CLI',
    version: '1.2.0',
    description: 'Google Gemini in your terminal',
    authors: ['Google'],
    license: 'Apache-2.0',
    distribution: 'binary',
    checksum: 'registry',
    artifactUrl: 'https://example.com/gemini-1.2.0.tar.gz',
    args: ['--acp'],
    env: { GEMINI_MODE: 'acp' },
    ...patch
  }
}

describe('Add provider: More ACP agents', () => {
  it('offers the registry beside Custom command, in Agents, with the generic ACP logo', () => {
    const choices = addChoices([snapshot()], [])
    expect(choices.find((choice) => choice.kind === 'registry')).toEqual({
      kind: 'registry', key: 'registry:acp', label: 'More ACP agents…', iconId: 'acp', group: 'Agents', driver: 'acp'
    })
  })

  it('keeps offering the registry when registry agents are already added', () => {
    const added = snapshot({ instanceId: 'acp:gemini', driver: 'acp', displayName: 'Gemini CLI' })
    expect(addChoices([snapshot(), added], []).filter((choice) => choice.kind === 'registry')).toHaveLength(1)
  })
})

describe('registry agent labels', () => {
  it('names the checksum and the distribution exactly', () => {
    expect(checksumLabel('registry')).toBe('Registry checksum checked')
    expect(checksumLabel('none')).toBe('No registry checksum')
    expect(distributionLabel('binary')).toBe('Binary download')
    expect(distributionLabel('npx')).toBe('npm package')
    expect(distributionLabel('uvx')).toBe('Python (uvx)')
  })

  it('sums a row up as licence, distribution and checksum', () => {
    expect(registryAgentMeta(agent())).toBe('Apache-2.0 · Binary download · Registry checksum checked')
    expect(registryAgentMeta(agent({ license: undefined, distribution: 'npx' }))).toBe('npm package · Registry checksum checked')
  })

  it('says where a registry entry comes from', () => {
    expect(registrySourceLabel({ agentId: 'gemini', version: '1.2.0' })).toBe('ACP registry · gemini v1.2.0')
  })

  it('formats megabytes like the downloads indicator, at least 1', () => {
    expect(formatMegabytes(0)).toBe('1 MB')
    expect(formatMegabytes(1_400_000)).toBe('1 MB')
    expect(formatMegabytes(136_500_000)).toBe('137 MB')
  })

  it('names a profile by its name, else its id, with its entry count', () => {
    expect(usedByLabel({ profileId: 'p1', profileName: 'Work', entries: 1 })).toBe('Work (1 entry)')
    expect(usedByLabel({ profileId: 'p2', entries: 3 })).toBe('p2 (3 entries)')
  })
})

describe('registry source', () => {
  it('adds a checked download without consent', () => {
    expect(registrySourceOf(agent())).toEqual({ kind: 'registry', agentId: 'gemini', version: '1.2.0', distribution: 'binary' })
  })

  it('records consent for exactly this version and URL when the download has no checksum', () => {
    expect(registrySourceOf(agent({ checksum: 'none' }))).toEqual({
      kind: 'registry', agentId: 'gemini', version: '1.2.0', distribution: 'binary',
      consent: { version: '1.2.0', artifactUrl: 'https://example.com/gemini-1.2.0.tar.gz' }
    })
  })

  it('adds an npm package as npx, and nothing Mousse cannot install', () => {
    expect(registrySourceOf(agent({ distribution: 'npx', artifactUrl: undefined, package: 'gemini@1.2.0' }))).toEqual({
      kind: 'registry', agentId: 'gemini', version: '1.2.0', distribution: 'npx'
    })
    expect(registrySourceOf(agent({ distribution: 'uvx', checksum: 'none', unsupported: 'Python (uvx) agents are not supported yet.' }))).toBeUndefined()
    expect(registrySourceOf(agent({ unsupported: 'Mousse installs zip and tar.gz downloads only.' }))).toBeUndefined()
  })

  it('offers an update only for the exact agent at another installable version', () => {
    const installed = { agentId: 'gemini', version: '1.2.0' }
    expect(registryUpdateOf(installed, [agent({ id: 'gemini-pro', version: '2.0.0' })])).toBeUndefined()
    expect(registryUpdateOf(installed, [agent()])).toBeUndefined()
    expect(registryUpdateOf(installed, [agent({ version: '1.3.0', unsupported: 'No build for this computer.' })])).toBeUndefined()
    expect(registryUpdateOf(installed, [agent({ id: 'gemini-pro', version: '2.0.0' }), agent({ version: '1.3.0' })])?.version).toBe('1.3.0')
  })
})

describe('registry list and confirm panel', () => {
  it('lists name, version, licence, distribution and checksum; an unsupported agent is disabled with its reason', () => {
    const html = renderToStaticMarkup(createElement(RegistryAgentRows, {
      agents: [agent(), agent({ id: 'py', name: 'Py Agent', distribution: 'uvx', checksum: 'none', unsupported: 'Python (uvx) agents are not supported yet.' })],
      iconId: 'acp',
      selectedId: null,
      disabled: false,
      onSelect: () => undefined
    }))
    expect(html).toContain('Gemini CLI')
    expect(html).toContain('v1.2.0')
    expect(html).toContain('Apache-2.0 · Binary download · Registry checksum checked')
    expect(html).toContain('Python (uvx) · No registry checksum')
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>(?:(?!<\/button>).)*Py Agent/)
    expect(html).toContain('Python (uvx) agents are not supported yet.')
    expect(html).not.toMatch(/<img/)
  })

  const confirm = (view: RegistryAgentView) =>
    unescape(renderToStaticMarkup(createElement(RegistryConfirmStep, { agent: view, busy: false, disabled: false, error: null, onConfirm: () => undefined })))

  it('shows what a checked agent downloads and starts with, ready to add', () => {
    const html = confirm(agent())
    expect(html).toContain('https://example.com/gemini-1.2.0.tar.gz')
    expect(html).toContain('--acp')
    expect(html).toContain('GEMINI_MODE=acp')
    expect(html).toContain('Registry checksum checked')
    expect(html).not.toContain(UNVERIFIED_NOTE)
    expect(html).not.toContain('type="checkbox"')
    expect(html).toMatch(/<button type="button" class="settings-btn">Add and install<\/button>/)
  })

  it('warns about an unverified download and waits for the explicit yes', () => {
    const html = confirm(agent({ checksum: 'none' }))
    expect(html).toContain('No registry checksum')
    expect(html).toContain("Mousse cannot verify this download. It records the files' fingerprints and refuses to run them if they change.")
    expect(html).toContain('type="checkbox"')
    expect(html).toMatch(/<button type="button" class="settings-btn" disabled="">Add and install<\/button>/)
  })

  it('shows the npm package of an npx agent', () => {
    const html = confirm(agent({ distribution: 'npx', artifactUrl: undefined, package: '@google/gemini-cli@1.2.0', args: [], env: {} }))
    expect(html).toContain('npm package')
    expect(html).toContain('@google/gemini-cli@1.2.0')
  })
})

describe('registry entry editor', () => {
  const entry = snapshot({
    instanceId: 'acp:gemini',
    driver: 'acp',
    displayName: 'Gemini CLI',
    builtIn: false,
    install: { state: 'installed', canInstall: true, downloaded: { bytes: 136_500_000 }, checksum: 'none', advisory: 'The registry changed how this version starts.' },
    config: { home: 'default', args: [], env: {}, source: { kind: 'registry', agentId: 'gemini', version: '1.2.0', distribution: 'binary' } }
  })
  const editor = (value = entry) =>
    unescape(renderToStaticMarkup(createElement(AgentEditor, {
      snapshot: value, status: describeStatus(value), actions, onRemove: noop, onSaveModelPrefs: noop, onRefreshModels: noop
    })))

  it('shows the registry source, checksum label and advisory', () => {
    const html = editor()
    expect(html).toContain('ACP registry · gemini v1.2.0 · No registry checksum')
    expect(html).toContain('The registry changed how this version starts.')
  })

  it('offers to delete the downloaded files with their size', () => {
    expect(buttons(editor())).toContain('Delete downloaded files (137 MB)')
  })

  it('shows neither for an entry started from a command', () => {
    const custom = snapshot({ instanceId: 'acp:grok', driver: 'acp', displayName: 'grok', config: { home: 'default', args: [], env: {} } })
    const html = editor(custom)
    expect(html).not.toContain('ACP registry')
    expect(html).not.toContain('Delete downloaded files')
  })

  it('reports changed files as a broken install with Reinstall', () => {
    const broken = snapshot({ ...entry, install: { ...entry.install, state: 'broken' }, runs: { state: 'no', failure: 'files_changed', message: 'Installed files changed since install (bin/gemini).' } })
    const html = editor(broken)
    expect(html).toContain('Install is broken')
    expect(buttons(html)).toContain('Reinstall')
  })

  it('asks on remove whether to delete the downloaded files, unticked by default', () => {
    const html = renderToStaticMarkup(createElement(RemoveProviderDialog, { snapshot: entry, bytes: 136_500_000, onRemove: noop, onClose: () => undefined }))
    expect(html).toContain('Delete downloaded files (137 MB)')
    expect(html).toMatch(/<input type="checkbox"\/>/)
    expect(buttons(html)).toEqual(expect.arrayContaining(['Cancel', 'Remove']))
  })
})
