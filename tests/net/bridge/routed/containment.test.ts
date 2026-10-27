/**
 * What another of the user's computers can reach through the routed file, Git, review and Undo
 * methods stays inside the thread's folder, and a window of this computer is not held to it.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { dispatchMethod } from '../../../../src/mms/protocol/handlers'
import { ThreadWorkspaceManager } from '../../../../src/mms/workspace/ThreadWorkspaceManager'
import { isRoutedPagedReply } from '../../../../src/shared/bridge/routed'
import { cleanup, resources } from '../hub/fixture'
import { repo, routedOwner } from './routedFixture'

afterEach(async () => {
  vi.restoreAllMocks()
  await cleanup()
})

const windows = process.platform === 'win32'
const folderLink = (target: string, path: string): void =>
  symlinkSync(target, path, windows ? 'junction' : 'dir')
const fileLink = (target: string, path: string): boolean => {
  try {
    symlinkSync(target, path, 'file')
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return false
    throw error
  }
}

type Owner = Awaited<ReturnType<typeof routedOwner>>

/** A thread with a folder of its own on the owner (the first save brings its worktree up), and a folder beside it. */
async function folderThread(o: Owner) {
  const path = repo()
  const project = o.f.mms.projects.openProject(path)
  const t = o.thread('Works on files', project.id, path)
  await o.ok('files.write', { threadId: t.id, path: 'seed.txt', content: 'seed\n' })
  const root = new ThreadWorkspaceManager(o.f.mms.threads.getThreadDir(t.id)).load()!.worktreePath
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'routed-outside-')))
  resources.push(() => rmSync(outside, { recursive: true, force: true }))
  writeFileSync(join(outside, 'secret.txt'), 'topsecret\n')
  writeFileSync(join(outside, 'pic.png'), 'png')
  return { t, root, outside, project, path }
}

/** A call as a Mousse window of this computer makes it. */
function windowCall(o: Owner, method: string, params: Record<string, unknown>): Promise<any> {
  return dispatchMethod(
    {
      mms: o.f.mms,
      globalSequence: () => 0,
      connection: {
        id: 'window-1',
        clientType: 'gui',
        capabilities: new Set(),
        binding: { profileId: o.f.mms.getProfileId(), epoch: 1 },
        lifetime: new AbortController().signal
      }
    },
    method,
    params
  )
}

const refused = (code: string) => ({ ok: false, error: { code } })

