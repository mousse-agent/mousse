import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'

// Drive the production dialog without a DOM: hooks keep state between calls and
// controls are found in the returned element tree and invoked through their props.
const hooks = vi.hoisted(() => ({ states: [] as unknown[], refs: [] as { current: unknown }[], stateIndex: 0, refIndex: 0 }))
vi.mock('react', async (load) => ({
  ...await load<typeof import('react')>(),
  useState: (initial: unknown) => {
    const index = hooks.stateIndex++
    if (!(index in hooks.states)) hooks.states[index] = initial
    return [hooks.states[index], (value: unknown) => { hooks.states[index] = typeof value === 'function' ? (value as (old: unknown) => unknown)(hooks.states[index]) : value }]
  },
  useRef: (initial: unknown) => hooks.refs[hooks.refIndex++] ?? (hooks.refs[hooks.refIndex - 1] = { current: initial }),
  useEffect: () => undefined
}))
import { AddSkillDialog } from '../src/renderer/components/integrations/SkillDialogs'
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

function mount(initialMode: 'create' | 'upload') {
  const client = { createSkill: vi.fn(async () => ({})), importSkill: vi.fn(async () => ({})) }
  const onSaved = vi.fn()
  const render = () => {
    hooks.stateIndex = 0; hooks.refIndex = 0
    return AddSkillDialog({ client: client as never, profileId: 'profile-a', scope: 'global', initialMode, onClose: vi.fn(), onSaved })
  }
  const enableSwitch = () => find(render(), (element) => element.type === Switch)
  const submit = () => (find(render(), (element) => element.type === 'form').props.onSubmit as (event: unknown) => void)({ preventDefault: () => undefined })
  return { client, onSaved, render, enableSwitch, submit }
}

describe('Add skill dialog', () => {
  beforeEach(() => { hooks.states = []; hooks.refs = [] })

  it('uses the shared switch, not a native checkbox, and starts on', () => {
    const { render, enableSwitch } = mount('create')
    expect(enableSwitch().props.checked).toBe(true)
    expect([...walk(render())].some((element) => element.type === 'input' && element.props.type === 'checkbox')).toBe(false)
  })

  it('sends the "Turn on after saving" choice when creating', async () => {
    const { client, onSaved, render, enableSwitch, submit } = mount('create')
    const field = (label: string) => find(find(render(), (element) => element.props.label === label).props.children, (element) => element.type === 'input' || element.type === 'textarea')
    ;(field('Name').props.onChange as (event: unknown) => void)({ target: { value: 'writer' } })
    ;(field('When to use').props.onChange as (event: unknown) => void)({ target: { value: 'Drafting release notes' } })

    ;(enableSwitch().props.onChange as (next: boolean) => void)(false)
    expect(enableSwitch().props.checked).toBe(false)
    submit()
    await vi.waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1))
    expect(client.createSkill).toHaveBeenCalledWith(expect.objectContaining({ name: 'writer', enable: false }))

    ;(enableSwitch().props.onChange as (next: boolean) => void)(true)
    submit()
    await vi.waitFor(() => expect(onSaved).toHaveBeenCalledTimes(2))
    expect(client.createSkill).toHaveBeenLastCalledWith(expect.objectContaining({ enable: true }))
  })

  it('sends the choice when importing a package', async () => {
    const { client, onSaved, render, enableSwitch, submit } = mount('upload')
    const upload = find(render(), (element) => element.props['data-action'] === 'skill-upload-input')
    ;(upload.props.onChange as (event: unknown) => void)({ target: { files: [new File(['---\nname: writer\ndescription: Drafts\n---\n'], 'SKILL.md')] } })
    ;(enableSwitch().props.onChange as (next: boolean) => void)(false)
    submit()
    await vi.waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1))
    expect(client.importSkill).toHaveBeenCalledWith(expect.objectContaining({ zipName: 'SKILL.zip', enable: false }))
  })
})
