import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ProjectManager } from '../src/mms/data/ProjectManager'
import { ThreadDataStore } from '../src/mms/data/ThreadDataStore'
import { QUEUE_IMAGES_DIR } from '../src/mms/queue/queueImageFiles'
import type { QueuedMessage } from '../src/shared/types'

/**
 * A queued message's images are kept in files beside `queue.json`, so a change to the queue writes only the small
 * `queue.json`. Inputs: a new queued image, a later queue change, the message leaving the queue, and a queue saved
 * by an older version with its images inline.
 */

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  delete process.env.MOUSSE_HOME
})

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mousse-queue-images-')))
  roots.push(root)
  process.env.MOUSSE_HOME = root
  const projects = new ProjectManager(root)
  const store = new ThreadDataStore(projects, root, { profileId: randomUUID(), allowLegacyProjectData: false })
  projects.setThreadStore(store)
  const thread = store.createThread('Queued images')
  const dir = store.getThreadDir(thread.id)
  return { store, thread, dir, queueJson: () => readFileSync(join(dir, 'queue.json'), 'utf8'), imageFiles: () => existsSync(join(dir, QUEUE_IMAGES_DIR)) ? readdirSync(join(dir, QUEUE_IMAGES_DIR)) : [] }
}

const item = (threadId: string, id: string, data?: string): QueuedMessage => ({
  id, threadId, content: id, mode: 'agent', enqueuedAt: new Date().toISOString(), order: 0, intent: 'normal', state: 'pending', source: 'gui',
  ...(data ? { images: [{ name: `${id}.png`, mimeType: 'image/png', data }] } : {})
}) as QueuedMessage

describe('queued images', () => {
  it('are written once to a file beside queue.json, loaded back, and removed when their message leaves', () => {
    const { store, thread, queueJson, imageFiles } = fixture()
    const data = 'A'.repeat(512 * 1024)
    store.saveMessageQueue(thread.id, [item(thread.id, 'big', data)])
    expect(queueJson()).not.toContain(data.slice(0, 1024))
    expect(queueJson().length).toBeLessThan(4096)
    expect(imageFiles()).toHaveLength(1)
    expect(store.loadMessageQueue(thread.id)[0]!.images).toEqual([{ name: 'big.png', mimeType: 'image/png', data }])

    // Another change (a second message queued) keeps the image's file as it is and still writes no image data.
    store.saveMessageQueue(thread.id, [...store.loadMessageQueue(thread.id), item(thread.id, 'small')])
    expect(imageFiles()).toHaveLength(1)
    expect(queueJson().length).toBeLessThan(4096)

    // The message left the queue: its image file goes.
    store.saveMessageQueue(thread.id, store.loadMessageQueue(thread.id).filter((entry) => entry.id !== 'big'))
    expect(imageFiles()).toEqual([])
  })

  it('in a queue an older version saved inline still load, and move to files on the next save', () => {
    const { store, thread, dir, queueJson, imageFiles } = fixture()
    const data = 'B'.repeat(4096)
    writeFileSync(join(dir, 'queue.json'), JSON.stringify([item(thread.id, 'old', data)]))
    expect(store.loadMessageQueue(thread.id)[0]!.images?.[0]?.data).toBe(data)
    store.saveMessageQueue(thread.id, store.loadMessageQueue(thread.id))
    expect(queueJson()).not.toContain(data)
    expect(imageFiles()).toHaveLength(1)
    expect(store.loadMessageQueue(thread.id)[0]!.images?.[0]?.data).toBe(data)
  })
})
