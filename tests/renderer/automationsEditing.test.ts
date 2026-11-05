// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentEditor, matchesPublished } from '../../src/renderer/components/agentDefinitions/AgentEditor'
import { AgentsLibrary } from '../../src/renderer/components/agentDefinitions/AgentsLibrary'
import type { AgentEditorCatalogs, AgentLibraryItem } from '../../src/renderer/components/agentDefinitions/client'
import { isLibraryFiltered, uniqueLibraryRuntimes, EMPTY_LIBRARY_QUERY } from '../../src/renderer/components/agentDefinitions/libraryFilter'
import { ArchiveDefinitionDialog } from '../../src/renderer/components/automations/EditorParts'
import { RefreshToolsButton } from '../../src/renderer/components/automations/LibraryParts'
import { definitionSaveState, fixIssuesLabel, publishBlockReason, SAVE_STATE_LABELS } from '../../src/renderer/components/automations/editorState'
import { WorkflowLibrary } from '../../src/renderer/components/workflows/WorkflowLibrary'
import type { WorkflowDefinitionsClient, WorkflowLibraryItem } from '../../src/renderer/components/workflows/client'
import { uniqueWorkflowStatuses } from '../../src/renderer/components/workflows/libraryFilter'
import { IsolatedAgentDefinitionsClient } from '../fixtures/agent-platform/agent-editor-client'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// The orb preview draws on a canvas jsdom does not have; the editor's header is what these tests read.
vi.mock('../../src/renderer/components/orb/OrbAppearanceEditor', () => ({ OrbAppearanceEditor: () => null }))

let root: Root
let host: HTMLElement

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  window.matchMedia ??= ((query: string) => ({ matches: true, media: query, addEventListener: () => {}, removeEventListener: () => {} })) as unknown as typeof window.matchMedia
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const buttons = () => [...document.querySelectorAll<HTMLButtonElement>('button')]
const button = (text: string) => buttons().find((item) => item.textContent?.trim() === text)
const flush = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) }) }
const escape = () => act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })

const catalogs: AgentEditorCatalogs = {
  providers: [{ id: 'xai', label: 'xAI', models: [{ id: 'grok-4', label: 'Grok 4' }] }],
  skills: [],
  mcpServers: [],
  builtinTools: [],
  childDefinitions: [],
  browserWorkspaces: []
}

