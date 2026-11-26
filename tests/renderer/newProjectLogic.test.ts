import { describe, expect, it } from 'vitest'
import { browseRows, githubRepository, joinFolder, newProjectRows, parentFolder, projectFolders, repositoryMatches, sameFolder, usualParent, withExisting, withRepositories } from '../../src/renderer/components/newProjectLogic'

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

  it('on another computer, offers a clone and its project folders, and adds only a full path', () => {
    const there = { remote: true as const, computer: 'Mac mini', folders: ['/Users/me/dev/', '/srv/'], parent: '/Users/me/dev' }
    expect(kinds('', there)).toEqual(['clone-hint', 'suggest', 'suggest'])
    expect(kinds('/Users/me/dev/api', there)).toEqual(['add-path'])
    expect(kinds('/Users/', there)).toEqual(['add-path', 'suggest'])
    expect(newProjectRows('acme/web-app', there).flatMap((group) => group.rows)).toEqual([{ kind: 'clone', repository: 'acme/web-app', name: 'web-app', destination: '/Users/me/dev/web-app' }])
    // With no folder known there, the clone asks for one.
    expect(newProjectRows('acme/web-app', { ...there, parent: null }).flatMap((group) => group.rows)).toEqual([{ kind: 'clone', repository: 'acme/web-app', name: 'web-app', destination: null }])
    expect(kinds('notes', there)).toEqual([])
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


describe("the account's repositories", () => {
  // Most recently pushed first, as the daemon lists them.
  const mine = ['acme/website', 'me/web', 'acme/api', 'me/dotfiles'].map((nameWithOwner) => ({ nameWithOwner, private: false }))
  const names = (list: readonly { nameWithOwner: string }[]) => list.map((repository) => repository.nameWithOwner)

  it.each([
    ['', ['acme/website', 'me/web', 'acme/api', 'me/dotfiles']],
    // A name that starts with it, then owner/name that does, then one that contains it; the list's order within each.
    ['web', ['acme/website', 'me/web']],
    ['me/', ['me/web', 'me/dotfiles', 'acme/website', 'acme/api']],
    ['api', ['acme/api']],
    ['tfile', ['me/dotfiles']],
    ['AcMe/A', ['acme/api']],
    // The repository the text names has its own Clone row.
    ['me/web', ['acme/website']],
    ['https://github.com/me/web', []],
    ['nothing', []]
  ])('%j → %j', (text, expected) => {
    expect(names(repositoryMatches(text, mine))).toEqual(expected)
  })

  const groups = (text: string, cloning: boolean, connected: boolean | null = true) =>
    withRepositories(newProjectRows(text, { remote: false, parent: 'C:\\dev' }), text, { repositories: mine, parent: 'C:\\dev', cloning, connected })
      .map((group) => `${group.label}: ${group.rows.map((row) => (row.kind === 'clone' ? row.repository : row.kind)).join(', ')}`)

  it.each([
    // Nothing typed: Start from alone, until Clone a repository… lists the most recent first.
    ['', false, true, ['Start from: open-folder, clone-hint, new-hint']],
    ['', true, true, ['Your repositories: acme/website, me/web, acme/api, me/dotfiles', 'Start from: open-folder, clone-hint, new-hint']],
    // A name: the new project first, matches after; after Clone a repository…, matches first.
    ['api', false, true, ['New: create', 'Your repositories: acme/api']],
    ['api', true, true, ['Your repositories: acme/api', 'New: create']],
    // A path never lists repositories.
    ['C:\\dev\\api', true, true, ['Add: add-path']],
    // Not connected: Clone a repository… and a typed repository offer to connect; a name offers nothing more.
    ['', true, false, ['GitHub: connect-github', 'Start from: open-folder, clone-hint, new-hint']],
    ['acme/api', false, false, ['Clone: acme/api', 'Or: create', 'GitHub: connect-github']],
    ['api', true, false, ['New: create']],
    // Not known yet: nothing about it.
    ['', true, null, ['Your repositories: acme/website, me/web, acme/api, me/dotfiles', 'Start from: open-folder, clone-hint, new-hint']]
  ] as const)('%j (cloning %j, connected %j)', (text, cloning, connected, expected) => {
    expect(groups(text, cloning, connected)).toEqual(expected)
  })

  it('clones each into the projects folder, and opens one already there', () => {
    const rows = withExisting(
      withRepositories([], 'web', { repositories: mine, parent: 'C:\\dev', cloning: true, connected: true }),
      (path) => (path === 'C:\\dev\\web' ? { id: 'w', name: 'web', path } : undefined)
    ).flatMap((group) => group.rows)
    expect(rows).toEqual([
      { kind: 'clone', repository: 'acme/website', name: 'website', destination: 'C:\\dev\\website', owned: { private: false } },
      { kind: 'existing', projectId: 'w', name: 'web', path: 'C:\\dev\\web' }
    ])
  })
})

describe('browsing folders on another computer', () => {
  const view = { path: '/Users/me', parent: '/Users', folders: [{ name: 'dev', path: '/Users/me/dev' }, { name: 'Documents', path: '/Users/me/Documents' }] }
  const rows = (text: string, shown = view) => browseRows(shown, text, 'Mac mini').flatMap((group) => group.rows.map((row) => row.kind === 'browse-open' ? row.name : row.kind))

  it.each([
    ['', ['browse-use', '..', 'dev', 'Documents']],
    // Typing filters the folders; the way up is not one of them.
    ['doc', ['browse-use', 'Documents']]
  ])('%j → %j', (text, expected) => {
    expect(rows(text)).toEqual(expected)
  })

  it('starts from the places there, with nothing to use yet', () => {
    expect(rows('', { path: null, parent: null, folders: [{ name: 'Home', path: '/Users/me' }] })).toEqual(['Home'])
    expect(browseRows({ path: null, parent: null, folders: [] }, '', 'Mac mini')[0]!.label).toBe('Folders on Mac mini')
  })
})
