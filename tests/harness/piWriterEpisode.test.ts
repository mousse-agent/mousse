import { describe, expect, it } from 'vitest'
import { EpisodeClosedError, WriterEpisode } from '../../src/mms/harness/pi/episode'
import { GATE_REFUSALS } from '../../src/mms/harness/pi/extension/messages'

/** A writer that records when it was held and released, like `TaskWriterAuthority.runWriter`. */
function writer() {
  const log: string[] = []
  let acquisitions = 0
  return {
    log,
    acquisitions: () => acquisitions,
    acquire: async (released: Promise<void>) => {
      acquisitions += 1
      log.push('held')
      void released.then(() => log.push('released'))
    }
  }
}

const tick = () => new Promise((resolve) => setImmediate(resolve))

describe('Pi RPC writer episode and batch barrier', () => {
  it('opens one episode for the first parent mutation and releases the writer once at close', async () => {
    const held = writer()
    const episode = new WriterEpisode({ acquire: held.acquire })
    expect(await episode.authorize('read-1', 'read')).toEqual({ allow: true })
    expect(episode.open).toBe(false)
    expect(await episode.authorize('edit-1', 'mutation')).toEqual({ allow: true })
    expect(await episode.authorize('edit-2', 'mutation')).toEqual({ allow: true })
    expect(held.acquisitions()).toBe(1)
    episode.ended('edit-1')
    episode.ended('edit-2')
    episode.close()
    episode.close()
    await tick()
    expect(held.log).toEqual(['held', 'released'])
  })

  it('a delegation waits for every authorized parent mutation, including one not started yet', async () => {
    const episode = new WriterEpisode()
    // Forced parallel `[edit, delegate_task]`: both preflighted, then executed together.
    await episode.authorize('edit', 'mutation')
    await episode.authorize('delegate', 'delegation')
    let quiet = false
    const waiting = episode.quiesce('delegate').then(() => {
      quiet = true
    })
    await tick()
    expect(quiet).toBe(false)
    episode.ended('edit')
    await waiting
    expect(quiet).toBe(true)
  })

  it('denies (never waits for) a parent mutation while a delegation is authorized', async () => {
    const episode = new WriterEpisode()
    await episode.authorize('delegate', 'delegation')
    expect(await episode.authorize('edit', 'mutation')).toEqual({ allow: false, reason: GATE_REFUSALS.writerYielded })
    episode.ended('delegate')
    expect(await episode.authorize('edit', 'mutation')).toEqual({ allow: true })
  })

  it('Stop rejects a waiting delegation and authorizes nothing new; the writer is released once', async () => {
    const held = writer()
    const episode = new WriterEpisode({ acquire: held.acquire })
    await episode.authorize('edit', 'mutation')
    await episode.authorize('delegate', 'delegation')
    const waiting = episode.quiesce('delegate')
    episode.revoke()
    await expect(waiting).rejects.toMatchObject({ code: 'stopped' })
    expect(await episode.authorize('edit-2', 'mutation')).toMatchObject({ allow: false })
    episode.ended('edit')
    episode.close()
    await tick()
    expect(held.log).toEqual(['held', 'released'])
  })

  it('a crash mid-edit rejects the waiting delegation as interrupted and closes the episode', async () => {
    const held = writer()
    const episode = new WriterEpisode({ acquire: held.acquire })
    await episode.authorize('edit', 'mutation')
    await episode.authorize('delegate', 'delegation')
    const waiting = episode.quiesce('delegate')
    episode.crashed()
    await expect(waiting).rejects.toBeInstanceOf(EpisodeClosedError)
    await expect(waiting).rejects.toMatchObject({ code: 'interrupted' })
    expect(episode.pending()).toBe(0)
    episode.close()
    await tick()
    expect(held.log).toEqual(['held', 'released'])
  })

  it('no parent mutation interval overlaps the delegation handler, in either order', async () => {
    for (const order of [['edit', 'delegate'], ['delegate', 'edit']] as const) {
      const episode = new WriterEpisode()
      const timeline: string[] = []
      const decisions: Record<string, boolean> = {}
      for (const id of order) decisions[id] = (await episode.authorize(id, id === 'edit' ? 'mutation' : 'delegation')).allow
      const runs: Promise<void>[] = []
      if (decisions.edit) runs.push((async () => {
        timeline.push('edit:start')
        await tick()
        timeline.push('edit:end')
        episode.ended('edit')
      })())
      runs.push(episode.quiesce('delegate').then(() => {
        timeline.push('delegate:start')
        timeline.push('delegate:end')
        episode.ended('delegate')
      }))
      await Promise.all(runs)
      const delegateStart = timeline.indexOf('delegate:start')
      if (decisions.edit) expect(timeline.indexOf('edit:end')).toBeLessThan(delegateStart)
      // `[delegate, edit]`: the edit preflighted after the delegation was denied, never run beside it.
      if (order[0] === 'delegate') expect(decisions.edit).toBe(false)
    }
  })

  it('a call the gate never allowed cannot wait as a delegation', async () => {
    const episode = new WriterEpisode()
    await expect(episode.quiesce('unknown')).rejects.toThrow(GATE_REFUSALS.denied)
  })
})
