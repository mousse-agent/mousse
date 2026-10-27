import { afterEach, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newId } from '../../../../src/shared/net'
import { BRIDGE_REMOTE_METHODS } from '../../../../src/mms/bridge/remote'
import { matchProject } from '../../../../src/mms/bridge/remote/projectMatch'
import { executeBridgeHubLocal, validateBridgeHubLocal } from '../../../../src/mms/bridge/hub'
import { dispatchMethod } from '../../../../src/mms/protocol/handlers'
import { fixture, cleanup, resources } from './fixture'
afterEach(cleanup)

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const C = 'c'.repeat(40)

function folder(): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), 'mousse-match-')))
  resources.push(() => rmSync(path, { recursive: true, force: true }))
  return path
}
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', ...args], {
    cwd,
    encoding: 'utf8'
  }).trim()
}
/** A repository with one commit, optionally a clone of another, and its remote set to `remote`. */
function repository(remote?: string, from?: string): { path: string; root: string } {
  const path = folder()
  if (from) git(path, 'clone', '-q', from, '.')
  else {
    git(path, 'init', '-q')
    git(path, 'commit', '-q', '--allow-empty', '-m', `root ${Math.random()}`)
  }
  if (remote) {
    if (from) git(path, 'remote', 'set-url', 'origin', remote)
    else git(path, 'remote', 'add', 'origin', remote)
  }
  return { path, root: git(path, 'rev-list', '--max-parents=0', 'HEAD') }
}

it('picks the one project whose root commits overlap, and breaks a tie by a shared remote', () => {
  const candidate = (id: string, roots: string[], remotes: string[] = []) => ({ id, identity: { roots, remotes } })
  expect(matchProject({ roots: [A], remotes: [] }, [candidate('one', [B]), candidate('two', [A, C])])).toBe('two')
  expect(matchProject({ roots: [A, B], remotes: [] }, [candidate('one', [C])])).toBeUndefined()
  // A folder that is not a repository never matches.
  expect(matchProject({ roots: [A], remotes: [] }, [{ id: 'plain', identity: null }])).toBeUndefined()
  // Two clones: the one that shares a normalized remote wins.
  const clones = [candidate('x', [A], ['example.com/x']), candidate('y', [A], ['example.com/y'])]
  expect(matchProject({ roots: [A], remotes: ['example.com/y'] }, clones)).toBe('y')
  // Still ambiguous: no shared remote, or both share one.
  expect(matchProject({ roots: [A], remotes: ['example.com/z'] }, clones)).toBeUndefined()
  expect(matchProject({ roots: [A], remotes: [] }, clones)).toBeUndefined()
  expect(matchProject({ roots: [A], remotes: ['example.com/x', 'example.com/y'] }, clones)).toBeUndefined()
})

it('matches a project of the target by a shared root commit, and answers an id, never a path', async () => {
  const f = await fixture(),
    mine = repository('https://example.com/org/app.git'),
    theirs = repository('git@example.com:org/app.git', mine.path),
    other = repository(),
    plain = folder()
  for (const path of [other.path, plain, theirs.path]) f.mms.projects.openProject(path)
  const project = f.mms.projects.listProjects().find((entry) => entry.path === theirs.path)!
  await f.connect()
  const ask = (roots: string[], remotes: string[] = []) =>
    executeBridgeHubLocal(f.hub(), 'bridge.hub.matchProject', {
      target: f.targetNode,
      roots,
      remotes,
      options: { id: newId('rpc') }
    })
  const answer = await ask([mine.root], ['example.com/org/app'])
  expect(answer).toEqual({ projectId: project.id })
  expect(JSON.stringify(answer)).not.toContain(theirs.path)
  // A repository with different history, or a folder that is not one, has no match.
  expect(await ask([A])).toEqual({})
  expect(await ask([other.root])).toMatchObject({ projectId: expect.any(String) })
  expect(await ask([B], ['example.com/org/app'])).toEqual({})
  // The target reads each repository once for a few minutes: the identity survives its repository going away.
  rmSync(join(theirs.path, '.git'), { recursive: true, force: true })
  expect(await ask([mine.root])).toEqual({ projectId: project.id })
})

