import { afterEach, expect, it } from 'vitest'
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { newId } from '../../../../src/shared/net'
import { BRIDGE_HUB_LOCAL_METHODS } from '../../../../src/shared/bridge'
import { executeBridgeHubLocal, validateBridgeHubLocal } from '../../../../src/mms/bridge/hub'
import { fixture, cleanup, resources } from './fixture'
afterEach(cleanup)

function folder(): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), 'mousse-open-')))
  resources.push(() => rmSync(path, { recursive: true, force: true }))
  return path
}

it('registers an existing folder on the target through the hub and starts a thread in it', async () => {
  const f = await fixture(),
    path = folder()
  await f.connect()
  expect(BRIDGE_HUB_LOCAL_METHODS).toContain('bridge.hub.openProject')
  const opened = (await executeBridgeHubLocal(f.hub(), 'bridge.hub.openProject', {
    target: f.targetNode,
    path,
    options: { id: newId('rpc') }
  })) as { ok: true; project: { id: string; path: string } }
  expect(opened).toMatchObject({ ok: true, project: { path } })
  expect(f.mms.projects.listProjects().map((project) => project.path)).toEqual([path])
  // Opening the same folder again names the same project.
  const again = (await executeBridgeHubLocal(f.hub(), 'bridge.hub.openProject', {
    target: f.targetNode,
    path
  })) as { project: { id: string } }
  expect(again.project.id).toBe(opened.project.id)
  expect(f.mms.projects.listProjects()).toHaveLength(1)
  const created = (await executeBridgeHubLocal(f.hub(), 'bridge.hub.create', {
    target: f.targetNode,
    name: 'In the opened project',
    projectId: opened.project.id
  })) as { thread: { projectId?: string } }
  expect(created.thread.projectId).toBe(opened.project.id)
})

it('answers a refused folder with the reason and registers nothing', async () => {
  const f = await fixture(),
    path = folder()
  await f.connect()
  writeFileSync(join(path, 'file.txt'), 'x')
  for (const refused of [
    'relative/folder',
    join(path, 'missing'),
    join(path, 'file.txt'),
    f.targetPath,
    join(f.targetPath, 'nested'),
    '/'
  ])
    expect(
      await executeBridgeHubLocal(f.hub(), 'bridge.hub.openProject', {
        target: f.targetNode,
        path: refused,
        options: { id: newId('rpc') }
      })
    ).toMatchObject({ ok: false, error: expect.any(String) })
  expect(f.mms.projects.listProjects()).toEqual([])
})

it('never creates a missing folder', async () => {
  const f = await fixture(),
    path = join(folder(), 'created-by-mistake')
  await f.connect()
  await executeBridgeHubLocal(f.hub(), 'bridge.hub.openProject', { target: f.targetNode, path })
  expect(() => realpathSync(path)).toThrow()
  expect(f.mms.projects.listProjects()).toEqual([])
})

it('refuses a link that leads into the Mousse home', async () => {
  const f = await fixture(),
    root = folder(),
    link = join(root, 'link')
  mkdirSync(join(f.targetPath, 'inside'), { recursive: true })
  symlinkSync(join(f.targetPath, 'inside'), link, 'dir')
  await f.connect()
  expect(
    await executeBridgeHubLocal(f.hub(), 'bridge.hub.openProject', {
      target: f.targetNode,
      path: link
    })
  ).toMatchObject({ ok: false })
  expect(f.mms.projects.listProjects()).toEqual([])
})

it('refuses a folder that contains the Mousse home, such as a user home folder or a drive root', async () => {
  const f = await fixture()
  await f.connect()
  let ancestor = dirname(f.targetPath)
  const ancestors: string[] = []
  while (dirname(ancestor) !== ancestor) {
    ancestors.push(ancestor)
    ancestor = dirname(ancestor)
  }
  // The root itself is refused earlier, as the root of the disk.
  expect(ancestors.length).toBeGreaterThan(1)
  for (const refused of ancestors)
    expect(
      await executeBridgeHubLocal(f.hub(), 'bridge.hub.openProject', {
        target: f.targetNode,
        path: refused,
        options: { id: newId('rpc') }
      }),
      refused
    ).toMatchObject({ ok: false, error: expect.stringContaining('Mousse data folder') })
  expect(f.mms.projects.listProjects()).toEqual([])
})

