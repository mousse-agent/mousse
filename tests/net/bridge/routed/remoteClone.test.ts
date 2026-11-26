/**
 * New project's Clone with another computer picked, over two real daemons linked by Bridge: a window of the caller
 * browses the owner's folders, clones a repository there into a folder there, and the owner adds it as its project.
 * GitHub is never reached: the owner's `gh repo clone` is replaced by a local folder, and its GitHub sign-in by a stub.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { GitHubService } from '../../../../src/mms/git/GitHubService'
import { GitHubAccount } from '../../../../src/mms/git/GitHubAccount'
import { cleanupAll, homeOf, linked } from './routerFixture'

let t: Awaited<ReturnType<typeof linked>>
let folder: string
beforeAll(async () => {
  t = await linked()
  folder = realpathSync(mkdtempSync(join(tmpdir(), 'remote-clone-')))
}, 120_000)
afterAll(async () => {
  rmSync(folder, { recursive: true, force: true })
  await cleanupAll()
})
afterEach(() => {
  vi.restoreAllMocks()
})

/** The owner's clone: a folder with a file, where `gh repo clone` would have put the repository. */
const cloneMakesFolder = () =>
  vi.spyOn(GitHubService.prototype, 'cloneRepository').mockImplementation(async (input) => {
    mkdirSync(input.destination, { recursive: true })
    writeFileSync(join(input.destination, 'README.md'), 'cloned')
    return input.destination
  })

describe('Clone on another computer', () => {
  it('clones into a folder there and adds it as a project there, never here', async () => {
    const cloned = cloneMakesFolder()
    const destination = join(folder, 'web-app')
    const result = await t.dispatch('sourceControl.clone', { node: t.node, provider: 'github', repository: 'acme/web-app', path: destination })
    expect(cloned).toHaveBeenCalledWith({ repository: 'acme/web-app', destination }, expect.objectContaining({ via: 'device' }))
    expect(result.project.id).toBe(t.qualified(result.project.id.split(':').pop()))
    expect(t.owner.projects.listProjects().map((project) => project.path)).toContain(destination)
    expect(t.caller.projects.listProjects().map((project) => project.path)).not.toContain(destination)
  }, 60_000)

  it("refuses a folder in the owner's data folder or one that is not empty, and makes nothing", async () => {
    const cloned = cloneMakesFolder()
    const full = join(folder, 'full')
    mkdirSync(full)
    writeFileSync(join(full, 'notes.txt'), 'mine')
    const refusals = [
      join(homeOf.get(t.owner)!, 'web-app'),
      full,
      join(folder, 'missing-parent', 'web-app'),
      'relative/web-app',
      // Hidden folders: the clone itself, or the folder it goes in.
      join(folder, '.web-app'),
      join(folder, '.private')
    ]
    mkdirSync(join(folder, '.private'), { recursive: true })
    refusals.push(join(folder, '.private', 'web-app'))
    for (const path of refusals) {
      const refused = await t.refused(t.dispatch('sourceControl.clone', { node: t.node, provider: 'github', repository: 'acme/web-app', path }))
      expect(refused.message, path).toBeTruthy()
    }
    expect(cloned).not.toHaveBeenCalled()
    expect(existsSync(join(homeOf.get(t.owner)!, 'web-app'))).toBe(false)
    expect(readdirSync(full)).toEqual(['notes.txt'])
  }, 60_000)

  it("lists the owner's folders by name to browse, without hidden ones or its data folder", async () => {
    mkdirSync(join(folder, 'dev'), { recursive: true })
    mkdirSync(join(folder, '.secret'), { recursive: true })
    writeFileSync(join(folder, 'file.txt'), 'x')
    const listed = await t.dispatch('folders.browse', { node: t.node, path: folder })
    const names = listed.folders.map((entry: { name: string }) => entry.name)
    expect(names).toContain('dev')
    expect(names).not.toContain('.secret')
    expect(names).not.toContain('file.txt')
    const refused = await t.refused(t.dispatch('folders.browse', { node: t.node, path: homeOf.get(t.owner)! }))
    expect(refused.code).toBe('forbidden')
    // A hidden folder named outright, or a folder inside one, is refused like it is left out of the list.
    mkdirSync(join(folder, '.secret', 'inner'), { recursive: true })
    for (const path of [join(folder, '.secret'), join(folder, '.secret', 'inner')]) {
      expect((await t.refused(t.dispatch('folders.browse', { node: t.node, path }))).code, path).toBe('forbidden')
    }
  }, 60_000)

  it('gives the one-time code only to the computer that started Connect, not to one that only views', async () => {
    const operation = { id: 'op1', phase: 'code' as const, code: 'AB12-CD34', url: 'https://github.com/login/device' }
    const signingIn = { id: 'github' as const, name: 'GitHub', state: 'signed-out' as const, operation }
    vi.spyOn(GitHubAccount.prototype, 'status').mockResolvedValue(signingIn)
    vi.spyOn(GitHubAccount.prototype, 'connect').mockResolvedValue(signingIn)
    // Started elsewhere: this computer, with view access only, sees that a sign-in waits, not its code.
    const viewed = await t.dispatch('sourceControl.status', { node: t.node })
    expect(viewed.providers[0].operation).toEqual({ id: 'op1', phase: 'code' })
    await t.owner.net.request('bridge.policy', { node: t.callerNode, terminal: true })
    try {
      // Started from here: the code comes back, and with every status read after it.
      expect((await t.dispatch('sourceControl.connect', { node: t.node, provider: 'github' })).operation).toEqual(operation)
      expect((await t.dispatch('sourceControl.status', { node: t.node })).providers[0].operation).toEqual(operation)
    } finally {
      await t.owner.net.request('bridge.policy', { node: t.callerNode, terminal: false })
    }
  }, 60_000)

  it('connects GitHub there only while that computer lets this one use its terminal', async () => {
    const connected = vi.spyOn(GitHubAccount.prototype, 'connect').mockResolvedValue({ id: 'github', name: 'GitHub', state: 'connected', account: 'me' })
    await t.owner.net.request('bridge.policy', { node: t.callerNode, terminal: false })
    const refused = await t.refused(t.dispatch('sourceControl.connect', { node: t.node, provider: 'github' }))
    expect(refused.message).toMatch(/terminal/)
    expect(connected).not.toHaveBeenCalled()
    await t.owner.net.request('bridge.policy', { node: t.callerNode, terminal: true })
    try {
      const status = await t.dispatch('sourceControl.connect', { node: t.node, provider: 'github' })
      expect(status).toMatchObject({ state: 'connected', account: 'me' })
      expect(connected).toHaveBeenCalledWith(expect.objectContaining({ via: 'device' }))
    } finally {
      await t.owner.net.request('bridge.policy', { node: t.callerNode, terminal: false })
    }
  }, 60_000)
})