describe('a link that leads out of the thread folder', () => {
  it('is not followed for listing, reading, previews, saving or stat, and a window of this computer still follows it', async () => {
    const o = await routedOwner()
    const { t, root, outside } = await folderThread(o)
    folderLink(outside, join(root, 'out'))
    const asked = { threadId: t.id }
    for (const [method, params] of [
      ['files.list', { path: 'out' }],
      ['files.read', { path: 'out/secret.txt' }],
      ['files.readAsset', { path: 'out/pic.png' }],
      ['files.stat', { path: 'out/secret.txt' }],
      ['files.write', { path: 'out/new.txt', content: 'planted' }],
      ['files.write', { path: 'out/secret.txt', content: 'planted' }]
    ] as const)
      expect(
        await o.call(method, { ...asked, ...params }),
        `${method} ${params.path}`
      ).toMatchObject(refused('path_outside_folder'))
    expect(readFileSync(join(outside, 'secret.txt'), 'utf8')).toBe('topsecret\n')
    expect(existsSync(join(outside, 'new.txt'))).toBe(false)
    // The refusals are audited as refused changes.
    expect(o.audit.recent(10, o.f.callerNode).filter((row) => row.kind === 'refused')).toEqual([
      expect.objectContaining({ method: 'files.write', outcome: 'path_outside_folder' }),
      expect.objectContaining({ method: 'files.write', outcome: 'path_outside_folder' })
    ])
    // The search never offers a file it cannot read.
    const found = await o.ok('files.grep', { ...asked, query: 'topsecret' })
    expect(JSON.stringify(found)).not.toContain('secret.txt')

    // The user's own window opens it as before.
    expect(
      (await windowCall(o, 'files.read', { threadId: t.id, path: 'out/secret.txt' })).content
    ).toBe('topsecret\n')
    expect(
      (await windowCall(o, 'files.list', { threadId: t.id, path: 'out' })).entries.map(
        (e: any) => e.name
      )
    ).toContain('secret.txt')
  }, 180_000)

  it('is not followed for a file link either', async () => {
    const o = await routedOwner()
    const { t, root, outside } = await folderThread(o)
    if (!fileLink(join(outside, 'pic.png'), join(root, 'pic.png'))) return
    fileLink(join(outside, 'secret.txt'), join(root, 'notes.txt'))
    for (const [method, params] of [
      ['files.readAsset', { path: 'pic.png' }],
      ['files.read', { path: 'notes.txt' }],
      ['files.write', { path: 'notes.txt', content: 'planted' }]
    ] as const)
      expect(await o.call(method, { threadId: t.id, ...params })).toMatchObject(
        refused('path_outside_folder')
      )
    expect(readFileSync(join(outside, 'secret.txt'), 'utf8')).toBe('topsecret\n')
    expect((await windowCall(o, 'files.readAsset', { threadId: t.id, path: 'pic.png' })).size).toBe(
      3
    )
    // The review shows a link as the link text and nothing of what it points to.
    const review = await o.ok('review.file', {
      threadId: t.id,
      scope: { kind: 'worktree' },
      path: 'notes.txt'
    })
    expect(JSON.stringify(review)).not.toContain('topsecret')
  }, 180_000)

  it('is not followed by Git paths or the review, while the repository itself can still be worked with', async () => {
    const o = await routedOwner()
    const { t, root, outside, project, path } = await folderThread(o)
    folderLink(outside, join(root, 'out'))
    for (const [method, params] of [
      ['git.diff', { path: 'out/secret.txt' }],
      ['review.file', { scope: { kind: 'worktree' }, path: 'out/secret.txt' }]
    ] as const)
      expect(await o.call(method, { threadId: t.id, ...params }), method).toMatchObject(
        refused('path_outside_folder')
      )
    // A thread's worktree takes no staging by hand; the project's folder does, and is held to the same rule.
    folderLink(outside, join(path, 'out'))
    for (const method of ['git.stage', 'git.unstage', 'git.discard'])
      expect(
        await o.call(method, { projectId: project.id, paths: ['out/secret.txt'] }),
        method
      ).toMatchObject(refused('path_outside_folder'))
    expect(readFileSync(join(outside, 'secret.txt'), 'utf8')).toBe('topsecret\n')
    // Everything else Git does still works from another computer.
    expect(await o.ok('git.status', { threadId: t.id })).toMatchObject({
      status: expect.anything()
    })
    writeFileSync(join(path, 'plain.txt'), 'plain\n')
    await o.ok('git.stage', { projectId: project.id, paths: ['plain.txt'] })
    await o.ok('git.commit', { threadId: t.id, message: 'from the laptop' })
    expect(
      execFileSync('git', ['log', '-1', '--format=%s'], { cwd: root, encoding: 'utf8' }).trim()
    ).toBe('from the laptop')
  }, 180_000)
})

