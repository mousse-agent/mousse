// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProfilePublicDto } from '../../src/shared/profiles/types'
import { checkedProfileName, ProfileEditDialog, type ProfileEditMode } from '../../src/renderer/components/profiles/ProfileEditDialog'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const studio: ProfilePublicDto = { id: 'prf_beta', slug: 'studio', displayName: 'Studio', status: 'active', revision: 3, isDefault: false, color: '#604880' }

let root: Root
let host: HTMLElement

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

function show(mode: ProfileEditMode, props: Partial<Parameters<typeof ProfileEditDialog>[0]> = {}) {
  const callbacks = { onSubmit: vi.fn(), onArchive: vi.fn(), onClose: vi.fn() }
  act(() => root.render(createElement(ProfileEditDialog, { mode, ...callbacks, ...props })))
  return callbacks
}

const input = () => document.querySelector<HTMLInputElement>('[aria-label="Profile name"]')!
const submit = () => document.querySelector<HTMLButtonElement>('button[type="submit"]')!
const swatch = (name: string) => document.querySelector<HTMLButtonElement>(`[role="radio"][aria-label="${name}"]`)!
const archive = () => document.querySelector<HTMLButtonElement>('.profile-edit-archive')
const type = (value: string) => act(() => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input(), value)
  input().dispatchEvent(new Event('input', { bubbles: true }))
})
const send = () => act(() => { submit().form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })

describe('checkedProfileName', () => {
  it('trims, and refuses empty names and names over 64 characters', () => {
    expect(checkedProfileName('  Studio  ')).toBe('Studio')
    expect(checkedProfileName('')).toBeUndefined()
    expect(checkedProfileName('   ')).toBeUndefined()
    expect(checkedProfileName('a'.repeat(64))).toBe('a'.repeat(64))
    expect(checkedProfileName('a'.repeat(65))).toBeUndefined()
    expect(checkedProfileName('😀'.repeat(64))).toBe('😀'.repeat(64))
  })
})

describe('ProfileEditDialog in create mode', () => {
  it('starts empty on the suggested colour with a Create button that waits for a name', () => {
    show({ kind: 'create', color: '#2f7a6a' })
    expect(document.querySelector('[role="dialog"] h3')?.textContent).toBe('New profile')
    expect(input().value).toBe('')
    expect(input().maxLength).toBe(64)
    expect(submit().getAttribute('aria-label')).toBe('Create profile')
    expect(submit().disabled).toBe(true)
    expect(swatch('Teal').getAttribute('aria-checked')).toBe('true')
    expect(archive()).toBeNull()
  })

  it('submits the trimmed name with the chosen colour', () => {
    const { onSubmit } = show({ kind: 'create', color: '#2f7a6a' })
    type('  Docs ')
    expect(submit().disabled).toBe(false)
    act(() => swatch('Plum').click())
    send()
    expect(onSubmit).toHaveBeenCalledWith({ displayName: 'Docs', color: '#7a3f5c' })
  })

  it('never offers Archive, even when the caller allows it', () => {
    show({ kind: 'create', color: '#2f7a6a' }, { canArchive: true })
    expect(archive()).toBeNull()
  })
})

describe('ProfileEditDialog in edit mode', () => {
  it('shows the profile with its colour selected and Save disabled until something changes', () => {
    show({ kind: 'edit', profile: studio })
    expect(document.querySelector('[role="dialog"] h3')?.textContent).toBe('Edit profile')
    expect(input().value).toBe('Studio')
    expect(submit().getAttribute('aria-label')).toBe('Save profile name')
    expect(submit().disabled).toBe(true)
    expect(swatch('Violet').getAttribute('aria-checked')).toBe('true')
    expect(document.querySelectorAll('[role="radio"][aria-checked="true"]')).toHaveLength(1)
    type('Studio ')
    expect(submit().disabled).toBe(true)
  })

  it('sends only the name for a rename and the colour too once it is picked', () => {
    const { onSubmit } = show({ kind: 'edit', profile: studio })
    type('Studio 2')
    send()
    expect(onSubmit).toHaveBeenLastCalledWith({ displayName: 'Studio 2' })
    act(() => swatch('Teal').click())
    expect(swatch('Teal').getAttribute('aria-checked')).toBe('true')
    expect(swatch('Violet').getAttribute('aria-checked')).toBe('false')
    send()
    expect(onSubmit).toHaveBeenLastCalledWith({ displayName: 'Studio 2', color: '#2f7a6a' })
  })

  it('lets a colour change alone be saved', () => {
    const { onSubmit } = show({ kind: 'edit', profile: studio, focus: 'color' })
    act(() => swatch('Olive').click())
    expect(submit().disabled).toBe(false)
    send()
    expect(onSubmit).toHaveBeenCalledWith({ displayName: 'Studio', color: '#6b7a2f' })
  })

  it('blocks empty, blank and over-long names', () => {
    const { onSubmit } = show({ kind: 'edit', profile: studio })
    for (const value of ['', '   ', 'x'.repeat(65)]) {
      type(value)
      expect(submit().disabled, JSON.stringify(value)).toBe(true)
      send()
    }
    expect(onSubmit).not.toHaveBeenCalled()
    type('x'.repeat(64))
    expect(submit().disabled).toBe(false)
  })

  it('offers Archive only when the caller allows it, and hands it back unchanged', () => {
    show({ kind: 'edit', profile: studio })
    expect(archive()).toBeNull()
    const { onArchive } = show({ kind: 'edit', profile: studio }, { canArchive: true })
    expect(archive()?.textContent).toBe('Archive')
    act(() => archive()!.click())
    expect(onArchive).toHaveBeenCalledTimes(1)
  })

  it('disables saving and archiving while busy, and shows an error', () => {
    show({ kind: 'edit', profile: studio }, { canArchive: true, busy: true, error: 'Profile changed elsewhere' })
    type('Studio 2')
    expect(submit().disabled).toBe(true)
    expect(archive()!.disabled).toBe(true)
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('Profile changed elsewhere')
  })

  it('closes on Escape', () => {
    const { onClose } = show({ kind: 'edit', profile: studio })
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
