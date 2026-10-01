import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AGENT_BUNDLE_MAX_BYTES, defaultAgentSettings } from '../src/shared/agents/defaults'
import { collectEditorIssues } from '../src/renderer/components/agentDefinitions/editorIssues'
import { shouldApplyAsyncResult, createAsyncGate } from '../src/renderer/components/agentDefinitions/asyncGate'
import { parseAgentImportFile } from '../src/renderer/components/agentDefinitions/importBundle'
import {
  filterAgentLibrary,
  publicationState,
  type AgentLibraryQuery
} from '../src/renderer/components/agentDefinitions/libraryFilter'
import { AgentsLibrary } from '../src/renderer/components/agentDefinitions/AgentsLibrary'
import type { AgentEditorCatalogs, AgentLibraryItem } from '../src/renderer/components/agentDefinitions/client'
import { IsolatedAgentDefinitionsClient } from './fixtures/agent-platform/agent-editor-client'
import { settingUnsupportedReason } from '../src/renderer/components/agentDefinitions/editorIssues'

const css = readFileSync(new URL('../src/renderer/components/agentDefinitions/agentDefinitions.css', import.meta.url), 'utf8')

const catalogs: AgentEditorCatalogs = {
  providers: [{ id: 'xai', label: 'xAI', models: [{ id: 'grok-4', label: 'Grok 4' }] }],
  skills: [],
  mcpServers: [],
  builtinTools: [],
  childDefinitions: [],
  browserWorkspaces: []
}

function item(overrides: Partial<AgentLibraryItem> & Pick<AgentLibraryItem, 'id' | 'name'>): AgentLibraryItem {
  return {
    profileId: 'profile-a',
    runtimeKind: 'mousse',
    slug: overrides.name.toLowerCase().replace(/\s+/g, '-'),
    purpose: '',
    tags: [],
    enabled: true,
    favorite: false,
    archived: false,
    draftHash: 'd1',
    semanticHash: 's1',
    visualHash: 'v1',
    updatedAt: '2026-01-02T00:00:00.000Z',
    ...overrides
  }
}

describe('library filter and sort', () => {
  const items = [
    item({ id: '1', name: 'Research', tags: ['docs'], favorite: true, modelLabel: 'xai/grok-4', updatedAt: '2026-01-02T00:00:00.000Z' }),
    item({ id: '2', name: 'Coder', tags: ['code'], runtimeKind: 'codex', updatedAt: '2026-01-03T00:00:00.000Z', lastRunAt: '2026-01-04T00:00:00.000Z' })
  ]
  const base: AgentLibraryQuery = {
    search: '',
    tag: '',
    runtime: 'all',
    model: '',
    favoritesOnly: false,
    sort: 'name'
  }

  it('searches, filters favorites/runtime/tags, and sorts', () => {
    expect(filterAgentLibrary(items, { ...base, search: 'research' }).map((entry) => entry.id)).toEqual(['1'])
    expect(filterAgentLibrary(items, { ...base, favoritesOnly: true }).map((entry) => entry.id)).toEqual(['1'])
    expect(filterAgentLibrary(items, { ...base, runtime: 'codex' }).map((entry) => entry.id)).toEqual(['2'])
    expect(filterAgentLibrary(items, { ...base, tag: 'code' }).map((entry) => entry.id)).toEqual(['2'])
    expect(filterAgentLibrary(items, { ...base, sort: 'updated' }).map((entry) => entry.id)).toEqual(['2', '1'])
    expect(filterAgentLibrary(items, { ...base, sort: 'lastRun' }).map((entry) => entry.id)).toEqual(['2', '1'])
  })

  it('labels draft versus published', () => {
    expect(publicationState(item({ id: '1', name: 'A' }))).toBe('draft')
    expect(publicationState(item({ id: '1', name: 'A', publishedRevision: 's1' }))).toBe('published')
    expect(publicationState(item({ id: '1', name: 'A', publishedRevision: 'old' }))).toBe('unpublished-changes')
  })
})

describe('import shape/size gate', () => {
  it('rejects oversized or non-bundle JSON before the port is called', () => {
    expect(() =>
      parseAgentImportFile({ name: 'x.json', size: 12, text: '{not json' })
    ).toThrow(/not valid JSON/)
    expect(() =>
      parseAgentImportFile({ name: 'x.json', size: AGENT_BUNDLE_MAX_BYTES + 1, text: '{}' })
    ).toThrow(/larger than/)
    expect(() =>
      parseAgentImportFile({ name: 'x.json', size: 2, text: '{}' })
    ).toThrow(/mousse-agent/)
  })
})

describe('stale async guard', () => {
  it('drops results from a previous profile/definition generation', () => {
    const gate = createAsyncGate()
    const first = gate.bump()
    const second = gate.bump()
    expect(shouldApplyAsyncResult(first, gate.current())).toBe(false)
    expect(shouldApplyAsyncResult(second, gate.current())).toBe(true)
  })
})

describe('validation and compatibility', () => {
  it('keeps an unavailable selected model visible and blocks publish/run', () => {
    const settings = defaultAgentSettings({ name: 'A', slug: 'a' })
    settings.primaryModel.ref = { providerId: 'xai', modelId: 'removed-model' }
    const issues = collectEditorIssues({ runtimeKind: 'mousse', settings, catalogs })
    expect(issues.some((issue) => issue.message.includes('removed-model'))).toBe(true)
    expect(issues.some((issue) => issue.blocking)).toBe(true)
  })

  it('disables unsupported CLI settings with a precise reason', () => {
    const reason = settingUnsupportedReason('codex', '/settings/browser')
    expect(reason).toMatch(/codex does not support/i)
    expect(settingUnsupportedReason('mousse', '/settings/browser')).toBeNull()
  })
})

describe('isolated client conflicts and honesty', () => {
  it('rejects stale draft hashes and does not fake try-run success', async () => {
    const client = new IsolatedAgentDefinitionsClient()
    const created = await client.create({
      profileId: 'p',
      settings: { identity: { name: 'A', slug: 'a', purpose: '', tags: [] } }
    })
    await client.saveDraft({
      profileId: 'p',
      id: created.id,
      expectedDraftHash: created.draftHash,
      systemPrompt: 'v2'
    })
    await expect(
      client.saveDraft({
        profileId: 'p',
        id: created.id,
        expectedDraftHash: created.draftHash,
        systemPrompt: 'v3'
      })
    ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })

    const run = await client.tryRun({ profileId: 'p', id: created.id, prompt: 'hello' })
    expect(run.ok).toBe(false)
    expect(run.status).toBe('blocked')
    expect(run.summary).toMatch(/does not execute a model|Choose a model/)
  })
})

describe('library static rendering', () => {
  it('renders New agent and a loading state on first paint, not dummy cards', () => {
    const pending = new IsolatedAgentDefinitionsClient()
    pending.list = () => new Promise(() => undefined)
    const loading = renderToStaticMarkup(
      createElement(AgentsLibrary, {
        profileId: 'p',
        client: pending,
        onOpen: () => undefined
      })
    )
    expect(loading).toContain('New agent')
    expect(loading).toContain('Loading agents')
    expect(loading).not.toContain('data-agent-card')
  })
})

describe('editor layout contract', () => {
  it('uses a true 50/50 desktop split and stacked narrow layout', () => {
    expect(css).toMatch(/grid-template-columns:\s*1fr 1fr/)
    expect(css).toMatch(/@media \(max-width:\s*1099px\)/)
    expect(css).toMatch(/overflow-y:\s*auto/)
    expect(css).toContain('.agent-editor__identity')
    expect(css).toContain('.agent-editor__settings')
  })
})