describe("Git's own files and Mousse's control files", () => {
  it('cannot be written from another computer, and nothing is created or recorded when one is refused', async () => {
    const o = await routedOwner()
    const { t, root } = await folderThread(o)
    const actions = async () =>
      ((await o.ok('actions.list', { threadId: t.id })).actions as unknown[]).length
    const before = await actions()
    const hook = '#!/bin/sh\necho owned\n'
    for (const path of [
      '.git/hooks/pre-commit',
      '.GIT/hooks/pre-commit',
      'vendor/lib/.git/config',
      '.git',
      '.mousse/task-progress.json',
      '.mousse/materialized-inputs.exclude'
    ])
      expect(
        await o.call('files.write', { threadId: t.id, path, content: hook }),
        path
      ).toMatchObject(refused('path_protected'))
    expect(existsSync(join(root, 'vendor'))).toBe(false)
    expect(readFileSync(join(root, '.git'), 'utf8')).toMatch(/^gitdir: /)
    expect(await actions()).toBe(before)
    expect(
      o.audit.recent(10, o.f.callerNode).filter((row) => row.outcome === 'path_protected')
    ).toHaveLength(6)
    // A file that only looks like one is an ordinary file.
    mkdirSync(join(root, '.mousse'))
    expect(
      await o.ok('files.write', { threadId: t.id, path: '.gitignore', content: 'out/\n' })
    ).toMatchObject({
      path: '.gitignore'
    })
    expect(
      await o.ok('files.write', { threadId: t.id, path: '.mousse/notes.md', content: 'notes\n' })
    ).toMatchObject({
      path: '.mousse/notes.md'
    })
  }, 180_000)

  it('cannot be reached through a link inside the folder, nor through core.hooksPath', async () => {
    const o = await routedOwner()
    const { t, root } = await folderThread(o)
    mkdirSync(join(root, '.githooks'))
    execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { cwd: root })
    folderLink(join(root, '.githooks'), join(root, 'tools'))
    for (const path of ['.githooks/pre-commit', 'tools/pre-commit', '.githooks/sub/post-merge'])
      expect(
        await o.call('files.write', { threadId: t.id, path, content: 'echo owned' }),
        path
      ).toMatchObject(refused('path_protected'))
    expect(existsSync(join(root, '.githooks', 'pre-commit'))).toBe(false)
    rmSync(join(root, 'tools'))
    mkdirSync(join(root, 'src'))
    expect(
      await o.ok('files.write', { threadId: t.id, path: 'src/app.ts', content: 'x\n' })
    ).toMatchObject({
      path: 'src/app.ts'
    })
    // Git still commits with the setting in place; only a change to the hooks is refused.
    await o.ok('git.commit', { threadId: t.id, message: 'with a hooks folder' })
    execFileSync('git', ['config', '--unset-all', 'core.hooksPath'], { cwd: root })
    expect(
      await o.ok('files.write', {
        threadId: t.id,
        path: '.githooks/pre-commit',
        content: 'echo ok'
      })
    ).toMatchObject({
      path: '.githooks/pre-commit'
    })
  }, 180_000)

  it('cannot be reached through a second name of a file', async () => {
    const o = await routedOwner()
    const { t, root } = await folderThread(o)
    linkSync(join(root, 'seed.txt'), join(root, 'alias.txt'))
    expect(
      await o.call('files.write', { threadId: t.id, path: 'alias.txt', content: 'changed\n' })
    ).toMatchObject(refused('path_protected'))
    expect(readFileSync(join(root, 'seed.txt'), 'utf8')).toBe('seed\n')
  }, 180_000)
})

describe('a thread with no folder, and ids this computer does not know', () => {
  it('lists, reads, searches and saves nothing, and is told why', async () => {
    const o = await routedOwner()
    const loose = o.thread('No folder')
    for (const [method, params] of [
      ['files.list', {}],
      ['files.read', { path: 'a.txt' }],
      ['files.stat', { path: 'a.txt' }],
      ['files.search', { query: 'a' }],
      ['files.grep', { query: 'a' }],
      ['files.write', { path: 'a.txt', content: 'x' }],
      ['git.status', {}],
      ['review.files', { scope: { kind: 'worktree' } }]
    ] as const)
      expect(await o.call(method, { threadId: loose.id, ...params }), method).toMatchObject(
        refused('thread_has_no_folder')
      )
  }, 120_000)

  it('refuses an unknown thread or project for every file call, the preview and the save included', async () => {
    const o = await routedOwner()
    for (const [method, params] of [
      ['files.list', {}],
      ['files.read', { path: 'a.txt' }],
      ['files.readAsset', { path: 'a.png' }],
      ['files.stat', { path: 'a.txt' }],
      ['files.write', { path: 'a.txt', content: 'x' }],
      ['git.diff', { path: 'a.txt' }]
    ] as const) {
      expect(await o.call(method, { threadId: 'no-such-thread', ...params }), method).toMatchObject(
        refused('thread_not_found')
      )
      if (method !== 'files.write')
        expect(
          await o.call(method, { projectId: 'no-such-project', ...params }),
          method
        ).toMatchObject(refused('project_not_found'))
    }
  }, 120_000)
})

