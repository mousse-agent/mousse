// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EmptyThreadAddProject, offersAddProject } from '../../src/renderer/components/EmptyThreadAddProject'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('an empty new chat', () => {
  let root: Root | undefined
  afterEach(() => {
    act(() => root?.unmount())
    document.body.innerHTML = ''
  })

  it('offers Add project only on this computer with no projects', () => {
    expect(offersAddProject(0, undefined)).toBe(true)
    expect(offersAddProject(1, undefined)).toBe(false)
    expect(offersAddProject(0, 'mac-mini')).toBe(false)
  })

  it('has one Add project button that runs the action', () => {
    const host = document.body.appendChild(document.createElement('div'))
    const onAdd = vi.fn()
    root = createRoot(host)
    act(() => root!.render(createElement(EmptyThreadAddProject, { onAdd })))
    const buttons = host.querySelectorAll('button')
    expect([...buttons].map((button) => button.textContent)).toEqual(['Add project'])
    act(() => buttons[0].click())
    expect(onAdd).toHaveBeenCalledOnce()
  })
})
