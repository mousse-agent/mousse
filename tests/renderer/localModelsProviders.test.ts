// @vitest-environment jsdom
/**
 * Settings → Providers with local model servers, mounted over a fake bridge: Add provider → Local models finds the
 * servers only when its step opens, connects one (a key field only after a 401, plain http to another machine only
 * after consent) and adds its `pi:local-*` entry; a local model's row sets its window and checks its tools; the page
 * reads local servers' lists again when it opens, and no other entry's.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProvidersSettings } from '../../src/renderer/components/providers/ProvidersSettings'
import { resetLocalRefreshes } from '../../src/renderer/lib/localModels'
import { providersApi } from '../../src/renderer/lib/providersComputer'
import type { InstanceSnapshot, ProviderSnapshotsEvent } from '../../src/shared/harness/status'
import type { InstanceModel } from '../../src/shared/harness/types'
import type { LocalConnectInput, LocalConnectResult, LocalModelFacts, LocalServerRow } from '../../src/shared/localServers'
import { getDefaultSettings } from '../../src/shared/settings'
import { snapshot } from '../providerSnapshotFixture'

const model = (id: string, local: LocalModelFacts, contextWindow?: number): InstanceModel => ({
  id,
  label: id,
  source: 'catalog',
  capabilities: { efforts: [], images: local.images, ...(contextWindow ? { contextWindow } : {}) },
  hidden: false,
  favorite: false,
  local
})

const ollamaEntry = (): InstanceSnapshot =>
  snapshot({
    instanceId: 'pi:local-ollama',
    driver: 'pi',
    displayName: 'Ollama',
    builtIn: false,
    auth: { state: 'signed_in' },
    models: {
      entries: [
        model('qwen3:8b', { tools: 'reported', images: false, loadedWindow: 32768 }, 32768),
        model('llama3.2:1b', { tools: 'none', images: false, loadedWindow: 8192 }, 8192),
        model('gpt-oss:120b-cloud', { tools: 'passed', images: true, cloud: true, loadedWindow: 131072 }, 131072),
        model('phi3:medium', { tools: 'unknown', images: false })
      ],
      source: 'live'
    }
  })

const ROWS: LocalServerRow[] = [
  { kind: 'ollama', label: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1', state: 'running', count: 6 },
  { kind: 'lmstudio', label: 'LM Studio', state: 'not_running' },
  { kind: 'unsloth', label: 'Unsloth Studio', baseUrl: 'http://127.0.0.1:8888/v1', state: 'needs_key' }
]

const ok = (providerId: string): LocalConnectResult => ({ ok: true, providerId, label: providerId, kind: 'openai', count: 1 })

describe('Settings → Providers: local model servers', () => {
  let host: HTMLDivElement
  let root: Root
  let entries: InstanceSnapshot[]
  let instances: Record<string, ReturnType<typeof vi.fn>>
  let local: {
    detect: ReturnType<typeof vi.fn<() => Promise<LocalServerRow[]>>>
    connect: ReturnType<typeof vi.fn<(input: LocalConnectInput) => Promise<LocalConnectResult>>>
    setModel: ReturnType<typeof vi.fn>
    checkTools: ReturnType<typeof vi.fn>
  }

  const settle = async () => {
    for (let round = 0; round < 6; round += 1) await act(async () => { await new Promise((done) => setTimeout(done, 0)) })
  }
  const text = () => document.body.textContent ?? ''
  const buttons = () => [...document.body.querySelectorAll<HTMLButtonElement>('button')]
  const button = (label: string) => buttons().find((item) => item.textContent?.trim() === label)
  const click = async (element: Element | undefined | null) => {
    if (!element) throw new Error('nothing to click')
    await act(async () => { element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
    await settle()
  }
  const type = async (label: string, value: string) => {
    const input = document.body.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)
    if (!input) throw new Error(`no field ${label}`)
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }
  const enter = async (label: string) => {
    const input = document.body.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!
    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    await settle()
  }
  /** The row of a server in the Local models step, by the name it starts with. */
  const row = (name: string) => [...document.body.querySelectorAll('.prov-wizard .settings-item')].find((item) => item.textContent?.startsWith(name))
  const rowButton = (name: string, label: string) => [...(row(name)?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find((item) => item.textContent?.trim() === label)
  const openLocalModels = async () => {
    await click(button('Add provider'))
    await click([...document.body.querySelectorAll('.prov-choice')].find((item) => item.textContent?.includes('Local models')))
    await click(button('Next'))
  }
  const dialogOpen = () => document.body.querySelector('.prov-wizard') !== null

  beforeEach(async () => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    resetLocalRefreshes()
    entries = [snapshot(), ollamaEntry()]
    instances = {
      add: vi.fn(async (input: { config?: { provider?: string } }) =>
        snapshot({ instanceId: `pi:${input.config!.provider!}`, driver: 'pi', displayName: input.config!.provider!, builtIn: false })),
      setEnabled: vi.fn(async (instanceId: string) => entries.find((entry) => entry.instanceId === instanceId) ?? snapshot()),
      recheck: vi.fn(async () => snapshot()),
      refreshModels: vi.fn(async (instanceId: string) => entries.find((entry) => entry.instanceId === instanceId)!)
    }
    local = {
      detect: vi.fn(async () => ROWS),
      connect: vi.fn(async (input: LocalConnectInput) => ok(input.address.includes('11434') ? 'local-ollama-2' : 'local-server')),
      setModel: vi.fn(async () => true),
      checkTools: vi.fn(async () => ({ ok: true, tools: 'passed' }))
    }
    ;(window as unknown as { mousse: unknown }).mousse = {
      platform: 'darwin',
      providers: {
        snapshots: async () => entries,
        onSnapshots: (_listener: (event: ProviderSnapshotsEvent) => void) => () => {},
        onOperation: () => () => {},
        catalog: { addOptions: async () => [] },
        registry: { search: async () => [] },
        instances,
        local
      }
    }
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    act(() => root.render(createElement(ProvidersSettings, {
      settings: getDefaultSettings(),
      refreshProviderData: async () => ({ opts: { themes: [], accentColors: [], llmProviders: [], agentTypes: [] } as never }),
      updateSettings: async () => {},
      ensureValidProviderSelection: async (next) => next
    })))
    await settle()
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
  })

  it('opening the page reads the local entries’ lists again, and nothing looks for servers until Local models opens', async () => {
    expect(instances.refreshModels).toHaveBeenCalledExactlyOnceWith('pi:local-ollama')
    expect(local.detect).not.toHaveBeenCalled()
    await openLocalModels()
    expect(local.detect).toHaveBeenCalledTimes(1)
  })

  it('lists each server on one line with one action, the address row last; Check again looks again', async () => {
    await openLocalModels()
    expect(row('Ollama')?.textContent).toContain('Ollama · 6 models')
    expect(rowButton('Ollama', 'Connect')).toBeDefined()
    expect(row('LM Studio')?.textContent).toContain('Not running')
    expect(rowButton('Unsloth Studio', 'Enter key')).toBeDefined()
    // No key field anywhere before a server asked for one.
    expect(document.body.querySelector('input[type="password"]')).toBeNull()
    const rows = [...document.body.querySelectorAll('.prov-wizard .settings-item')]
    expect(rows.at(-1)?.textContent).toContain('Enter server address')
    await click(rowButton('LM Studio', 'Check again'))
    expect(local.detect).toHaveBeenCalledTimes(2)
  })

  it('Connect adds the server’s pi entry and closes the dialog', async () => {
    await openLocalModels()
    await click(rowButton('Ollama', 'Connect'))
    expect(local.connect).toHaveBeenCalledExactlyOnceWith({ address: 'http://127.0.0.1:11434/v1' })
    expect(instances.add).toHaveBeenCalledExactlyOnceWith({ driver: 'pi', config: { provider: 'local-ollama-2' } })
    expect(dialogOpen()).toBe(false)
  })

  it('a server that needs a key gets the key field from Enter key, and connects with it', async () => {
    await openLocalModels()
    await click(rowButton('Unsloth Studio', 'Enter key'))
    await type('Unsloth Studio key', 'sk-local')
    await click(rowButton('Unsloth Studio', 'Connect'))
    expect(local.connect).toHaveBeenCalledExactlyOnceWith({ address: 'http://127.0.0.1:8888/v1', apiKey: 'sk-local' })
    expect(instances.add).toHaveBeenCalledWith({ driver: 'pi', config: { provider: 'local-server' } })
  })

  it('an address that answers 401 shows the key field, then connects with the key', async () => {
    local.connect.mockResolvedValueOnce({ ok: false, problem: 'needs_key', message: 'This server needs its key.' })
    await openLocalModels()
    await click(button('Enter server address'))
    await type('Server address', 'box.lan:8000')
    expect(document.body.querySelector('input[type="password"]')).toBeNull()
    await click(rowButton('Server address', 'Connect'))
    expect(local.connect).toHaveBeenLastCalledWith({ address: 'box.lan:8000' })
    expect(instances.add).not.toHaveBeenCalled()
    await type('Server key', 'secret')
    await enter('Server key')
    expect(local.connect).toHaveBeenLastCalledWith({ address: 'box.lan:8000', apiKey: 'secret' })
    expect(instances.add).toHaveBeenCalledWith({ driver: 'pi', config: { provider: 'local-server' } })
  })

  it('plain http to another machine is asked once: Connect anyway sends the consent', async () => {
    local.connect.mockResolvedValueOnce({ ok: false, problem: 'cleartext_consent', message: 'Prompts go over the network unencrypted.' })
    await openLocalModels()
    await click(button('Enter server address'))
    await type('Server address', 'http://192.168.1.20:11434')
    await click(rowButton('Server address', 'Connect'))
    expect(row('Server address')?.textContent).toContain('Prompts go over the network unencrypted.')
    expect(instances.add).not.toHaveBeenCalled()
    await click(rowButton('Server address', 'Connect anyway'))
    expect(local.connect).toHaveBeenLastCalledWith({ address: 'http://192.168.1.20:11434', allowCleartext: true })
    expect(instances.add).toHaveBeenCalledTimes(1)
  })

  it('a problem stays on its row as one line, and nothing is added', async () => {
    local.connect.mockResolvedValueOnce({ ok: false, problem: 'unreachable', message: 'Nothing answers at box.lan:9999.' })
    await openLocalModels()
    await click(button('Enter server address'))
    await type('Server address', 'box.lan:9999')
    await click(rowButton('Server address', 'Connect'))
    expect(row('Server address')?.textContent).toContain('Nothing answers at box.lan:9999.')
    expect(instances.add).not.toHaveBeenCalled()
    expect(dialogOpen()).toBe(true)
  })

  describe('a local entry’s models', () => {
    const modelRow = (id: string) => [...document.body.querySelectorAll('.prov-model-row')].find((item) => item.querySelector('.prov-model-name')?.textContent === id)
    const modelButton = (id: string, label: string) => [...(modelRow(id)?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find((item) => item.textContent?.trim() === label)
    beforeEach(async () => {
      await click(document.body.querySelector('button[aria-label="Select Ollama"]'))
    })

    it('show the window, Chat only, Images and Cloud on each row', () => {
      expect(modelRow('qwen3:8b')?.textContent).toContain('32K')
      expect(modelRow('llama3.2:1b')?.textContent).toContain('Chat only')
      expect(modelRow('qwen3:8b')?.textContent).not.toContain('Chat only')
      expect(modelRow('gpt-oss:120b-cloud')?.textContent).toContain('Cloud')
      expect(modelRow('gpt-oss:120b-cloud')?.textContent).toContain('Images')
      expect(modelRow('phi3:medium')?.textContent).toContain('Window unknown · Set')
    })

    it('Window unknown · Set saves the window on the server’s connection, and Clear removes it', async () => {
      // The service saves it; the list read again then carries it.
      local.setModel.mockImplementation(async () => {
        entries = [snapshot(), ollamaEntry()]
        entries[1]!.models.entries[3]!.local = { tools: 'unknown', images: false, windowOverride: 32768 }
        return true
      })
      await click(modelButton('phi3:medium', 'Window unknown · Set'))
      await type('phi3:medium context window in tokens', '32K')
      await enter('phi3:medium context window in tokens')
      expect(local.setModel).toHaveBeenCalledExactlyOnceWith({ providerId: 'local-ollama', modelId: 'phi3:medium', window: 32768 })
      expect(instances.refreshModels).toHaveBeenLastCalledWith('pi:local-ollama')
      await click(modelButton('phi3:medium', '32K'))
      await click(modelButton('phi3:medium', 'Clear'))
      expect(local.setModel).toHaveBeenLastCalledWith({ providerId: 'local-ollama', modelId: 'phi3:medium', window: null })
    })

    it('Check tools is offered only while tools are reported or unknown, and a cold model says to load it first', async () => {
      expect(modelButton('llama3.2:1b', 'Check tools')).toBeUndefined()
      expect(modelButton('gpt-oss:120b-cloud', 'Check tools')).toBeUndefined()
      local.checkTools.mockResolvedValueOnce({ ok: false, problem: 'cold', message: 'Not loaded.' })
      await click(modelButton('qwen3:8b', 'Check tools'))
      expect(local.checkTools).toHaveBeenCalledExactlyOnceWith({ providerId: 'local-ollama', modelId: 'qwen3:8b' })
      expect(modelRow('qwen3:8b')?.textContent).toContain('Load it in its app first')
      const refreshes = instances.refreshModels.mock.calls.length
      await click(modelButton('qwen3:8b', 'Check tools'))
      // A finished check reads the list again, so the row shows what it found.
      expect(instances.refreshModels.mock.calls.length).toBe(refreshes + 1)
    })
  })
})

describe('another computer’s local servers', () => {
  it('go through that computer’s routed calls', async () => {
    const remote = vi.fn(async () => [])
    ;(window as unknown as { mousse: unknown }).mousse = { providers: { remote } }
    const api = providersApi('node-b')
    await api.local.detect()
    await api.local.connect({ address: 'localhost:11434', apiKey: 'k' })
    await api.local.setModel({ providerId: 'local-ollama', modelId: 'm', window: null })
    await api.local.checkTools({ providerId: 'local-ollama', modelId: 'm' })
    expect(remote.mock.calls).toEqual([
      ['node-b', 'providers.local.detect', {}],
      ['node-b', 'providers.local.connect', { address: 'localhost:11434', apiKey: 'k' }],
      ['node-b', 'providers.local.setModel', { providerId: 'local-ollama', modelId: 'm', window: null }],
      ['node-b', 'providers.local.checkTools', { providerId: 'local-ollama', modelId: 'm' }]
    ])
  })
})
