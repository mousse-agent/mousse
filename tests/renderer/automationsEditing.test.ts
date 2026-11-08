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
import type { WorkflowNode } from '../../src/shared/workflows'
import { WorkflowEditor } from '../../src/renderer/components/workflows/WorkflowEditor'
import { WorkflowInspector } from '../../src/renderer/components/workflows/WorkflowInspector'
import { createBlankWorkflowBundle } from '../../src/renderer/components/workflows/templates'
import { WorkflowLibrary } from '../../src/renderer/components/workflows/WorkflowLibrary'
import type { WorkflowDefinitionsClient, WorkflowLeaveGuard, WorkflowLibraryItem } from '../../src/renderer/components/workflows/client'
import { uniqueWorkflowStatuses } from '../../src/renderer/components/workflows/libraryFilter'
import { confirmNavigation } from '../../src/renderer/services/navigationGuards'
import { IsolatedAgentDefinitionsClient } from '../fixtures/agent-platform/agent-editor-client'
import { IsolatedWorkflowDefinitionsClient } from '../fixtures/agent-platform/workflow-editor-client'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// The orb preview draws on a canvas jsdom does not have; the editor's header is what these tests read.
vi.mock('../../src/renderer/components/orb/OrbAppearanceEditor', () => ({ OrbAppearanceEditor: () => null }))
// The graph canvas and the code editor need layout jsdom does not have; the source is a plain textarea here.
vi.mock('../../src/renderer/components/workflows/WorkflowCanvas', () => ({ WorkflowCanvas: () => null }))
vi.mock('../../src/renderer/components/workflows/WorkflowSourceEditor', async () => {
  const { createElement: h } = await import('react')
  return {
    WorkflowSourceEditor: ({ value, diagnosticsText, onChange }: { value: string; diagnosticsText?: string; onChange: (text: string) => void }) =>
      h('textarea', { 'data-test-source': '', 'data-error': diagnosticsText ?? '', value, onChange: (event: { target: { value: string } }) => onChange(event.target.value) })
  }
})

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
    expect(document.querySelector('[data-library-empty]')?.textContent).toBe('No crew yet.')
    expect(buttons().filter((item) => item.textContent?.includes('New agent'))).toHaveLength(1)
    // Create is a neutral button, not an accent fill.
    expect(document.querySelector('[data-action="new-agent"]')?.className).toBe('btn')
    expect(document.querySelector('[aria-label="Import agent"]')).not.toBeNull()
    expect(document.querySelector('.agent-library-toolbar')).toBeNull()
    expect(document.querySelector('h2')?.textContent).toBe('The crew')
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
    expect(document.querySelector('[data-library-empty]')?.textContent).toBe('No playbooks yet.')
    expect(document.querySelectorAll('[data-action="new-workflow"]')).toHaveLength(1)
    expect(document.querySelector('[data-action="new-workflow"]')?.className).toBe('btn')
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

  it('a failed archive keeps the unsaved edits and the leave guard; a retry that succeeds leaves without asking', async () => {
    const client = new IsolatedAgentDefinitionsClient()
    const created = await client.create({ profileId: 'p', settings: { identity: { name: 'Helper', slug: 'helper', purpose: '', tags: [] } } })
    const archive = vi.spyOn(client, 'archive').mockRejectedValueOnce({ code: 'UNAVAILABLE', message: 'daemon offline' })
    const onBack = await openEditor(client, created.id)
    const name = () => document.querySelector<HTMLInputElement>('[data-field="name"]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(name(), 'Helper  edited ')
      name().dispatchEvent(new Event('input', { bubbles: true }))
    })
    const confirmArchive = async () => {
      await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Agent actions"]')!.click())
      await act(async () => document.querySelector<HTMLButtonElement>('[role="menu"] [data-action="archive"]')!.click())
      expect(document.body.textContent).toContain('Your unsaved edits are discarded.')
      await act(async () => document.querySelector<HTMLButtonElement>('[data-action="confirm-archive"]')!.click())
      await flush()
    }
    await confirmArchive()
    expect(archive).toHaveBeenCalledTimes(1)
    expect(onBack).not.toHaveBeenCalled()
    expect(name().value).toBe('Helper  edited ')
    expect(document.querySelector('[data-editor-status]')?.textContent).toBe('Unsaved edits')
    expect(document.querySelector('[data-agent-editor]')?.getAttribute('data-dirty')).toBe('true')
    expect(document.querySelector('.agent-banner--error')?.textContent).toBe("Couldn't archive: daemon offline")
    // The ordinary leave guard still asks about the kept edits.
    let left: boolean | undefined
    await act(async () => { void confirmNavigation().then((allowed) => { left = allowed }) })
    expect(button('Discard changes')).toBeDefined()
    await act(async () => button('Keep editing')!.click())
    await flush()
    expect(left).toBe(false)
    expect(name().value).toBe('Helper  edited ')
    // Retry: Archive is offered again and, once it succeeds, leaving does not ask a second time.
    await confirmArchive()
    expect(archive).toHaveBeenCalledTimes(2)
    expect(onBack).toHaveBeenCalledTimes(1)
    expect(await confirmNavigation()).toBe(true)
    expect(button('Discard changes')).toBeUndefined()
  })
})

