import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'

// Drive the production dialog without a DOM: hooks keep state between calls and
// controls are found in the returned element tree and invoked through their props.
const hooks = vi.hoisted(() => ({ states: [] as unknown[], refs: [] as { current: unknown }[], stateIndex: 0, refIndex: 0 }))
vi.mock('react', async (load) => ({
  ...await load<typeof import('react')>(),
  useState: (initial: unknown) => {
    const index = hooks.stateIndex++
    if (!(index in hooks.states)) hooks.states[index] = typeof initial === 'function' ? (initial as () => unknown)() : initial
    return [hooks.states[index], (value: unknown) => { hooks.states[index] = typeof value === 'function' ? (value as (old: unknown) => unknown)(hooks.states[index]) : value }]
  },
  useRef: (initial: unknown) => hooks.refs[hooks.refIndex++] ?? (hooks.refs[hooks.refIndex - 1] = { current: initial }),
  useEffect: () => undefined
}))
import { McpConnectionDialog } from '../src/renderer/components/integrations/McpConnectionDialog'
import { Switch } from '../src/renderer/components/settings/SettingsRow'

type Element = ReactElement<Record<string, unknown>>
function* walk(node: unknown): Generator<Element> {
  if (Array.isArray(node)) { for (const child of node) yield* walk(child); return }
  if (!node || typeof node !== 'object' || !('props' in node)) return
  const element = node as Element
  yield element
  for (const value of Object.values(element.props)) yield* walk(value)
}
const find = (tree: unknown, match: (element: Element) => boolean) => {
  const found = [...walk(tree)].find(match)
  if (!found) throw new Error('element not found')
  return found
}

function mount() {
  const client = { createMcp: vi.fn(async () => ({})) }
  const onSaved = vi.fn()
  const render = () => {
    hooks.stateIndex = 0; hooks.refIndex = 0
    return McpConnectionDialog({ client: client as never, profileId: 'profile-a', scope: 'global', onClose: vi.fn(), onSaved })
  }
  /** The real shared Switch inside the dialog's switch row with this id. */
  const switchFor = (id: string) => {
    const row = find(render(), (element) => element.props.id === id && typeof element.type === 'function')
    const rendered = (row.type as (props: unknown) => Element)(row.props)
    return find(rendered, (element) => element.type === Switch)
  }
  const toggle = (id: string, next: boolean) => (switchFor(id).props.onChange as (value: boolean) => void)(next)
  const field = (label: string) => find(find(render(), (element) => element.props.label === label).props.children, (element) => element.type === 'input' || element.type === 'textarea')
  const type = (label: string, value: string) => (field(label).props.onChange as (event: unknown) => void)({ target: { value } })
  const submit = () => (find(render(), (element) => element.type === 'form').props.onSubmit as (event: unknown) => void)({ preventDefault: () => undefined })
  return { client, onSaved, render, switchFor, toggle, field, type, submit }
}

describe('MCP server dialog', () => {
  beforeEach(() => { hooks.states = []; hooks.refs = [] })

  it('uses the shared switch, never a native checkbox', () => {
    const { render, switchFor } = mount()
    expect([...walk(render())].some((element) => element.type === 'input' && element.props.type === 'checkbox')).toBe(false)
    expect(switchFor('mcp-enable').props.checked).toBe(true)
    expect(switchFor('mcp-replace-env').props.checked).toBe(false)
  })

  it('sends "Turn on after saving" and only the maps that are switched on', async () => {
    const { client, onSaved, toggle, switchFor, type, field, submit } = mount()
    type('Name', 'Fixture')
    type('Command', 'node')
    toggle('mcp-enable', false)
    expect(switchFor('mcp-enable').props.checked).toBe(false)
    expect(() => field('Environment JSON')).toThrow()
    submit()
    await vi.waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1))
    expect(client.createMcp).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'Fixture', enable: false }))
    expect(client.createMcp.mock.lastCall?.[0]).not.toHaveProperty('env')

    toggle('mcp-enable', true)
    toggle('mcp-replace-env', true)
    type('Environment JSON', '{"TOKEN":"${TOKEN_ENV}"}')
    submit()
    await vi.waitFor(() => expect(onSaved).toHaveBeenCalledTimes(2))
    expect(client.createMcp).toHaveBeenLastCalledWith(expect.objectContaining({ enable: true, env: { TOKEN: '${TOKEN_ENV}' } }))
  })

  it('switches remote servers to legacy SSE and back', async () => {
    const { client, onSaved, render, toggle, switchFor, type, submit } = mount()
    type('Name', 'Remote')
    const transport = find(render(), (element) => element.props.ariaLabelledBy === 'mcp-transport-label')
    ;(transport.props.onChange as (value: string) => void)('remote')
    type('Server URL', 'https://example.invalid/mcp')
    toggle('mcp-sse', true)
    expect(switchFor('mcp-sse').props.checked).toBe(true)
    submit()
    await vi.waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1))
    expect(client.createMcp).toHaveBeenLastCalledWith(expect.objectContaining({ transport: 'sse', url: 'https://example.invalid/mcp' }))

    toggle('mcp-sse', false)
    submit()
    await vi.waitFor(() => expect(onSaved).toHaveBeenCalledTimes(2))
    expect(client.createMcp).toHaveBeenLastCalledWith(expect.objectContaining({ transport: 'http' }))
  })

  it('sends headers only when "Set headers" is on', async () => {
    const { client, onSaved, render, toggle, type, submit } = mount()
    type('Name', 'Fixture')
    type('Command', 'node')
    const auth = find(render(), (element) => element.props.label === 'Authentication').props.children as Element
    ;(auth.props.onChange as (value: string) => void)('static')
    toggle('mcp-replace-headers', true)
    type('Headers JSON', '{"Authorization":"${API_TOKEN}"}')
    submit()
    await vi.waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1))
    expect(client.createMcp).toHaveBeenLastCalledWith(expect.objectContaining({ authMode: 'static', headers: { Authorization: '${API_TOKEN}' } }))

    toggle('mcp-replace-headers', false)
    submit()
    await vi.waitFor(() => expect(onSaved).toHaveBeenCalledTimes(2))
    expect(client.createMcp.mock.lastCall?.[0]).not.toHaveProperty('headers')
  })
})
