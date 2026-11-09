// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextStepButton, type NextStepChoice } from '../src/renderer/components/sideCard/NextStepButton'
import type { NextStep } from '../src/renderer/components/sideCard/gitSectionLogic'

const DIVERGED: NextStep = { kind: 'pull', label: 'Pull 3 commits', title: 'origin/main has 3 new commits', strategies: ['rebase', 'merge'] }

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  document.body.innerHTML = ''
})

const render = (onChoose: (choice: NextStepChoice) => void, step: NextStep = DIVERGED) =>
  act(() => root.render(createElement(NextStepButton, { step, busy: null, blockedReason: null, onChoose })))
const key = (element: Element, name: string) =>
  act(() => { element.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true })) })
const menuItems = () => [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]

describe('NextStepButton menu', () => {
  it('opens from the keyboard on the step itself when diverged branches have no default, and returns focus on Escape', async () => {
    const onChoose = vi.fn()
    render(onChoose)
    const main = host.querySelector<HTMLButtonElement>('.side-card-git-next-main')!
    expect(main.getAttribute('aria-haspopup')).toBe('menu')
    main.focus()
    key(main, 'ArrowDown')
    expect(menuItems().map((item) => item.textContent)).toEqual(['Rebase mine on top', 'Merge'])
    expect(main.getAttribute('aria-expanded')).toBe('true')

    const menu = document.querySelector('[role="menu"]')!
    key(menu, 'Escape')
    expect(menuItems()).toHaveLength(0)
    expect(document.activeElement).toBe(main)
    expect(onChoose).not.toHaveBeenCalled()
  })

  it('runs the chosen way and gives focus back to ▾ when the menu opened from it', () => {
    const onChoose = vi.fn()
    render(onChoose)
    const split = host.querySelector<HTMLButtonElement>('.side-card-git-next-split')!
    act(() => split.click())
    act(() => menuItems()[1].click())
    expect(onChoose).toHaveBeenCalledWith({ kind: 'pull', strategy: 'merge' })
    expect(document.activeElement).toBe(split)
  })

  it('runs a fast-forward pull at once, with no menu', () => {
    const onChoose = vi.fn()
    render(onChoose, { kind: 'pull', label: 'Pull 2 commits', title: 'From origin/main, fast-forward', strategies: ['ff-only'] })
    expect(host.querySelector('.side-card-git-next-split')).toBeNull()
    act(() => host.querySelector<HTMLButtonElement>('.side-card-git-next-main')!.click())
    expect(onChoose).toHaveBeenCalledWith({ kind: 'pull', strategy: 'ff-only' })
  })

  it('waits while another Git action runs', () => {
    const onChoose = vi.fn()
    act(() => root.render(createElement(NextStepButton, { step: DIVERGED, busy: null, blockedReason: 'Another Git action is running', onChoose })))
    act(() => host.querySelector<HTMLButtonElement>('.side-card-git-next-split')!.click())
    expect(menuItems()).toHaveLength(0)
  })
})