it('prefers the clone that shares a remote and refuses to guess between the rest', async () => {
  const f = await fixture(),
    base = repository(),
    x = repository('https://example.com/org/x.git', base.path),
    y = repository('https://example.com/org/y.git', base.path)
  f.mms.projects.openProject(x.path)
  f.mms.projects.openProject(y.path)
  const idOf = (path: string) => f.mms.projects.listProjects().find((entry) => entry.path === path)!.id
  await f.connect()
  const ask = (remotes: string[]) =>
    executeBridgeHubLocal(f.hub(), 'bridge.hub.matchProject', { target: f.targetNode, roots: [base.root], remotes })
  expect(await ask(['example.com/org/y'])).toEqual({ projectId: idOf(y.path) })
  expect(await ask(['example.com/org/x'])).toEqual({ projectId: idOf(x.path) })
  expect(await ask(['example.com/org/other'])).toEqual({})
  expect(await ask([])).toEqual({})
})

it('is read-only, needs the read capability, and validates its input before anything runs', async () => {
  expect(BRIDGE_REMOTE_METHODS['projects.match']).toEqual({ capability: 'read', mutating: false })
  const denied = await fixture(['chat', 'write'])
  await denied.connect()
  await expect(
    executeBridgeHubLocal(denied.hub(), 'bridge.hub.matchProject', { target: denied.targetNode, roots: [A] })
  ).rejects.toMatchObject({ code: 'forbidden' })
  const f = await fixture(['read'])
  await f.connect()
  expect(
    await executeBridgeHubLocal(f.hub(), 'bridge.hub.matchProject', { target: f.targetNode, roots: [A] })
  ).toEqual({})
  const target = f.targetNode
  const refused: unknown[] = [
    { target },
    { roots: [A] },
    { target, roots: [] },
    { target, roots: ['not-a-commit'] },
    { target, roots: [A.toUpperCase()] },
    { target, roots: [A, A] },
    { target, roots: Array.from({ length: 257 }, (_, i) => i.toString(16).padStart(40, '0')) },
    { target, roots: [A], remotes: 'example.com/x' },
    { target, roots: [A], remotes: Array.from({ length: 65 }, (_, i) => `example.com/${i}`) },
    { target, roots: [A], remotes: ['x'.repeat(513)] },
    { target, roots: [A], remotes: ['has space'] },
    { target, roots: [A], remotes: [''] },
    { target, roots: [A], path: '/tmp/x' },
    { target, roots: [A], remotes: [], projectId: 'p' }
  ]
  for (const bad of refused)
    expect(() => validateBridgeHubLocal('bridge.hub.matchProject', bad), JSON.stringify(bad)).toThrow(
      expect.objectContaining({ code: 'bad_request' })
    )
  validateBridgeHubLocal('bridge.hub.matchProject', {
    target,
    roots: Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(64, '0')),
    remotes: Array.from({ length: 64 }, (_, i) => `example.com/${i}`)
  })
})

it('reads the identity of a local project for the match, or null for a folder that is not a repository', async () => {
  const f = await fixture(),
    repo = repository('https://user@example.com/org/app.git'),
    plain = folder()
  mkdirSync(join(plain, 'src'))
  const ids = [repo.path, plain].map((path) => f.mms.projects.openProject(path).id)
  const ctx = { mms: f.mms } as never
  expect(await dispatchMethod(ctx, 'projects.identity', { projectId: ids[0] })).toEqual({
    identity: { roots: [repo.root], remotes: ['example.com/org/app'] }
  })
  expect(await dispatchMethod(ctx, 'projects.identity', { projectId: ids[1] })).toEqual({ identity: null })
  expect(await dispatchMethod(ctx, 'projects.identity', { projectId: 'unknown' })).toEqual({ identity: null })
})
