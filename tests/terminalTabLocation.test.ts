import { describe, expect, it } from 'vitest'
import { folderName, terminalLocations } from '../src/renderer/lib/folderLabel'
import { surfaceTabItems } from '../src/renderer/lib/surfaces'
import type { ProjectTerminalTab } from '../src/shared/types'

const tab = (id: string, title: string, cwd?: string): ProjectTerminalTab => ({
  id, ownerThreadId: null, ptyId: `pty-${id}`, cwd, title, exited: false
})

describe('folder names', () => {
  it('names a folder by its last part, on any platform', () => {
    expect(folderName('/work/mousse')).toBe('mousse')
    expect(folderName('/work/mousse/')).toBe('mousse')
    expect(folderName('C:\\code\\app\\')).toBe('app')
    expect(folderName('/')).toBe('/')
    expect(folderName(null)).toBeNull()
    expect(folderName('')).toBeNull()
  })
})

describe('terminal tab locations', () => {
  it('keeps two terminals with the same name in different folders apart, from the folder the app started them in', () => {
    const tabs = [tab('a', 'dev server', '/work/mousse'), tab('b', 'dev server', '/work/mousse-wt/fix-login')]
    const locations = terminalLocations(tabs.map(({ id, cwd }) => ({ id, cwd })))
    const items = surfaceTabItems({ opened: ['terminal'], terminals: tabs, browsers: [], documents: [], terminalLocations: locations })
    expect(items.map((item) => item.label)).toEqual(['dev server', 'dev server'])
    expect(items.map((item) => item.detail)).toEqual(['mousse', 'fix-login'])
    expect(items[0].title).toBe('dev server · /work/mousse')
    expect(items[1].title).toBe('dev server · /work/mousse-wt/fix-login')
  })

  it('adds the parent when two folders on one computer share a name', () => {
    const locations = terminalLocations([
      { id: 'a', cwd: '/work/one/app' },
      { id: 'b', cwd: '/work/two/app' },
      { id: 'c', cwd: '/work/one/app' }
    ])
    expect(locations.a.label).toBe('one/app')
    expect(locations.b.label).toBe('two/app')
    expect(locations.c.label).toBe('one/app')
  })

  it('names the computer only when the same folder name is open on two computers', () => {
    const alone = terminalLocations([{ id: 'r', cwd: '/srv/app', node: 'nod_x', computerName: 'Studio' }])
    expect(alone.r).toEqual({ label: 'app', title: '/srv/app on Studio' })

    const both = terminalLocations([
      { id: 'l', cwd: '/work/app' },
      { id: 'r', cwd: '/srv/app', node: 'nod_x', computerName: 'Studio' }
    ])
    expect(both.l.label).toBe('app · This computer')
    expect(both.r.label).toBe('app · Studio')
  })

  it('shows no folder for a terminal that has not started yet', () => {
    const items = surfaceTabItems({
      opened: ['terminal'],
      terminals: [tab('a', 'Terminal 1')],
      browsers: [],
      documents: [],
      terminalLocations: terminalLocations([{ id: 'a' }])
    })
    expect(items[0].detail).toBeUndefined()
    expect(items[0].title).toBeUndefined()
  })
})
