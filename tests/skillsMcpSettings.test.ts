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
import { SETTINGS_SEARCH_INDEX, searchSettings } from '../src/renderer/lib/settingsSearch'
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
    for (const text of ['Skills', 'MCP servers', 'Web search', 'Exa', 'Parallel', 'Who can use them', 'Share MCP servers', 'Built-in tools', 'Project one']) expect(html).toContain(text)
    for (const text of ['MCP registry', 'Skills registry', 'Config files', 'Expose to orchestrator', 'integration-status-dot', 'integration-card']) expect(html).not.toContain(text)
  })

  it('describes web search in plain words, not by its tool name', () => {
    const html = render(getDefaultSettings())
    expect(html).toContain('Optional API keys that let agents search the web')
    expect(html).not.toContain('for the web_search tool')
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
    expect(html).toContain('Other agents reach the servers that are on through Mousse.')
    // Where the tools come from, and why they can show twice, is one Details away.
    expect(html).toMatch(/<button[^>]*class="settings-more-btn"[^>]*aria-expanded="false"[^>]*>Details<\/button><span[^>]*hidden=""[^>]*>[^<]*mousse-relay[^<]*appear twice/)
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

  it('gives each agent a labelled switch for skills and one for MCP servers', async () => {
    const settings = getDefaultSettings()
    settings.integrations.skills.enableForAgents = { 'claude-code': true } as never
    settings.integrations.mcp.enableForAgents = {} as never
    const onUpdate = vi.fn(async () => {})
    ;(window as unknown as { mousse: unknown }).mousse = {
      webTools: { getCredentialStatus: async () => ({ exa: false, parallel: false }) },
      settings: { get: async () => settings }
    }
    const host = document.createElement('div')
    const root = createRoot(host)
    await act(async () => {
      root.render(createElement(SkillsMcpSettings, {
        client: new IsolatedIntegrationPlatformClient(), profileId: 'profile-a', projects: [], onProjectChange: () => {}, settings, options, onUpdate
      }))
    })
    const skills = host.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Skills available to Claude Code"]')!
    const mcp = host.querySelector<HTMLButtonElement>('[role="switch"][aria-label="MCP servers available to Claude Code"]')!
    expect(skills.getAttribute('aria-checked')).toBe('true')
    expect(mcp.getAttribute('aria-checked')).toBe('false')
    // One row per agent: its name, then the two switches under the Skills and MCP column labels.
    const row = skills.closest('.settings-item')!
    expect(row.querySelector('.settings-item-title')?.textContent).toBe('Claude Code')
    expect(mcp.closest('.settings-item')).toBe(row)
    expect(host.querySelector('.skills-mcp-access-labels')?.textContent).toBe('SkillsMCP')
    expect(host.querySelectorAll('.skills-mcp-access-group .settings-item')).toHaveLength(1 + options.agentTypes.length)
    expect(host.querySelector('[aria-pressed]')).toBeNull()
    await act(async () => { mcp.click() })
    expect(onUpdate).toHaveBeenCalledWith({ integrations: { mcp: { enableForAgents: { 'claude-code': true } } } })
    await act(async () => { skills.click() })
    expect(onUpdate).toHaveBeenLastCalledWith({ integrations: { skills: { enableForAgents: { 'claude-code': false } } } })
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

  it('folds Advanced into three folds, with a count on each closed tool group and the web tools under Web search', () => {
    const settings = getDefaultSettings()
    settings.integrations.tools.enabled = true
    settings.integrations.tools.enabledTools = ['read', 'bash']
    const html = render(settings)
    expect(html).not.toContain('>Advanced<')
    const folds = [...html.matchAll(/<details class="settings-fold( sub)?[^"]*"><summary data-settings-anchor="([^"]+)"/g)].map((match) => match[2])
    expect(folds.slice(0, 3)).toEqual(['integrations-access', 'integrations-share', 'integrations-tools'])
    expect(folds).toContain('integrations-tools-project')
    expect(folds).not.toContain('integrations-tools-web')
    const total = MOUSSE_BUILTIN_TOOLS.filter((tool) => tool.group === 'project').length
    expect(html).toContain(`<span class="settings-fold-count">2 of ${total} on</span>`)
    // web_search and web_fetch sit in the Web search group, after the keys, and nowhere else.
    const web = html.slice(html.indexOf('data-settings-anchor="integrations-web-search"'), html.indexOf('data-settings-anchor="integrations-access"'))
    for (const id of ['web_search', 'web_fetch']) {
      expect(web).toContain(`id="builtin-tool-${id}"`)
      expect(html.match(new RegExp(`id="builtin-tool-${id}"`, 'g'))).toHaveLength(1)
    }
    expect(web.indexOf('web-search-key-parallel')).toBeLessThan(web.indexOf('builtin-tool-web_search'))
  })

  it('turns a web tool on from the Web search group and turns the tools gate back on', async () => {
    const settings = getDefaultSettings()
    settings.integrations.tools.enabled = false
    settings.integrations.tools.enabledTools = ['read']
    const onUpdate = vi.fn(async () => {})
    ;(window as unknown as { mousse: unknown }).mousse = {
      webTools: { getCredentialStatus: async () => ({ exa: false, parallel: false }) },
      settings: { get: async () => settings }
    }
    const host = document.createElement('div')
    const root = createRoot(host)
    await act(async () => {
      root.render(createElement(SkillsMcpSettings, {
        client: new IsolatedIntegrationPlatformClient(), profileId: 'profile-a', projects: [], onProjectChange: () => {}, settings, options, onUpdate
      }))
    })
    const fetch = host.querySelector<HTMLButtonElement>('#builtin-tool-web_fetch')!
    expect(fetch.getAttribute('aria-checked')).toBe('false')
    await act(async () => { fetch.click() })
    expect(onUpdate).toHaveBeenCalledWith({ integrations: { tools: { enabled: true, enabledTools: ['read', 'web_fetch'] } } })
    act(() => root.unmount())
  })

  it('lands a search for a tool, a fold or a web search key on its place on the page', () => {
    const html = render(getDefaultSettings())
    for (const entry of SETTINGS_SEARCH_INDEX.filter((item) => item.section === 'integrations' && item.anchor !== 'integrations-skills' && item.anchor !== 'integrations-mcp')) {
      expect(html, entry.anchor).toContain(`data-settings-anchor="${entry.anchor}"`)
    }
    const pages = [{ id: 'integrations' as const, label: 'Skills & MCP', keywords: [] }]
    const first = (query: string) => searchSettings(query, pages)[0]?.anchor
    expect(first('bash')).toBe('integrations-tools-project')
    expect(first('edit')).toBe('integrations-tools-project')
    expect(first('browser')).toBe('integrations-tools-browser')
    expect(first('web fetch')).toBe('integrations-tool-web-fetch')
    expect(first('exa')).toBe('integrations-web-exa')
    expect(first('parallel')).toBe('integrations-web-parallel')
    expect(first('who can use')).toBe('integrations-access')
    expect(first('relay')).toBe('integrations-share')
  })
})