it('refuses a link that leads to a folder containing the Mousse home', async () => {
  const f = await fixture(),
    link = join(folder(), 'link-to-parent')
  symlinkSync(dirname(f.targetPath), link, 'dir')
  await f.connect()
  expect(
    await executeBridgeHubLocal(f.hub(), 'bridge.hub.openProject', { target: f.targetNode, path: link })
  ).toMatchObject({ ok: false })
  expect(f.mms.projects.listProjects()).toEqual([])
})

it('treats a folder named like a parent step as a folder inside the home', async () => {
  const f = await fixture(),
    odd = join(f.targetPath, '..cache')
  mkdirSync(odd, { recursive: true })
  await f.connect()
  expect(
    await executeBridgeHubLocal(f.hub(), 'bridge.hub.openProject', { target: f.targetNode, path: odd })
  ).toMatchObject({ ok: false, error: expect.stringContaining('Mousse data folder') })
  expect(f.mms.projects.listProjects()).toEqual([])
})

it('registers the real path of a linked folder, not the link', async () => {
  const f = await fixture(),
    real = folder(),
    link = join(folder(), 'link')
  symlinkSync(real, link, 'dir')
  await f.connect()
  expect(
    await executeBridgeHubLocal(f.hub(), 'bridge.hub.openProject', { target: f.targetNode, path: link })
  ).toMatchObject({ ok: true, project: { path: real } })
})

it('refuses network and device paths from a remote caller on Windows', async () => {
  const f = await fixture()
  await f.connect()
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { value: 'win32' })
  try {
    for (const refused of [
      '\\\\evil-host\\share\\folder',
      '//evil-host/share/folder',
      '\\\\?\\C:\\Users\\me',
      '\\\\?\\UNC\\evil-host\\share',
      '\\\\.\\pipe\\anything'
    ])
      expect(
        await executeBridgeHubLocal(f.hub(), 'bridge.hub.openProject', {
          target: f.targetNode,
          path: refused,
          options: { id: newId('rpc') }
        }),
        refused
      ).toMatchObject({ ok: false, error: expect.stringContaining('Network and device paths') })
  } finally {
    Object.defineProperty(process, 'platform', platform)
  }
  expect(f.mms.projects.listProjects()).toEqual([])
})

it('refuses a caller without the write capability before anything is registered', async () => {
  const f = await fixture(['read', 'chat']),
    path = folder()
  await f.connect()
  await expect(
    executeBridgeHubLocal(f.hub(), 'bridge.hub.openProject', {
      target: f.targetNode,
      path,
      options: { id: newId('rpc') }
    })
  ).rejects.toMatchObject({ code: 'forbidden' })
  expect(f.mms.projects.listProjects()).toEqual([])
})

it('rejects malformed local requests before any effect', async () => {
  const f = await fixture()
  await f.connect()
  for (const bad of [
    { target: f.targetNode },
    { path: '/tmp/x' },
    { target: f.targetNode, path: '' },
    { target: f.targetNode, path: 42 },
    { target: f.targetNode, path: 'a\0b' },
    { target: f.targetNode, path: 'x'.repeat(4097) },
    { target: f.targetNode, path: '/tmp/x', projectId: 'p' },
    { target: 'not-a-node', path: '/tmp/x' }
  ])
    expect(() => validateBridgeHubLocal('bridge.hub.openProject', bad)).toThrow(
      expect.objectContaining({ code: 'bad_request' })
    )
  expect(f.mms.projects.listProjects()).toEqual([])
})
