import { afterEach, describe, expect, it, vi } from 'vitest'
import { ensureProjectIcon, projectIconUrl, setProjectIconReaderForTests } from '../../src/renderer/lib/projectIcons'
import { projectIconMenuActions } from '../../src/renderer/lib/projectIconActions'
import type { Project } from '../../src/shared/types'

const project = (fields: Partial<Project> = {}): Project => ({ id: 'p1', name: 'Mousse', path: '/repo', createdAt: '', order: 0, ...fields })
const icon = { dataUrl: 'data:image/svg+xml;base64,PHN2Zy8+', source: 'auto' as const, path: 'favicon.svg' }
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

afterEach(() => {
  setProjectIconReaderForTests(undefined)
  delete (globalThis as { mousse?: unknown }).mousse
})

describe('project icons in the window', () => {
  it('shows the icon the daemon answers, and asks again when the icon choice changes', async () => {
    const reader = vi.fn(async () => icon)
    setProjectIconReaderForTests(reader)
    ensureProjectIcon(project())
    ensureProjectIcon(project())
    await settle()
    expect(reader).toHaveBeenCalledTimes(1)
    expect(projectIconUrl(project())).toBe(icon.dataUrl)
    ensureProjectIcon(project({ iconPath: 'art/mark.png' }))
    await settle()
    expect(reader).toHaveBeenCalledTimes(2)
  })

  it("keeps the folder for another computer's project and for icons off, without asking", async () => {
    const reader = vi.fn(async () => icon)
    setProjectIconReaderForTests(reader)
    ensureProjectIcon(project({ node: 'mac' }))
    ensureProjectIcon(project({ iconOff: true }))
    await settle()
    expect(reader).not.toHaveBeenCalled()
    expect(projectIconUrl(project({ node: 'mac' }))).toBeNull()
  })

  it('shows folders when an older daemon does not know icons, and stops asking', async () => {
    const reader = vi.fn(async () => { throw new Error('Unhandled method: projects.icon') })
    setProjectIconReaderForTests(reader)
    ensureProjectIcon(project())
    await settle()
    ensureProjectIcon(project({ id: 'p2' }))
    await settle()
    expect(reader).toHaveBeenCalledTimes(1)
    expect(projectIconUrl(project())).toBeNull()
  })

  it('ignores an answer that is not an image data URL', async () => {
    setProjectIconReaderForTests(async () => ({ ...icon, dataUrl: 'javascript:alert(1)' }))
    ensureProjectIcon(project())
    await settle()
    expect(projectIconUrl(project())).toBeNull()
  })
})

describe('project icon menu items', () => {
  const withApi = () => {
    const api = { setIcon: vi.fn(async () => ({})), pickIcon: vi.fn(async () => '/repo/art/mark.png') }
    ;(globalThis as { mousse?: unknown }).mousse = { projects: api }
    return api
  }

  it('offers nothing without icon support or for another computer', () => {
    expect(projectIconMenuActions(project(), () => {})).toEqual({})
    withApi()
    expect(projectIconMenuActions(project({ node: 'mac' }), () => {})).toEqual({})
  })

  it('offers Reset only after a choice, and Use folder icon only while an image shows', () => {
    withApi()
    expect(Object.keys(projectIconMenuActions(project(), () => {}))).toEqual(['onChangeIcon'])
    expect(Object.keys(projectIconMenuActions(project({ detectedIconPath: 'favicon.svg' }), () => {}))).toEqual(['onChangeIcon', 'onUseFolderIcon'])
    expect(Object.keys(projectIconMenuActions(project({ iconOff: true, detectedIconPath: 'favicon.svg' }), () => {}))).toEqual(['onChangeIcon', 'onResetIcon'])
  })

  it('saves the picked file, picked from the project folder', async () => {
    const api = withApi()
    projectIconMenuActions(project(), () => {}).onChangeIcon!()
    await settle()
    expect(api.pickIcon).toHaveBeenCalledWith('/repo')
    expect(api.setIcon).toHaveBeenCalledWith('p1', { mode: 'custom', path: '/repo/art/mark.png' })
  })
})
