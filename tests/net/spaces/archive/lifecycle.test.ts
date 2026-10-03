import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'
import { MousseMainService } from '../../../../src/mms/MousseMainService'
import { BotLocalService } from '../../../../src/mms/bots/BotLocalService'
import { SpaceArchiveHost } from '../../../../src/mms/spaces/archive'
import { settleArchiveWork } from '../../../../src/mms/spaces/archive/lifecycle'
import { newId } from '../../../../src/shared/net'

it('fences actual composed Space and bot work by Space, preserves stores and denies a nonterminal execution without manufacturing recovery', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'archive-space-fence-'))),
    main = await MousseMainService.create({
      homeDir: join(root, 'home'),
      repoRoot: root,
      headless: true,
      requireOwnership: false
    })
  try {
    await main.net.request('net.init', { listen: true, port: 0 })
    await main.net.request('net.protect', { passphrase: 'task-owned-archive-fence' })
    const a = main.spaces.host.create({ name: 'Archive selected' }),
      b = main.spaces.host.create({ name: 'Keep active' }),
      channel = main.spaces.host.createChannel(b.space, 'keep'),
      local = new BotLocalService(main.bots),
      rt = main.net.runtime()
    const added = await local.request('bots.add', {
      id: newId('rpc'),
      space: a.space,
      name: 'Inactive owned bot',
      profile: 'chat',
      policy: { steer: { kind: 'owner' }, visibility: 'public' }
    })
    const archive = new SpaceArchiveHost({
      host: main.spaces.host,
      quiesce: async (space, signal) => {
        await main.bots.quiesceForArchive(space, signal)
        await main.spaces.quiesceForArchive(space, signal)
      }
    })
    archive.freeze(a.space, 'Actual selected archive boundary')
    main.spaces.fenceForArchive(a.space)
    main.bots.fenceForArchive(a.space)
    expect(main.spaces.canStartSpaceWork(a.space)).toBe(false)
    expect(main.spaces.canStartSpaceWork(b.space)).toBe(true)
    await expect(main.spaces.flush(a.space)).rejects.toMatchObject({ code: 'space_frozen' })
    expect(() => main.bots.resume({ space: a.space, bot: added.bot })).toThrow(
      expect.objectContaining({ code: 'space_frozen' })
    )
    const event = main.spaces.client.post(channel, 'Unrelated Space remains writable')
    await main.spaces.flush(b.space)
    expect(rt.outbox.get(event)?.state).toBe('sent')
    const accepted = rt.executions.admit(
      { scope: a.space, target: added.bot, trigger: newId('event') },
      'a'.repeat(64),
      rt.db.clock.now()
    ).record
    await expect(
      main.bots.quiesceForArchive(a.space, new AbortController().signal)
    ).rejects.toMatchObject({ code: 'outcome_uncertain' })
    expect(rt.executions.get(accepted.id)?.state).toBe('accepted')
    expect(main.spaces.store.listStreams({ space: a.space })).toHaveLength(1)
    expect(archive.journal.forSpace(a.space)?.state).toBe('frozen')
    await expect(
      archive.export(a.space, join(root, 'never-published'), new AbortController().signal)
    ).rejects.toMatchObject({ code: 'outcome_uncertain' })
    expect(archive.journal.forSpace(a.space)?.state).toBe('failedFrozen')
    expect(main.spaces.store.listStreams({ space: a.space })).toHaveLength(1)
  } finally {
    await main.stop()
    rmSync(root, { recursive: true, force: true })
  }
}, 15000)

it('aborts an archive wait without claiming the still-owned task settled', async () => {
  const controller = new AbortController()
  let release!: () => void,
    settled = false
  const task = new Promise<void>((resolve) => {
      release = () => {
        settled = true
        resolve()
      }
    }),
    waiting = settleArchiveWork([task], controller.signal)
  controller.abort()
  await expect(waiting).rejects.toMatchObject({ code: 'cancelled' })
  expect(settled).toBe(false)
  release()
  await task
  expect(settled).toBe(true)
})
