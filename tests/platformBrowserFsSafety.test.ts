import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { assertSafeTree, removeOwnedTree } from '../src/mms/browser/install/fsSafety'
import { copyBrowserTreeAsHardlinks } from './fixtures/agent-platform/managed-browser-drain/ownedTemp'
import { canCreateSymlinks } from './fixtures/browser/rawZip'

// Every case here creates links on disk, so it needs symlink support (Windows
// needs developer mode); the checks themselves are platform-neutral.
const dirLink = process.platform === 'win32' ? 'junction' : 'dir'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

/** A managed root with a tree inside it and, beside the root, an outside folder holding a canary. */
async function layout(): Promise<{ base: string; root: string; tree: string; outside: string; canary: string }> {
  const base = await mkdtemp(join(tmpdir(), 'mousse-fs-safety-'))
  roots.push(base)
  const root = join(base, 'managed')
  const tree = join(root, 'versions', 'v1')
  const outside = join(base, 'outside')
  await mkdir(join(tree, 'app', 'sub'), { recursive: true })
  await writeFile(join(tree, 'app', 'sub', 'real'), 'payload')
  await mkdir(outside)
  const canary = join(outside, 'canary.txt')
  await writeFile(canary, 'alive')
  return { base, root, tree, outside, canary }
}

describe.skipIf(!canCreateSymlinks())('managed browser tree check (used before moving a tree)', () => {
  it('accepts links that stay inside the tree when the platform allows them', async () => {
    const { root, tree } = await layout()
    await symlink('sub/real', join(tree, 'app', 'file-link'))
    await symlink('sub', join(tree, 'app', 'dir-link'), dirLink)
    await expect(assertSafeTree(tree, root, { allowContainedSymlinks: true })).resolves.toBeUndefined()
  })

  it('refuses every link when the platform does not allow them', async () => {
    const { root, tree } = await layout()
    await symlink('sub/real', join(tree, 'app', 'file-link'))
    await expect(assertSafeTree(tree, root)).rejects.toThrow(/contains a symlink/)
    await expect(assertSafeTree(tree, root, { allowContainedSymlinks: false })).rejects.toThrow(/contains a symlink/)
  })

  it.each([
    ['leaves the tree', async (tree: string, outside: string) => symlink(outside, join(tree, 'app', 'escape'), dirLink), /leaves its tree/],
    // Windows resolves a target's `..` by name before it follows links, so there this link dangles instead of leaving:
    // refused either way.
    ['leaves the tree through another link', async (tree: string) => {
      await symlink('..', join(tree, 'app', 'sub', 'up'), dirLink)
      await symlink('sub/up/../../../../outside', join(tree, 'app', 'escape'))
    }, process.platform === 'win32' ? /dangling symlink/ : /leaves its tree/],
    ['dangles', async (tree: string) => symlink('missing', join(tree, 'app', 'dangling')), /dangling symlink/],
    ['points at its own folder', async (tree: string) => symlink('../sub', join(tree, 'app', 'sub', 'self'), dirLink), /own folder or a folder above it/],
    ['points at a folder above it inside the tree', async (tree: string) => symlink('..', join(tree, 'app', 'sub', 'up'), dirLink), /own folder or a folder above it/]
  ])('refuses a link that %s', async (_label, plant, error) => {
    const { root, tree, outside } = await layout()
    await plant(tree, outside)
    await expect(assertSafeTree(tree, root, { allowContainedSymlinks: true })).rejects.toThrow(error)
  })
})

describe.skipIf(!canCreateSymlinks())('managed browser tree removal', () => {
  it('unlinks outward, dangling and inward links without following them', async () => {
    const { root, tree, outside, canary } = await layout()
    await symlink(outside, join(tree, 'app', 'to-outside-dir'), dirLink)
    await symlink('../../../../../outside', join(tree, 'app', 'sub', 'to-outside-relative'), dirLink)
    await symlink(canary, join(tree, 'app', 'to-canary'))
    await symlink('missing', join(tree, 'app', 'dangling'))
    await symlink('sub', join(tree, 'app', 'inward'), dirLink)
    // Both outward links really reach the canary's folder before removal.
    expect(await readdir(join(tree, 'app', 'to-outside-dir'))).toEqual(['canary.txt'])
    expect(await readdir(join(tree, 'app', 'sub', 'to-outside-relative'))).toEqual(['canary.txt'])
    await removeOwnedTree(tree, root)
    expect(existsSync(tree)).toBe(false)
    expect(await readFile(canary, 'utf8')).toBe('alive')
    expect(await readdir(outside)).toEqual(['canary.txt'])
  })

  it('refuses when the path down to the tree goes through a link, and the canary survives', async () => {
    const { base, root, outside, canary } = await layout()
    await symlink(outside, join(root, 'linked'), dirLink)
    await expect(removeOwnedTree(join(root, 'linked', 'canary.txt'), root)).rejects.toThrow(/contains a symlink/)
    await expect(removeOwnedTree(join(root, 'linked'), root)).rejects.toThrow(/contains a symlink/)
    await expect(removeOwnedTree(outside, root)).rejects.toThrow(/escapes its root/)
    expect(await readFile(canary, 'utf8')).toBe('alive')
    expect(existsSync(join(base, 'managed', 'linked'))).toBe(true)
  })
})

describe.skipIf(!canCreateSymlinks())('test fixture browser copy', () => {
  it('copies links that stay inside the tree as links', async () => {
    const { base, tree } = await layout()
    await symlink('sub/real', join(tree, 'app', 'file-link'))
    const copy = join(base, 'copy')
    copyBrowserTreeAsHardlinks(tree, copy)
    expect(await readFile(join(copy, 'app', 'file-link'), 'utf8')).toBe('payload')
  })

  it('refuses a link routed out through another link, a dangling link, and a link to its own folder', async () => {
    for (const plant of [
      async (tree: string) => { await symlink('..', join(tree, 'app', 'sub', 'up'), dirLink); await symlink('sub/up/../../../../outside', join(tree, 'app', 'escape')) },
      async (tree: string) => symlink('missing', join(tree, 'app', 'dangling')),
      async (tree: string) => symlink('.', join(tree, 'app', 'self'), dirLink)
    ]) {
      const { base, tree } = await layout()
      await plant(tree)
      expect(() => copyBrowserTreeAsHardlinks(tree, join(base, 'copy'))).toThrow(/symlink/)
    }
  })
})
