import { describe, expect, it } from 'vitest'
import { githubRepository, joinFolder, newProjectRows, parentFolder, projectFolders, sameFolder, usualParent, withExisting } from '../../src/renderer/components/newProjectLogic'

describe('githubRepository', () => {
  it.each([
    ['acme/web-app', 'acme/web-app'],
    ['https://github.com/acme/web-app', 'acme/web-app'],
    ['https://github.com/acme/web-app.git', 'acme/web-app'],
    ['github.com/acme/web-app/', 'acme/web-app'],
    ['git@github.com:acme/web-app.git', 'acme/web-app'],
    ['  acme/web.app  ', 'acme/web.app'],
    ['https://gitlab.com/acme/web-app', null],
    ['/Users/me/web-app', null],
    ['web-app', null],
    ['acme/web app', null]
  ])('%j → %j', (text, expected) => {
    expect(githubRepository(text)).toBe(expected)
  })
})

describe('folders', () => {
  it.each([
    ['C:\\dev', 'web-app', 'C:\\dev\\web-app'],
    ['C:\\dev\\', 'web-app', 'C:\\dev\\web-app'],
    ['/Users/me/dev/', 'web-app', '/Users/me/dev/web-app']
  ])('joins %j and %j', (parent, name, expected) => {
    expect(joinFolder(parent, name)).toBe(expected)
  })

  it.each([
    ['/Users/me/dev/web-app', '/Users/me/dev'],
    ['C:\\dev\\web-app', 'C:\\dev'],
    ['C:\\web-app', 'C:\\'],
    ['/web-app', null]
  ])('the folder %j is in: %j', (path, expected) => {
    expect(parentFolder(path)).toBe(expected)
  })

  it('takes the folder most projects are in as the place for new ones', () => {
    expect(usualParent(['C:\\dev\\a', 'C:\\work\\b', 'C:\\dev\\c'])).toBe('C:\\dev')
    expect(usualParent([])).toBeNull()
  })

  it('lists another computer\'s project folders once each, ready for a name', () => {
    expect(projectFolders(['/Users/me/dev/a', '/Users/me/dev/b', '/srv/site'])).toEqual(['/srv/', '/Users/me/dev/'])
  })
})

describe('newProjectRows', () => {
  const here = { remote: false as const, parent: 'C:\\dev' }
  const kinds = (text: string, where: Parameters<typeof newProjectRows>[1] = here) =>
    newProjectRows(text, where).flatMap((group) => group.rows.map((row) => row.kind))

  it.each([
    ['', ['open-folder', 'clone-hint', 'new-hint']],
    ['github.com/acme/web-app', ['clone', 'create']],
    ['C:\\work\\api', ['add-path']],
    ['~/dev/api', ['add-path']],
    ['https://gitlab.com/acme/api', ['not-github']],
    ['my notes', ['create']],
    ['what?!', []]
  ])('on this computer, %j offers %j', (text, expected) => {
    expect(kinds(text)).toEqual(expected)
  })

  it('puts a clone and a new project in the folder for new projects, or asks first when there is none', () => {
    const [clone] = newProjectRows('acme/web-app', here)[0]!.rows
    expect(clone).toEqual({ kind: 'clone', repository: 'acme/web-app', name: 'web-app', destination: 'C:\\dev\\web-app' })
    expect(newProjectRows('notes', { remote: false, parent: null })[0]!.rows[0]).toMatchObject({ kind: 'create', destination: null })
  })

  it('on another computer, offers its project folders and adds only a full path', () => {
    const there = { remote: true as const, computer: 'Mac mini', folders: ['/Users/me/dev/', '/srv/'] }
    expect(kinds('', there)).toEqual(['suggest', 'suggest'])
    expect(kinds('/Users/me/dev/api', there)).toEqual(['add-path'])
    expect(kinds('/Users/', there)).toEqual(['add-path', 'suggest'])
    expect(kinds('acme/web-app', there)).toEqual([])
  })
})

describe('a folder that is already a project', () => {
  it.each([
    ['C:\\dev\\notes', 'c:\\DEV\\notes\\', true],
    ['/Users/me/notes', '/Users/me/notes/', true],
    ['/Users/me/notes', '/Users/me/Notes', false],
    ['/Users/me/notes', '/Users/me/notes2', false]
  ])('%j and %j are the same folder: %s', (a, b, same) => {
    expect(sameFolder(a, b)).toBe(same)
  })

  it('turns a clone and a new project there into one Open row', () => {
    const groups = newProjectRows('acme/notes', { remote: false, parent: '/Users/me/dev' })
    const existing = { id: 'p1', name: 'notes', path: '/Users/me/dev/notes' }
    expect(withExisting(groups, (path) => (sameFolder(path, existing.path) ? existing : undefined))).toEqual([
      { label: 'Open', rows: [{ kind: 'existing', projectId: 'p1', name: 'notes', path: '/Users/me/dev/notes' }] }
    ])
    expect(withExisting(groups, () => undefined)).toEqual(groups)
  })
})