describe('workflow editor archive', () => {
  it('a failed archive keeps the source text, its error and the unsaved state; a retry that succeeds leaves without asking', async () => {
    const client = new IsolatedWorkflowDefinitionsClient()
    const created = await client.create({ profileId: 'p', name: 'Nightly' })
    const archive = vi.spyOn(client, 'archive').mockRejectedValueOnce({ code: 'UNAVAILABLE', message: 'daemon offline' })
    const onBack = vi.fn()
    let guard: WorkflowLeaveGuard | null = null
    await act(async () => root.render(createElement(WorkflowEditor, {
      profileId: 'p',
      definitionId: created.id,
      client,
      catalogs: { ...client.catalogs, models: [] },
      onBack,
      onRegisterLeaveGuard: (next: WorkflowLeaveGuard | null) => { guard = next }
    })))
    await flush()
    await act(async () => document.querySelector<HTMLButtonElement>('[data-action="view-source"]')!.click())
    const source = () => document.querySelector<HTMLTextAreaElement>('[data-test-source]')!
    const broken = `${source().value}\n{ not valid`
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(source(), broken)
      source().dispatchEvent(new Event('input', { bubbles: true }))
    })
    const sourceError = source().getAttribute('data-error')
    expect(sourceError).toBeTruthy()
    const confirmArchive = async () => {
      await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Workflow actions"]')!.click())
      await act(async () => document.querySelector<HTMLButtonElement>('[role="menu"] [data-action="archive"]')!.click())
      expect(document.body.textContent).toContain('Your unsaved edits are discarded.')
      await act(async () => document.querySelector<HTMLButtonElement>('[data-action="confirm-archive"]')!.click())
      await flush()
    }
    await confirmArchive()
    expect(archive).toHaveBeenCalledTimes(1)
    expect(onBack).not.toHaveBeenCalled()
    expect(source().value).toBe(broken)
    expect(source().getAttribute('data-error')).toBe(sourceError)
    expect(document.querySelector('[data-workflow-editor]')?.getAttribute('data-dirty')).toBe('true')
    expect(document.querySelector('[data-editor-status]')?.textContent).toBe('Unsaved edits · Invalid source')
    expect(document.querySelector('.wf-banner--error')?.textContent).toBe("Couldn't archive: daemon offline")
    // The ordinary leave guard still asks about the kept edits.
    let left: boolean | undefined
    await act(async () => { void guard!('navigate').then((allowed) => { left = allowed }) })
    expect(button('Discard changes')).toBeDefined()
    await act(async () => button('Keep editing')!.click())
    await flush()
    expect(left).toBe(false)
    expect(source().value).toBe(broken)
    await confirmArchive()
    expect(archive).toHaveBeenCalledTimes(2)
    expect(onBack).toHaveBeenCalledTimes(1)
    expect(await guard!('navigate')).toBe(true)
    expect(button('Discard changes')).toBeUndefined()
  })
})

/** The themed select named `name`, by its labelling text or its aria-label. */
const combo = (name: string) => [...document.querySelectorAll<HTMLButtonElement>('[role="combobox"]')].find((item) =>
  item.getAttribute('aria-label') === name ||
  document.getElementById(item.getAttribute('aria-labelledby') ?? '')?.textContent === name)
