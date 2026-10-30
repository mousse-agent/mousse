// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { McpServerConfig, SkillDescriptor } from '../src/shared/integrations'
import { MCP_RELAY_RUNTIMES, MOUSSE_BUILTIN_TOOLS } from '../src/shared/integrations'
import { getDefaultSettings, type MousseSettings, type SettingsOptions } from '../src/shared/settings'
import { isIntegrationItemOn } from '../src/renderer/components/integrations/itemState'
import { groupMcpServers, groupSkills, OtherAppsGroup } from '../src/renderer/components/integrations/otherAppsGroup'
import { RelayAvailability, SkillsMcpSettings } from '../src/renderer/components/settings/SkillsMcpSettings'
import { IsolatedIntegrationPlatformClient } from './fixtures/agent-platform/integration-editor-client'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// The themed select renders options only while open; the stub lists them as markup.
vi.mock('../src/renderer/components/ui/Select', () => import('./support/selectStub'))

const options = {
  themes: [], accentColors: [], llmProviders: [],
  agentTypes: [{ id: 'claude-code', label: 'Claude Code', models: [] }]
} as unknown as SettingsOptions

function render(settings: MousseSettings) {
  return renderToStaticMarkup(createElement(SkillsMcpSettings, {
    client: new IsolatedIntegrationPlatformClient(), profileId: 'profile-a', projects: [{ id: 'p1', name: 'Project one' }],
    onProjectChange: () => {}, settings, options, onUpdate: async () => {}
  }))
}

