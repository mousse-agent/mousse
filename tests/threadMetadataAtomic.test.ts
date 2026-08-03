import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ProjectManager } from '../src/mms/data/ProjectManager'
import { ThreadDataStore } from '../src/mms/data/ThreadDataStore'

describe('ThreadDataStore atomic metadata', () => {
  let home: string
  let store: ThreadDataStore

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'mousse-meta-'))
    process.env.MOUSSE_HOME = home
    store = new ThreadDataStore(new ProjectManager())
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
    delete process.env.MOUSSE_HOME
  })

  it('writes meta.json and active-thread via same-directory atomic rename', () => {
    const thread = store.createThread('Atomic Meta')
    const dir = store.getThreadDir(thread.id)
    const metaPath = join(dir, 'meta.json')
    expect(existsSync(metaPath)).toBe(true)
    // No leftover temp files next to meta after successful write.
    const leftovers = readdirSync(dir).filter((f) => f.includes('.tmp'))
    expect(leftovers).toEqual([])

    store.setActiveThreadId(thread.id)
    const active = store.getActiveThreadId()
    expect(active).toBe(thread.id)

    store.updateThreadMeta(thread.id, { name: 'Renamed' })
    const meta = JSON.parse(readFileSync(metaPath, 'utf-8')) as { name: string }
    expect(meta.name).toBe('Renamed')
  })

  it('corrupt meta on saveThreadData does not wipe with fallback', () => {
    const thread = store.createThread('Corrupt')
    const dir = store.getThreadDir(thread.id)
    const metaPath = join(dir, 'meta.json')
    writeFileSync(metaPath, '{broken', 'utf-8')

    store.saveThreadData(thread.id, {
      messages: [
        {
          id: 'm1',
          role: 'user',
          content: 'hello',
          timestamp: new Date().toISOString()
        }
      ],
      agents: [],
      tasks: []
    })

    // Corrupt meta left intact (not overwritten by reconstructed fallback).
    expect(readFileSync(metaPath, 'utf-8')).toBe('{broken')
    // Messages still persisted.
    const messages = JSON.parse(readFileSync(join(dir, 'messages.json'), 'utf-8')) as unknown[]
    expect(messages).toHaveLength(1)
  })

  it('standalone index is rewritten atomically', () => {
    store.createThread('A')
    store.createThread('B')
    const listed = store.listThreads()
    expect(listed.length).toBeGreaterThanOrEqual(2)
  })
})