describe('big results and Undo', () => {
  it('pages a review file over 64 KiB and the caller puts it back together', async () => {
    const o = await routedOwner()
    const { t, root } = await folderThread(o)
    const content = `${'a line of a long generated file\n'.repeat(10_000)}`
    expect(Buffer.byteLength(content)).toBeGreaterThan(300 * 1024)
    writeFileSync(join(root, 'generated.txt'), content)
    const params = { threadId: t.id, scope: { kind: 'worktree' }, path: 'generated.txt' }
    expect(isRoutedPagedReply(await o.raw('review.file', params))).toBe(true)
    const file = await o.ok('review.file', params)
    expect(file).toMatchObject({ path: 'generated.txt', modified: { content } })
  }, 180_000)

  it('round-trips a save through Undo and through reverting the code', async () => {
    const o = await routedOwner()
    const { t, root } = await folderThread(o)
    // A model whose containment restores without asking, so Undo runs as it does on the owner's own window.
    o.f.mms.orchestrator.setThreadModelOverride(t.id, { llmProvider: 'openai', model: 'gpt-4o' })
    const saved = await o.ok('files.write', {
      threadId: t.id,
      path: 'draft.txt',
      content: 'from the laptop\n'
    })
    expect(readFileSync(join(root, 'draft.txt'), 'utf8')).toBe('from the laptop\n')
    await o.ok('actions.undoLatest', { threadId: t.id })
    expect(existsSync(join(root, 'draft.txt'))).toBe(false)
    expect(existsSync(join(root, 'seed.txt'))).toBe(true)

    const again = await o.ok('files.write', {
      threadId: t.id,
      path: 'draft2.txt',
      content: 'second\n'
    })
    expect(readFileSync(join(root, 'draft2.txt'), 'utf8')).toBe('second\n')
    const listed = (await o.ok('actions.list', { threadId: t.id })).actions as Array<{
      id: string
      receiptId?: string
    }>
    const action = listed.find((item) => item.receiptId === again.receiptId)!
    expect(action).toBeTruthy()
    await o.ok('actions.revertCode', { threadId: t.id, actionId: action.id })
    expect(existsSync(join(root, 'draft2.txt'))).toBe(false)
    expect(saved.receiptId).not.toBe(again.receiptId)
  }, 180_000)
})

describe('a Git action started from another computer', () => {
  it('reports its progress to that computer only, and only that computer can cancel it', async () => {
    const o = await routedOwner({ streams: true })
    const { t, root, path } = await folderThread(o)
    const remote = realpathSync(mkdtempSync(join(tmpdir(), 'routed-remote-')))
    resources.push(() => rmSync(remote, { recursive: true, force: true }))
    execFileSync('git', ['init', '-q', '--bare'], { cwd: remote })
    execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: path })

    const pushed = vi.spyOn(o.adapter!, 'pushChannel')
    const ownerWindow: string[] = []
    const heard = (data: unknown) => ownerWindow.push((data as { type: string }).type)
    o.f.mms.events.on('protocol:event', heard)
    resources.push(() => o.f.mms.events.off('protocol:event', heard))
    await o.ok('git.fetch', { threadId: t.id, operationId: 'op-fetch-1' })
    const reported = pushed.mock.calls.filter(([, type]) => type === 'git.operation')
    expect(reported.length).toBeGreaterThan(0)
    expect(new Set(reported.map(([node]) => node))).toEqual(new Set([o.f.callerNode]))
    // The owner's own windows hear nothing of it.
    expect(ownerWindow).not.toContain('git.operation')

    // Cancelling is by the connection that started the action: the calling computer's own, and nobody else's.
    const git = o.f.mms.gitService
    const ownedBy = (owner: string, operationId: string) =>
      git.openOperation(root, 'fetch', { operationId, owner })
    const theirs = ownedBy(`bridge:${o.f.callerNode}`, 'op-theirs')
    const another = ownedBy('bridge:nod_someoneelse', 'op-another')
    const local = ownedBy('window-1', 'op-local')
    expect(
      await o.ok('git.cancelOperation', { threadId: t.id, operationId: 'op-another' })
    ).toEqual({ cancelled: false })
    expect(await o.ok('git.cancelOperation', { threadId: t.id, operationId: 'op-local' })).toEqual({
      cancelled: false
    })
    expect(another.signal?.aborted).toBe(false)
    expect(local.signal?.aborted).toBe(false)
    expect(await o.ok('git.cancelOperation', { threadId: t.id, operationId: 'op-theirs' })).toEqual(
      { cancelled: true }
    )
    expect(theirs.signal?.aborted).toBe(true)
    // A window of this computer cannot stop an action another computer started.
    expect(
      (await windowCall(o, 'git.cancelOperation', { threadId: t.id, operationId: 'op-another' }))
        .cancelled
    ).toBe(false)
    for (const operation of [theirs, another, local]) operation.end()
  }, 180_000)
})

