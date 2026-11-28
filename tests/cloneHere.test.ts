import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { cloneHere, type CloneHereServices } from '../src/mms/sourceControl/cloneHere'
import type { Project } from '../src/shared/types'

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim()
const action = { via: 'device', label: 'Clone repository' } as const

let root: string
let source: string
beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'clone-here-')))
  // The repository "on GitHub": main, and a branch the other computer's draft is on.
  source = join(root, 'source')
  mkdirSync(source)
  git(source, 'init', '-q', '-b', 'main')
  git(source, 'config', 'user.email', 'test@example.com')
  git(source, 'config', 'user.name', 'Test')
  writeFileSync(join(source, 'README.md'), 'main')
  git(source, 'add', '.')
  git(source, 'commit', '-q', '-m', 'main')
  git(source, 'switch', '-q', '-c', 'feature')
  writeFileSync(join(source, 'feature.txt'), 'feature')
  git(source, 'add', '.')
  git(source, 'commit', '-q', '-m', 'feature')
  git(source, 'switch', '-q', 'main')
})
afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

/** A clone from the local repository, where `gh repo clone` would fetch from GitHub; projects are kept in a list. */
function services(overrides: Partial<CloneHereServices> = {}): CloneHereServices & { projects: Project[] } {
  const projects: Project[] = []
  return {
    projects,
    clone: async ({ destination }) => {
      execFileSync('git', ['clone', '-q', source, destination], { windowsHide: true })
      return destination
    },
    openProject: (path) => {
      const project = { id: `p${projects.length}`, name: 'web-app', path, createdAt: '', order: 0 }
      projects.push(project)
      return project
    },
    homes: [join(root, 'mousse-home')],
    ...overrides
  }
}

describe('a clone for another computer', () => {
  it.each([
    ['a branch the repository has', 'feature', 'feature', 'feature'],
    ['a branch it does not have', 'gone', 'main', undefined],
    ['no branch', undefined, 'main', undefined]
  ])('with %s, checks out %s', async (_label, branch, head, reported) => {
    const path = join(root, `web-app-${branch ?? 'none'}`)
    const here = services()
    const result = await cloneHere({ repository: 'acme/web-app', path, ...(branch ? { branch } : {}) }, here, action)
    expect(git(path, 'branch', '--show-current')).toBe(head)
    expect(result.branch).toBe(reported)
    expect(here.projects.map((project) => project.path)).toEqual([path])
  })

  it('leaves nothing when the project cannot be added: a folder it made goes, an empty one it found stays empty', async () => {
    const failing = () => services({ openProject: () => { throw new Error('no database') } })
    const made = join(root, 'made')
    await expect(cloneHere({ repository: 'acme/web-app', path: made }, failing(), action)).rejects.toThrow('no database')
    expect(existsSync(made)).toBe(false)

    const found = join(root, 'found')
    mkdirSync(found)
    await expect(cloneHere({ repository: 'acme/web-app', path: found }, failing(), action)).rejects.toThrow('no database')
    expect(readdirSync(found)).toEqual([])
  })

  it('makes the folders it goes in when they are not there, and they go again when the clone or the project fails', async () => {
    const path = join(root, 'new', 'deeper', 'web-app')
    const here = services()
    await cloneHere({ repository: 'acme/web-app', path }, here, action)
    expect(git(path, 'branch', '--show-current')).toBe('main')
    expect(here.projects.map((project) => project.path)).toEqual([path])

    const failures: Partial<CloneHereServices>[] = [
      { clone: async () => { throw new Error('gh failed') } },
      { openProject: () => { throw new Error('no database') } }
    ]
    mkdirSync(join(root, 'kept'))
    for (const failure of failures) {
      await expect(cloneHere({ repository: 'acme/web-app', path: join(root, 'kept', 'made', 'web-app') }, services(failure), action)).rejects.toThrow()
      expect(readdirSync(join(root, 'kept'))).toEqual([])
    }
  })

  it('refuses before cloning or making a folder: one with files, one in the data folder, a file in the way, and a new hidden folder', async () => {
    const full = join(root, 'full')
    mkdirSync(full)
    writeFileSync(join(full, 'mine.txt'), 'mine')
    writeFileSync(join(root, 'a-file'), 'file')
    mkdirSync(join(root, 'mousse-home'), { recursive: true })
    const clone = vi.fn(async () => '')
    const refused = [full, join(root, 'mousse-home', 'new', 'web-app'), join(root, 'a-file', 'new', 'web-app'), join(root, 'out', '.hidden', 'web-app')]
    for (const path of refused) {
      await expect(cloneHere({ repository: 'acme/web-app', path }, services({ clone }), action), path).rejects.toThrow()
    }
    expect(clone).not.toHaveBeenCalled()
    expect(readdirSync(full)).toEqual(['mine.txt'])
    expect(existsSync(join(root, 'mousse-home', 'new'))).toBe(false)
    expect(existsSync(join(root, 'out'))).toBe(false)
  })
})