const pick = async (name: string, option: string) => {
  await act(async () => combo(name)!.click())
  const item = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((entry) => entry.textContent === option)!
  await act(async () => item.click())
}

describe('editor controls', () => {
  it('the agent settings use the shared select and switch; choices save as before and mark the draft unsaved', async () => {
    const client = new IsolatedAgentDefinitionsClient()
    const created = await client.create({ profileId: 'p', settings: { identity: { name: 'Helper', slug: 'helper', purpose: '', tags: [] } } })
    const saveDraft = vi.spyOn(client, 'saveDraft')
    await act(async () => root.render(createElement(AgentEditor, { profileId: 'p', definitionId: created.id, client, catalogs, onBack: vi.fn() })))
    await flush()
    const editor = document.querySelector('[data-agent-editor]')!
    expect(editor.querySelectorAll('select')).toHaveLength(0)
    expect(editor.querySelectorAll('input[type="checkbox"]')).toHaveLength(0)

    await pick('Remember', 'Off')
    expect(combo('Remember')!.getAttribute('data-value')).toBe('off')
    expect(document.querySelector('[data-editor-status]')?.textContent).toBe('Unsaved edits')
    // An unavailable choice stays visible but cannot be picked.
    await act(async () => combo('Where they run')!.click())
    const sandboxed = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((entry) => entry.textContent === 'Sandboxed (unavailable)')!
    expect(sandboxed.getAttribute('aria-disabled')).toBe('true')
    await act(async () => sandboxed.click())
    expect(combo('Where they run')!.getAttribute('data-value')).toBe('workspace')

    // A switch is named by its row text, and the text toggles it too.
    const thread = document.querySelector<HTMLButtonElement>('#include-thread')!
    expect(thread.getAttribute('role')).toBe('switch')
    expect(document.getElementById(thread.getAttribute('aria-labelledby')!)?.textContent).toBe('Current thread')
    const before = thread.getAttribute('aria-checked')
    await act(async () => document.querySelector<HTMLLabelElement>('label[for="include-thread"]')!.click())
    expect(thread.getAttribute('aria-checked')).toBe(before === 'true' ? 'false' : 'true')

    await act(async () => document.querySelector<HTMLButtonElement>('[data-action="save-draft"]')!.click())
    await flush()
    const saved = saveDraft.mock.calls[0][0]
    expect(saved.settings?.memory.scope).toBe('off')
    expect(saved.settings?.script.executionMode).toBe('workspace')
    expect(saved.settings?.context.includeCurrentThread).toBe(before !== 'true')
  })

  it('the workflow inspector uses the shared select, keeps disabled choices and is read-only for a published revision', async () => {
    const manifest = createBlankWorkflowBundle('Nightly').manifest
    const node = { id: 'step', type: 'load-skill', config: { skill: { id: 'gone', revision: '1' } } } as unknown as WorkflowNode
    const onChangeNode = vi.fn()
    const render = (readOnly: boolean) => root.render(createElement(WorkflowInspector, {
      profileId: 'p',
      manifest,
      node,
      readOnly,
      catalogs: {
        skills: [{ id: 'gone', name: 'Gone', revision: '1', available: false }, { id: 'docs', name: 'Docs', revision: '7', available: true }],
        mcpServers: [],
        builtinTools: [],
        subworkflows: [],
        browserWorkspaces: [],
        models: []
      },
      instructions: '',
      onChangeNode,
      onChangeManifest: vi.fn(),
      onChangeInstructions: vi.fn()
    }))
    await act(async () => render(false))
    const inspector = document.querySelector('[data-inspector]')!
    expect(inspector.querySelectorAll('select')).toHaveLength(0)
    // The saved choice still shows even though it is no longer available.
    expect(combo('Skill')!.textContent).toBe('Gone (missing)')
    await pick('Skill', 'Docs')
    expect(onChangeNode).toHaveBeenLastCalledWith(expect.objectContaining({ config: { skill: { id: 'docs', revision: '7' } } }))
    await act(async () => render(true))
    expect(combo('Skill')!.disabled).toBe(true)
    expect(combo('Effect')!.disabled).toBe(true)
  })
})