describe('Skills & MCP settings', () => {
  it('shows one page without registry switches, config files or status dots', () => {
    const html = render(getDefaultSettings())
    for (const text of ['Skills', 'MCP servers', 'Web search', 'Exa', 'Parallel', 'Advanced', 'Available to main agent', 'Available to agents', 'Project one']) expect(html).toContain(text)
    for (const text of ['MCP registry', 'Skills registry', 'Config files', 'Expose to orchestrator', 'integration-status-dot', 'integration-card']) expect(html).not.toContain(text)
  })

  it('never shows a built-in tool on while the hidden tools gate is off', () => {
    const settings = getDefaultSettings()
    settings.integrations.tools.enabled = false
    const html = render(settings)
    const id = MOUSSE_BUILTIN_TOOLS[0].id
    expect(html).toMatch(new RegExp(`id="builtin-tool-${id}"[^>]*aria-checked="false"|aria-checked="false"[^>]*id="builtin-tool-${id}"`))
    expect(html).not.toMatch(/id="builtin-tool-[^"]+"[^>]*aria-checked="true"/)
  })

  it('reads an item as on only when installed, selected and its gate is on', () => {
    const integrations = getDefaultSettings().integrations
    const server = { id: 'mousse:one', installationId: 'one', name: 'One', source: 'mousse', scope: 'global', transport: 'http', status: 'configured', enabled: true } as McpServerConfig
    expect(isIntegrationItemOn('mcp', server, integrations)).toBe(false)
    integrations.mcp.enabledServers = ['one']
    expect(isIntegrationItemOn('mcp', server, integrations)).toBe(true)
    integrations.mcp.enabled = false
    expect(isIntegrationItemOn('mcp', server, integrations)).toBe(false)
    const skill = { id: 'global:s', installationId: 's', name: 'S', description: '', source: 'mousse-profile', scope: 'global', enabled: true, isActive: false } as SkillDescriptor
    integrations.skills.enabledSkills = ['s']
    expect(isIntegrationItemOn('skills', skill, integrations)).toBe(false)
  })

  it('shows one row per skill name and keeps other apps in a collapsed group', () => {
    const skill = (id: string, name: string, source: SkillDescriptor['source'], isActive = true) =>
      ({ id, installationId: id, name, description: `${name} help`, source, scope: 'global', isActive, managed: source.startsWith('mousse') && source !== 'mousse-project-external' }) as SkillDescriptor
    const { own, otherApps } = groupSkills([
      skill('own', 'writer', 'mousse-profile'),
      skill('cursor-writer', 'writer', 'cursor-global', false),
      skill('cursor-reg', 'hyperframes-registry', 'cursor-global'),
      skill('claude-reg', 'hyperframes-registry', 'claude-global', false),
      skill('codex-reg', 'Hyperframes-Registry', 'codex-global', false),
      skill('cursor-reg-project', 'hyperframes-registry', 'cursor-project', false),
      skill('codex-image', 'imagegen', 'codex-global')
    ])
    expect(own.map((item) => item.id)).toEqual(['own'])
    expect(otherApps.map(({ id, sources }) => [id, sources])).toEqual([
      ['cursor-reg', ['Cursor', 'Claude Code', 'Codex']],
      ['codex-image', ['Codex']]
    ])

    const collapsed = renderToStaticMarkup(createElement(OtherAppsGroup, { kind: 'skills', rows: otherApps }))
    expect(collapsed).toContain('From other apps · 2')
    expect(collapsed).toContain('aria-expanded="false"')
    expect(collapsed).not.toContain('hyperframes-registry')
    const open = renderToStaticMarkup(createElement(OtherAppsGroup, { kind: 'skills', rows: otherApps, defaultOpen: true }))
    expect(open.match(/data-skill-card=/g)).toHaveLength(2)
    expect(open).toContain('Cursor, Claude Code, Codex · hyperframes-registry help')
    for (const text of ['Read-only', 'Hidden by another skill', 'role="switch"']) expect(open).not.toContain(text)
  })

  it('shows one row per MCP server name and keeps other apps in a collapsed group', () => {
    const server = (id: string, name: string, source: McpServerConfig['source'], extra: Partial<McpServerConfig>) =>
      ({ id, installationId: id, name, source, scope: 'global', status: 'configured', enabled: true, managed: source === 'mousse', ...extra }) as McpServerConfig
    const stdio = { transport: 'stdio', command: 'npx', args: ['-y', 'fs-server'] } as const
    // Daemon order: project configs rank Cursor, then Claude Code, then Codex.
    const { own, otherApps } = groupMcpServers([
      server('own-github', 'github', 'mousse', { transport: 'http', url: 'https://api.github.com/mcp' }),
      server('cursor-github', 'GitHub', 'cursor-project', { transport: 'http', url: 'https://example.com/gh' }),
      server('cursor-fs', 'filesystem', 'cursor-project', stdio),
      server('claude-fs', 'Filesystem', 'claude-project', { transport: 'stdio', command: 'node', args: ['fs.js'] }),
      server('codex-linear', 'linear', 'codex-project', { transport: 'http', url: 'https://mcp.linear.app/mcp' })
    ])
    expect(own.map((item) => item.id)).toEqual(['own-github'])
    expect(otherApps.map(({ id, sources }) => [id, sources])).toEqual([
      ['cursor-fs', ['Cursor', 'Claude Code']],
      ['codex-linear', ['Codex']]
    ])

    const collapsed = renderToStaticMarkup(createElement(OtherAppsGroup, { kind: 'mcp', rows: otherApps }))
    expect(collapsed).toContain('From other apps · 2')
    expect(collapsed).toContain('aria-expanded="false"')
    expect(collapsed).not.toContain('filesystem')
    const open = renderToStaticMarkup(createElement(OtherAppsGroup, { kind: 'mcp', rows: otherApps, defaultOpen: true }))
    expect(open.match(/data-mcp-card=/g)).toHaveLength(2)
    expect(open).toContain('Cursor, Claude Code · npx -y fs-server')
    expect(open).toContain('Codex · https://mcp.linear.app/mcp')
    for (const text of ['Read-only', 'role="switch"', 'More actions']) expect(open).not.toContain(text)
  })

  it('shares the MCP servers with every other runtime by default', () => {
    const html = render(getDefaultSettings())
    expect(html).toContain('Share with other agents')
    expect(html).toContain('mousse-relay')
    for (const label of ['Claude Code', 'Codex', 'Cursor', 'ACP agents', 'Antigravity', 'Grok']) expect(html).toContain(`Share MCP servers with ${label}`)
    for (const runtime of MCP_RELAY_RUNTIMES) {
      expect(html).toMatch(new RegExp(`id="mcp-relay-${runtime}"[^>]*aria-checked="true"|aria-checked="true"[^>]*id="mcp-relay-${runtime}"`))
    }
  })

  it('turns the relay off for one runtime and leaves the others alone', async () => {
    const settings = getDefaultSettings()
    settings.integrations.mcp.relay = { runtimes: { grok: false } }
    const onUpdate = vi.fn(async () => {})
    const host = document.createElement('div')
    const root = createRoot(host)
    await act(async () => { root.render(createElement(RelayAvailability, { settings, onUpdate })) })
    const toggle = (runtime: string) => host.querySelector<HTMLButtonElement>(`#mcp-relay-${runtime}`)!
    expect(toggle('grok').getAttribute('aria-checked')).toBe('false')
    expect(toggle('codex').getAttribute('aria-checked')).toBe('true')
    await act(async () => { toggle('codex').click() })
    expect(onUpdate).toHaveBeenCalledWith({ integrations: { mcp: { relay: { runtimes: { codex: false } } } } })
    await act(async () => { toggle('grok').click() })
    expect(onUpdate).toHaveBeenLastCalledWith({ integrations: { mcp: { relay: { runtimes: { grok: true } } } } })
    act(() => root.unmount())
  })

  it('disables sharing while MCP is off', () => {
    const settings = getDefaultSettings()
    settings.integrations.mcp.enabled = false
    const html = render(settings)
    for (const runtime of MCP_RELAY_RUNTIMES) {
      const control = html.match(new RegExp(`<button[^>]*id="mcp-relay-${runtime}"[^>]*>`))?.[0] ?? ''
      expect(control).toContain('disabled=""')
      expect(control).toContain('aria-checked="false"')
    }
  })
})
