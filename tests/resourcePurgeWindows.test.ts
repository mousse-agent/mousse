import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { LifecyclePurgePreview } from '../src/shared/resourceLifecycle'
import type { Thread } from '../src/shared/types'
import { lifecycleHarness } from './fixtures/resource-lifecycle-harness'

it.skipIf(process.platform !== 'win32')('keeps Windows sharing violations pending and retries the frozen purge after the real handle closes', async () => {
  const f = await lifecycleHarness()
  let lock: ChildProcessWithoutNullStreams | undefined
  try {
    const { thread } = await f.rpc.request<{ thread: Thread }>('threads.create', { name: 'Locked owned artifact' })
    const directory = f.services.threads.getThreadDir(thread.id)
    mkdirSync(join(directory, 'owned'), { recursive: true })
    writeFileSync(join(directory, 'owned', 'locked.bin'), Buffer.from([0, 255, 21, 4]))
    await f.rpc.request('threads.trash', { threadId: thread.id })
    const record = f.services.threads.lifecycleStore.require(thread.id), path = join(record.location, 'owned', 'locked.bin')
    // The child opens only this verified fixture path, denies Delete sharing, and never mutates it.
    lock = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "$handle = [System.IO.File]::Open($env:MOUSSE_PURGE_LOCK_FIXTURE, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read); [Console]::WriteLine('LOCKED'); [Console]::ReadLine() | Out-Null; $handle.Dispose()"], { windowsHide: true, env: { ...process.env, MOUSSE_PURGE_LOCK_FIXTURE: path }, stdio: ['pipe', 'pipe', 'pipe'] })
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Windows fixture lock was not acquired')), 10_000)
      lock!.once('error', (error) => { clearTimeout(timer); reject(error) })
      lock!.stdout.on('data', (data) => { if (String(data).includes('LOCKED')) { clearTimeout(timer); resolve() } })
      lock!.once('exit', (code) => { clearTimeout(timer); if (code !== 0) reject(new Error('Windows fixture lock exited before readiness')) })
    })
    const { preview } = await f.rpc.request<{ preview: LifecyclePurgePreview }>('threads.purge', { threadId: thread.id, preview: true })
    expect(preview.blockers).toEqual([])
    await expect(f.rpc.request('threads.purge', { threadId: thread.id, operationId: 'windows-locked-purge', expectedGeneration: preview.generation, previewDigest: preview.digest })).rejects.toThrow(/EPERM|EACCES|EBUSY|permission|operation not permitted/i)
    const pending = f.services.threads.lifecycleStore.require(thread.id)
    expect(pending.state).toBe('purge-started'); expect(pending.purge?.completedAt).toBeUndefined()
    expect(readFileSync(path)).toEqual(Buffer.from([0, 255, 21, 4]))
    await expect(f.rpc.request('threads.restore', { threadId: thread.id })).rejects.toThrow(/purge-started/)
    const closed = once(lock, 'exit'); lock.stdin.write('\n'); await closed; lock = undefined
    await f.rpc.request('threads.purge', { threadId: thread.id, operationId: 'windows-locked-purge' })
    expect(f.services.threads.lifecycleStore.require(thread.id).state).toBe('purged')
    expect(existsSync(record.location)).toBe(false)
  } finally {
    if (lock && lock.exitCode === null) { const closed = once(lock, 'exit'); lock.kill(); await closed }
    await f.close()
  }
}, 30_000)