describe('opening a folder from another computer', () => {
  /** A user's home folder with the places credentials live, and ordinary folders beside them. */
  function home() {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'routed-home-')))
    const folder = join(base, 'home')
    for (const name of [
      '.ssh',
      '.gnupg',
      '.aws',
      '.kube',
      '.docker',
      '.config/gh',
      '.config/gcloud',
      '.config/nvim',
      '.sshx',
      'code/project'
    ])
      mkdirSync(join(folder, name), { recursive: true })
    const saved = { ...process.env }
    for (const key of [
      'GNUPGHOME',
      'DOCKER_CONFIG',
      'GH_CONFIG_DIR',
      'CLOUDSDK_CONFIG',
      'XDG_CONFIG_HOME',
      'XDG_DATA_HOME'
    ])
      delete process.env[key]
    process.env.HOME = folder
    process.env.USERPROFILE = folder
    resources.push(() => {
      for (const key of ['HOME', 'USERPROFILE']) process.env[key] = saved[key]
      rmSync(base, { recursive: true, force: true })
    })
    return { base, folder }
  }

  it('refuses credential and settings folders, the home folder and what contains them, as a typed refusal with a hashed path', async () => {
    const o = await routedOwner()
    const { base, folder } = home()
    const refusedFolders = [
      join(folder, '.ssh'),
      join(folder, '.ssh', 'nested'),
      join(folder, '.gnupg'),
      join(folder, '.aws'),
      join(folder, '.kube'),
      join(folder, '.docker'),
      join(folder, '.config', 'gh'),
      join(folder, '.config', 'gcloud'),
      // The folders that hold them.
      join(folder, '.config'),
      folder,
      base,
      tmpdir()
    ]
    mkdirSync(join(folder, '.ssh', 'nested'))
    for (const path of refusedFolders)
      expect(await o.call('projects.open', { path }), path).toMatchObject(
        refused('project_refused')
      )
    // The reason names what the folder holds.
    expect(await o.call('projects.open', { path: join(folder, '.ssh') })).toMatchObject({
      error: {
        message: expect.stringMatching(/holds SSH keys.*cannot be opened from another computer/)
      }
    })
    expect(await o.call('projects.open', { path: join(folder, '.config') })).toMatchObject({
      error: { message: expect.stringMatching(/inside or above a folder that does/) }
    })
    expect(o.f.mms.projects.listProjects()).toEqual([])
    const audited = o.audit.recent(50, o.f.callerNode)
    expect(audited).toHaveLength(refusedFolders.length + 2)
    for (const row of audited)
      expect(row).toMatchObject({
        method: 'projects.open',
        outcome: 'project_refused',
        kind: 'refused',
        project: expect.stringMatching(/^path:[0-9a-f]{12}$/)
      })
    expect(JSON.stringify(audited)).not.toContain(folder)

    // Folders beside them are ordinary folders: a name that only starts like one, a config folder of something else, a project.
    for (const path of [
      join(folder, '.sshx'),
      join(folder, '.config', 'nvim'),
      join(folder, 'code', 'project')
    ])
      expect(await o.ok('projects.open', { path }), path).toMatchObject({ project: { path } })
  }, 180_000)

  it('sees a credential folder through a link, a junction, another case and a short name', async () => {
    const o = await routedOwner()
    const { base, folder } = home()
    const linked = join(base, 'innocent')
    folderLink(join(folder, '.ssh'), linked)
    expect(await o.call('projects.open', { path: linked })).toMatchObject(
      refused('project_refused')
    )
    const spellings: string[] = []
    if (windows || process.platform === 'darwin') spellings.push(join(folder, '.ssh').toUpperCase())
    if (windows) {
      const short = spawnSync(
        'cmd',
        ['/d', '/s', '/c', `"for %I in ("${join(folder, '.ssh')}") do @echo %~sI"`],
        {
          encoding: 'utf8',
          windowsVerbatimArguments: true
        }
      ).stdout.trim()
      if (short) spellings.push(short)
    }
    for (const path of spellings)
      expect(await o.call('projects.open', { path }), path).toMatchObject(
        refused('project_refused')
      )
    expect(o.f.mms.projects.listProjects()).toEqual([])
  }, 180_000)

  it('refuses a network path, a device path and a drive root', async () => {
    const o = await routedOwner()
    const paths = [
      '\\\\evil-host\\share\\folder',
      '//evil-host/share/folder',
      '\\\\?\\C:\\Users',
      '\\\\.\\pipe\\x',
      windows ? 'C:\\' : '/'
    ]
    for (const path of paths)
      expect(await o.call('projects.open', { path }), path).toMatchObject(
        refused('project_refused')
      )
    expect(o.f.mms.projects.listProjects()).toEqual([])
  }, 120_000)
})
