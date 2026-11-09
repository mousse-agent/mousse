// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FilesPathBar, type FilesPlaceItem } from '../../src/renderer/components/FilesPathBar'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement
let onNavigate: ReturnType<typeof vi.fn>

const quickPlaces: FilesPlaceItem[] = [
  { kind: 'thread', label: 'Thread folder', path: 'J:\\wt\\task' },
  { kind: 'project', label: 'Project folder', path: 'E:\\repo' },
  { kind: 'home', label: 'Home', path: 'C:\\Users\\me' }
]
const loadDrives = async (): Promise<FilesPlaceItem[]> => [
  { kind: 'drive', label: 'C:', path: 'C:\\' },
  { kind: 'drive', label: 'D:', path: 'D:\\' }
]

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  onNavigate = vi.fn(async () => null)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const flush = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) }) }
const render = (path: string, canBrowse = true) => act(async () => root.render(createElement(FilesPathBar, {
  path, canBrowse, quickPlaces, loadDrives, onNavigate, onNavigateTyped: async () => null, editRequest: 0
})))
const crumb = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('.files-path-crumb')].find((button) => button.textContent === label)!

describe('the Files path bar', () => {
  it('shows the folder as segments and goes to a segment’s folder', async () => {
    await render('C:\\Users\\me\\code')
    expect([...host.querySelectorAll('.files-path-crumb')].map((button) => button.textContent)).toEqual(['C:', 'Users', 'me', 'code'])
    expect(crumb('code').getAttribute('aria-current')).toBe('location')
    await act(async () => crumb('Users').click())
    expect(onNavigate).toHaveBeenCalledWith('C:\\Users')
  })

  it('goes up one folder, and cannot from a drive', async () => {
    await render('C:\\Users\\me')
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Up one folder"]')!.click())
    expect(onNavigate).toHaveBeenCalledWith('C:\\Users')
    await render('C:\\')
    expect(host.querySelector<HTMLButtonElement>('[aria-label="Up one folder"]')!.disabled).toBe(true)
  })

  it('opens the quick entries and drives from the first segment, marking where the tree is', async () => {
    await render('C:\\Users\\me')
    await act(async () => crumb('C:').click())
    await flush()
    const items = [...document.querySelectorAll<HTMLButtonElement>('.files-places-menu [role="menuitem"]')]
    expect(items.map((item) => item.textContent)).toEqual(['Thread folder', 'Project folder', 'Home', 'C:', 'D:'])
    expect(items[2]!.getAttribute('aria-current')).toBe('location')
    await act(async () => items[4]!.click())
    expect(onNavigate).toHaveBeenCalledWith('D:\\')
    expect(document.querySelector('.files-places-menu')).toBeNull()
  })

  it('closes the menu with Escape, back on its button', async () => {
    await render('C:\\Users\\me')
    await act(async () => crumb('C:').click())
    await flush()
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
    expect(document.querySelector('.files-places-menu')).toBeNull()
    expect(document.activeElement).toBe(host.querySelector('.files-path-crumb.root'))
  })

  it('edits the path as text from the empty part of the bar; Escape puts the segments back', async () => {
    await render('C:\\Users\\me')
    await act(async () => host.querySelector<HTMLElement>('.files-path-crumbs')!.click())
    const input = host.querySelector<HTMLInputElement>('.files-path-input')!
    expect(input.value).toBe('C:\\Users\\me')
    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
    expect(host.querySelector('.files-path-input')).toBeNull()
  })

  it('shows a thread of another computer’s folder without changing it', async () => {
    await render('/srv/app', false)
    expect(host.querySelector('.files-path-crumb.root')).toBeNull()
    expect(crumb('srv').disabled).toBe(true)
    await act(async () => host.querySelector<HTMLElement>('.files-path-crumbs')!.click())
    expect(host.querySelector('.files-path-input')).toBeNull()
  })
})