function agentItem(overrides: Partial<AgentLibraryItem> & Pick<AgentLibraryItem, 'id' | 'name'>): AgentLibraryItem {
  return {
    profileId: 'p',
    runtimeKind: 'mousse',
    slug: overrides.name.toLowerCase(),
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

const agentClient = (items: AgentLibraryItem[]) => {
  const client = new IsolatedAgentDefinitionsClient()
  client.list = async () => items
  return client
}

describe('editor state words', () => {
  it('names the four states: unsaved edits win, then never published, then published or not', () => {
    expect(definitionSaveState({ dirty: true, matchesPublished: true })).toBe('unsaved')
    expect(definitionSaveState({ dirty: false, matchesPublished: null })).toBe('draft')
    expect(definitionSaveState({ dirty: false, matchesPublished: false })).toBe('unpublished')
    expect(definitionSaveState({ dirty: false, matchesPublished: true })).toBe('published')
    expect(Object.values(SAVE_STATE_LABELS)).toEqual(['Unsaved edits', 'Draft saved', 'Unpublished changes', 'Published'])
  })

  it('gives one reason for a disabled Publish, and none while it can publish or is busy', () => {
    const issue = { message: 'Choose a model before publishing or running.' }
    expect(publishBlockReason({ state: 'unsaved', blocking: [issue] })).toBe('Save the draft to publish it.')
    expect(publishBlockReason({ state: 'draft', blocking: [issue] })).toBe(issue.message)
    expect(publishBlockReason({ state: 'draft', blocking: [], checking: true })).toBe('Checking where it runs…')
    expect(publishBlockReason({ state: 'draft', blocking: [], readOnly: true })).toBe('Open the draft to publish.')
    expect(publishBlockReason({ state: 'draft', blocking: [], invalidSource: true })).toBe('Fix the source to publish.')
    expect(publishBlockReason({ state: 'draft', blocking: [] })).toBeNull()
    expect(publishBlockReason({ state: 'unsaved', blocking: [issue], busy: true })).toBeNull()
    expect(fixIssuesLabel(1)).toBe('Fix 1 issue to publish')
    expect(fixIssuesLabel(3)).toBe('Fix 3 issues to publish')
  })

  it('an agent matches its publication only by both hashes and as a Mousse definition', () => {
    const published = { revision: 's1', visualRevision: 'v1', publishedAt: 'now', dependencyHashes: {} }
    expect(matchesPublished({ runtimeKind: 'mousse', semanticHash: 's1', visualHash: 'v1' })).toBeNull()
    expect(matchesPublished({ runtimeKind: 'mousse', semanticHash: 's1', visualHash: 'v1', published })).toBe(true)
    expect(matchesPublished({ runtimeKind: 'mousse', semanticHash: 's2', visualHash: 'v1', published })).toBe(false)
    expect(matchesPublished({ runtimeKind: 'mousse', semanticHash: 's1', visualHash: 'v2', published })).toBe(false)
    expect(matchesPublished({ runtimeKind: 'codex', semanticHash: 's1', visualHash: 'v1', published })).toBe(false)
  })
})

describe('libraries', () => {
  it('an empty agents library shows one line, one New agent, Import, and no filters', async () => {
    await act(async () => root.render(createElement(AgentsLibrary, { profileId: 'p', client: agentClient([]), onOpen: () => {}, onRefreshTools: () => {} })))
    await flush()
    expect(document.querySelector('[data-library-empty]')?.textContent).toBe('No agents yet.')
    expect(buttons().filter((item) => item.textContent?.includes('New agent'))).toHaveLength(1)
    expect(document.querySelector('[aria-label="Import agent"]')).not.toBeNull()
    expect(document.querySelector('.agent-library-toolbar')).toBeNull()
    expect(document.querySelector('h2')?.textContent).toBe('Agents')
    expect(document.querySelector('h1')).toBeNull()
  })

  it('agents filters offer only what the library holds; search stays', async () => {
    const items = [agentItem({ id: '1', name: 'Alpha' }), agentItem({ id: '2', name: 'Beta', tags: ['docs'] })]
    await act(async () => root.render(createElement(AgentsLibrary, { profileId: 'p', client: agentClient(items), onOpen: () => {} })))
    await flush()
    expect(document.querySelector('input[placeholder="Search agents"]')).not.toBeNull()
    expect(document.querySelector('[aria-label="Filter by tag"]')).not.toBeNull()
    // One runtime and no models: nothing to choose between.
    expect(document.querySelector('[aria-label="Filter by runtime"]')).toBeNull()
    expect(document.querySelector('[aria-label="Filter by model"]')).toBeNull()
    expect(button('Favorites')).toBeUndefined()
    expect(document.querySelector('[aria-label="Sort agents"]')).not.toBeNull()
    expect(document.querySelectorAll('select')).toHaveLength(0)
    expect(uniqueLibraryRuntimes([...items, agentItem({ id: '3', name: 'C', runtimeKind: 'codex' })])).toEqual(['mousse', 'codex'])
  })

  it('a search with no match keeps the toolbar and offers Clear filters, which keeps the sort', async () => {
    const onQueryChange = vi.fn()
    const items = [agentItem({ id: '1', name: 'Alpha' })]
    const query = { ...EMPTY_LIBRARY_QUERY, search: 'zzz', sort: 'name' as const }
    await act(async () => root.render(createElement(AgentsLibrary, { profileId: 'p', client: agentClient(items), query, onQueryChange, onOpen: () => {} })))
    await flush()
    expect(document.querySelector('[data-library-no-match]')?.textContent).toContain('No agents match.')
    expect(document.querySelector('.agent-library-toolbar')).not.toBeNull()
    await act(async () => button('Clear filters')!.click())
    expect(onQueryChange).toHaveBeenCalledWith({ ...EMPTY_LIBRARY_QUERY, sort: 'name' })
    expect(isLibraryFiltered({ ...EMPTY_LIBRARY_QUERY, sort: 'name' })).toBe(false)
  })

  it('an empty workflows library has no filters and no second New workflow', async () => {
    const client = { list: async () => [] } as unknown as WorkflowDefinitionsClient
    await act(async () => root.render(createElement(WorkflowLibrary, { profileId: 'p', client, onOpen: () => {} })))
    await flush()
    expect(document.querySelector('[data-library-empty]')?.textContent).toBe('No workflows yet.')
    expect(document.querySelectorAll('[data-action="new-workflow"]')).toHaveLength(1)
    expect(document.querySelector('[aria-label="Import workflow"]')).not.toBeNull()
    expect(document.querySelector('.wf-toolbar')).toBeNull()
  })

  it('the workflow status filter offers the statuses present', () => {
    const base = { profileId: 'p', slug: 'w', source: 'user' } as unknown as WorkflowLibraryItem
    const draft = { ...base, id: '1', name: 'A' } as WorkflowLibraryItem
    const published = { ...base, id: '2', name: 'B', headRevisionId: 'r', headSemanticHash: 'h', draftSemanticHash: 'h' } as WorkflowLibraryItem
    expect(uniqueWorkflowStatuses([draft])).toEqual(['draft'])
    expect(uniqueWorkflowStatuses([draft, published])).toEqual(['draft', 'published'])
  })

  it('Refresh tools is an icon with its tooltip and is disabled while it runs', async () => {
    const onRefresh = vi.fn()
    act(() => root.render(createElement(RefreshToolsButton, { refreshing: false, onRefresh })))
    const refresh = document.querySelector<HTMLButtonElement>('[data-action="refresh-tools"]')!
    expect(refresh.title).toBe('Connect servers and refresh tools')
    expect(refresh.getAttribute('aria-label')).toBe('Refresh tools')
    await act(async () => refresh.click())
    expect(onRefresh).toHaveBeenCalledTimes(1)
    act(() => root.render(createElement(RefreshToolsButton, { refreshing: true, onRefresh })))
    expect(document.querySelector<HTMLButtonElement>('[data-action="refresh-tools"]')!.disabled).toBe(true)
  })
})

describe('archive confirmation', () => {
  it('names the library, mentions unsaved edits, and Escape changes nothing', async () => {
    const onCancel = vi.fn()
    const onConfirm = vi.fn()
    act(() => root.render(createElement(ArchiveDefinitionDialog, { open: true, kind: 'workflow', name: 'Nightly', dirty: true, onCancel, onConfirm })))
    expect(document.body.textContent).toContain('Archive “Nightly”?')
    expect(document.body.textContent).toContain('It leaves the Workflows library. Your unsaved edits are discarded.')
    // Focus starts on the dialog, not on the destructive button.
    expect(document.activeElement?.getAttribute('data-action')).not.toBe('confirm-archive')
    escape()
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onConfirm).not.toHaveBeenCalled()
  })
})

describe('agent editor header', () => {
  const openEditor = async (client: IsolatedAgentDefinitionsClient, id: string, onBack = vi.fn()) => {
    await act(async () => root.render(createElement(AgentEditor, { profileId: 'p', definitionId: id, client, catalogs, onBack })))
    await flush()
    return onBack
  }

  it('shows Draft saved, the blocking issue as a link, and keeps Duplicate, Export and Archive under "…"', async () => {
    const client = new IsolatedAgentDefinitionsClient()
    const created = await client.create({ profileId: 'p', settings: { identity: { name: 'Helper', slug: 'helper', purpose: '', tags: [] } } })
    await openEditor(client, created.id)
    expect(document.querySelector('[data-editor-status]')?.textContent).toBe('Draft saved')
    const publish = document.querySelector<HTMLButtonElement>('[data-action="publish"]')!
    expect(publish.disabled).toBe(true)
    expect(publish.title).toBe('Choose a model before publishing or running.')
    expect(document.getElementById(publish.getAttribute('aria-describedby')!)?.textContent).toBe(publish.title)
    const link = document.querySelector<HTMLButtonElement>('[data-action="show-blocking-issue"]')!
    expect(link.textContent).toMatch(/^Fix \d+ issues? to publish$/)
    Element.prototype.scrollIntoView ??= () => {}
    await act(async () => link.click())
    expect(document.activeElement?.closest('#agent-field-settings-primaryModel')).not.toBeNull()
    // Favorite is an icon toggle; the rest sit in the menu.
    const favorite = document.querySelector<HTMLButtonElement>('[data-action="favorite"]')!
    expect(favorite.textContent).toBe('')
    expect(favorite.getAttribute('aria-pressed')).toBe('false')
    expect(button('Duplicate')).toBeUndefined()
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Agent actions"]')!.click())
    expect([...document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent)).toEqual(['Duplicate', 'Export', 'Archive'])
  })

  it('an edit reads Unsaved edits, disables Export in the menu, and Save never publishes', async () => {
    const client = new IsolatedAgentDefinitionsClient()
    const created = await client.create({ profileId: 'p', settings: { identity: { name: 'Helper', slug: 'helper', purpose: '', tags: [] } } })
    const publish = vi.spyOn(client, 'publish')
    await openEditor(client, created.id)
    await act(async () => document.querySelector<HTMLButtonElement>('[data-action="favorite"]')!.click())
    expect(document.querySelector('[data-editor-status]')?.textContent).toBe('Unsaved edits')
    expect(document.querySelector<HTMLButtonElement>('[data-action="publish"]')!.title).toBe('Save the draft to publish it.')
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Agent actions"]')!.click())
    expect(document.querySelector<HTMLButtonElement>('[role="menu"] [data-action="export"]')!.disabled).toBe(true)
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Agent actions"]')!.click())
    await act(async () => document.querySelector<HTMLButtonElement>('[data-action="save-draft"]')!.click())
    await flush()
    expect(document.querySelector('[data-editor-status]')?.textContent).toBe('Draft saved')
    expect(publish).not.toHaveBeenCalled()
  })

  it('reads Published after publishing, then Unpublished changes after a saved edit', async () => {
    const client = new IsolatedAgentDefinitionsClient()
    const created = await client.create({
      profileId: 'p',
      settings: { identity: { name: 'Helper', slug: 'helper', purpose: '', tags: [] }, primaryModel: { ref: { providerId: 'xai', modelId: 'grok-4' } } } as never
    })
    await client.publish({ profileId: 'p', id: created.id, expectedDraftHash: created.draftHash })
    await openEditor(client, created.id)
    expect(document.querySelector('[data-editor-status]')?.textContent).toBe('Published · Runs on xAI')
    // A favorite is a library flag, not published content; a new name is.
    await act(async () => {
      const name = document.querySelector<HTMLInputElement>('[data-field="name"]')!
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(name, 'Helper two')
      name.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => document.querySelector<HTMLButtonElement>('[data-action="save-draft"]')!.click())
    await flush()
    expect(document.querySelector('[data-editor-status]')?.textContent).toContain('Unpublished changes')
  })

  it('Archive asks first, even for a clean draft; Cancel keeps it and Archive archives it', async () => {
    const client = new IsolatedAgentDefinitionsClient()
    const created = await client.create({ profileId: 'p', settings: { identity: { name: 'Helper', slug: 'helper', purpose: '', tags: [] } } })
    const archive = vi.spyOn(client, 'archive')
    const onBack = await openEditor(client, created.id)
    const menu = document.querySelector<HTMLButtonElement>('[aria-label="Agent actions"]')!
    await act(async () => menu.click())
    await act(async () => document.querySelector<HTMLButtonElement>('[role="menu"] [data-action="archive"]')!.click())
    expect(document.body.textContent).toContain('Archive “Helper”?')
    expect(document.body.textContent).toContain('It leaves the Agents library.')
    await act(async () => document.querySelector<HTMLButtonElement>('[data-action="cancel-archive"]')!.click())
    expect(archive).not.toHaveBeenCalled()
    // Focus is back on "…".
    expect(document.activeElement).toBe(menu)
    await act(async () => menu.click())
    await act(async () => document.querySelector<HTMLButtonElement>('[role="menu"] [data-action="archive"]')!.click())
    await act(async () => document.querySelector<HTMLButtonElement>('[data-action="confirm-archive"]')!.click())
    await flush()
    expect(archive).toHaveBeenCalledWith({ profileId: 'p', id: created.id })
    expect(onBack).toHaveBeenCalled()
  })
})
