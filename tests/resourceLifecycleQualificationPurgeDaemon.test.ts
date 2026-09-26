import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import type { Thread } from '../src/shared/types'
import type { LifecyclePurgePreview, TaskLifecycleRecord } from '../src/shared/resourceLifecycle'
import { awaitQualification, startQualificationDaemon } from './fixtures/resource-lifecycle-qualification'
import { git, gitFoundationFixture } from './fixtures/gitFoundation'

it('recovers actual built-daemon SIGKILL after purge intent and mid-file removal with dead-owner takeover', async () => {
  const f = gitFoundationFixture()
  const control = join(f.root, 'purge-crash-control.json'), marker = join(f.root, 'purge-crash-marker.json')
  const preload = pathToFileURL(resolve('tests/fixtures/resource-lifecycle-purge-crash-preload.mjs')).href
  let daemon: Awaited<ReturnType<typeof startQualificationDaemon>> | undefined
  const launch = async () => { daemon = await startQualificationDaemon(f.home, f.repo, { preload, env: { RESOURCE_LIFECYCLE_PURGE_CRASH_CONTROL: control } }); return daemon }
  try {
    await launch()
    for (const stage of ['purge-started', 'partial-unlink']) {
      const { thread } = await daemon!.rpc.request<{ thread: Thread }>('threads.create', { name: `actual kill ${stage}` })
      const recordPath = join(f.home, 'profiles', daemon!.profileId, 'lifecycle', 'tasks', `${thread.id}.json`)
      const original = JSON.parse(readFileSync(recordPath, 'utf8')) as TaskLifecycleRecord
      writeFileSync(join(original.location, 'payload-a.bin'), Buffer.alloc(4096, 23))
      writeFileSync(join(original.location, 'payload-b.bin'), Buffer.alloc(8192, 57))
      await daemon!.rpc.request('threads.trash', { threadId: thread.id })
      const trashed = JSON.parse(readFileSync(recordPath, 'utf8')) as TaskLifecycleRecord
      const { preview } = await daemon!.rpc.request<{ preview: LifecyclePurgePreview }>('threads.purge', { threadId: thread.id, preview: true })
      expect(preview.blockers).toEqual([])
      writeFileSync(control, JSON.stringify({ stage, recordPath, marker, unlinkPath: join(trashed.location, 'payload-b.bin') }))
      const killed = daemon!.child
      await daemon!.rpc.request('threads.purge', { threadId: thread.id, operationId: `actual-kill-${stage}`, expectedGeneration: preview.generation, previewDigest: preview.digest }).catch(() => undefined)
      await awaitQualification(() => killed.exitCode !== null || killed.signalCode !== null, Boolean)
      expect(JSON.parse(readFileSync(marker, 'utf8'))).toMatchObject({ stage, pid: killed.pid })
      const interrupted = JSON.parse(readFileSync(recordPath, 'utf8')) as TaskLifecycleRecord
      expect(interrupted.state).toBe('purge-started')
      expect(interrupted.purge?.completedAt).toBeUndefined()
      if (stage === 'partial-unlink') expect(existsSync(join(trashed.location, 'payload-b.bin'))).toBe(false)
      else expect(existsSync(join(trashed.location, 'payload-b.bin'))).toBe(true)
      await daemon!.close(); daemon = undefined
      writeFileSync(control, '{}')
      await launch()
      const recovered = await awaitQualification(() => JSON.parse(readFileSync(recordPath, 'utf8')) as TaskLifecycleRecord, (record) => record.state === 'purged')
      expect(recovered.purge?.completedAt).toBeTruthy()
      expect(existsSync(recovered.location)).toBe(false)
      await expect(daemon!.rpc.request('threads.restore', { threadId: thread.id })).rejects.toThrow(/purged|tombstone|restore/i)
      expect(git(f.repo, 'rev-parse', 'HEAD')).toBe(f.baseSha)
      expect(f.read(f.repo)).toBe('base\n')
    }
  } finally { await daemon?.close(); f.dispose() }
}, 120_000)
