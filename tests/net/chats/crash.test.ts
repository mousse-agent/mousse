import { afterAll, afterEach, beforeAll, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { build } from 'esbuild'
import { cleanup, profile } from './helpers'

let executable: string, buildRoot: string
beforeAll(async () => {
  buildRoot = realpathSync(mkdtempSync(join(tmpdir(), 'chats-crash-build-')))
  symlinkSync(resolve('node_modules'), join(buildRoot, 'node_modules'), 'dir')
  executable = join(buildRoot, 'child.mjs')
  // Use the actual CLI's package externalization and TS-package plugin.
  const { getCliBuildOptions } = await import('../../../scripts/build-cli.mjs')
  await build({ ...getCliBuildOptions(process.cwd()), entryPoints: [fileURLToPath(new URL('./crash-child.ts', import.meta.url))], outfile: executable, sourcemap: false, logLevel: 'silent' })
})
afterAll(() => rmSync(buildRoot, { recursive: true, force: true }))
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

it.each(['chats.publication.hostCreated', 'chats.publication.afterCommit'])('recovers actual SIGKILL at %s without duplicate Host effects or local dispatch fallback', async point => {
  const p = await profile(), group = await p.createGroup()
  await p.services.stop()
  const killed = spawnSync(process.execPath, [executable, p.home, p.profileId, group.id, point], { encoding: 'utf8', timeout: 20000, env: { ...process.env, MOUSSE_HOME: p.home } })
  expect(killed.signal, killed.stderr).toBe('SIGKILL')
  const observed = JSON.parse(readFileSync(join(p.home, 'chats-crash-public-identities.json'), 'utf8'))
  const reopened = await profile({ home: p.home, profileId: p.profileId })
  if (point.endsWith('afterCommit')) {
    expect(reopened.services.chatNetwork.binding(group.id)).toMatchObject(observed.publication)
    expect(() => reopened.services.platform.chats.send({ chatId: group.id, text: 'never rerun locally' })).toThrow(expect.objectContaining({ code: 'chat_published' }))
  } else {
    expect(reopened.services.chatNetwork.binding(group.id)).toBeUndefined()
    expect(reopened.services.spaces.store.listStreams({ kind: 'space.meta' })).toHaveLength(0)
  }
  const binding = reopened.services.chatNetwork.publish({ chatId: group.id, publicationId: 'crash-publication' })
  expect(reopened.services.spaces.store.listStreams({ kind: 'space.meta' })).toHaveLength(1)
  expect(reopened.services.spaces.store.listStreams({ space: binding.space, kind: 'space.channel' })).toHaveLength(1)
  expect(reopened.services.spaces.store.head(binding.channel).seq).toBe(0)
  expect(reopened.contexts).toHaveLength(0)
}, 30000)

it.each(['chats.message.beforeCommit', 'chats.message.afterCommit'])('recovers actual SIGKILL at %s using only the durable original message identity', async point => {
  const p = await profile(), group = await p.createGroup(), binding = p.services.chatNetwork.publish({ chatId: group.id, publicationId: 'crash-publication' })
  await p.services.stop()
  const killed = spawnSync(process.execPath, [executable, p.home, p.profileId, group.id, point], { encoding: 'utf8', timeout: 20000, env: { ...process.env, MOUSSE_HOME: p.home } })
  expect(killed.signal, killed.stderr).toBe('SIGKILL')
  const observed = JSON.parse(readFileSync(join(p.home, 'chats-crash-public-identities.json'), 'utf8'))
  const reopened = await profile({ home: p.home, profileId: p.profileId })
  const journal = reopened.services.net.runtime().db.database.prepare('SELECT event FROM net_chat_message_keys WHERE profile=? AND chat=?').get(p.profileId, group.id)
  expect(!!journal).toBe(point.endsWith('afterCommit'))
  const sent = await reopened.services.chatNetwork.send({ chatId: group.id, text: 'exact crash original', clientMessageId: 'crash-message' })
  if (journal) expect(sent.network!.delivery!.id).toBe(observed.message.event)
  expect(reopened.services.spaces.store.head(binding.channel).seq).toBe(1)
  expect(reopened.contexts).toHaveLength(0)
}, 30000)
