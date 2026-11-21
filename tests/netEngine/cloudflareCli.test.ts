import { EventEmitter } from 'node:events'
import { execFile } from 'node:child_process'
import { expect, it, vi } from 'vitest'
import { CloudflareCli } from '../../src/mms/netEngine/cloudflare/cli'

vi.mock('node:child_process', () => ({ execFile: vi.fn() }))

it('creates the first tunnel when cloudflared reports an empty list as JSON null', async () => {
  const name = 'mousse-f6e903fdd90a44c01cba'
  const id = 'b73d0796-c988-4716-a9a4-9420224df5b1'
  let created = false
  vi.mocked(execFile).mockImplementation(((_path: string, args: string[], _options: unknown,
    callback: (error: Error | null, stdout: string, stderr: string) => void) => {
    const child = new EventEmitter()
    const create = args.includes('create')
    if (create) created = true
    const output = create ? '' : JSON.stringify(created ? [{ id, name }] : null)
    queueMicrotask(() => {
      callback(null, output, '')
      child.emit('close', 0)
    })
    return child
  }) as unknown as typeof execFile)
  const cli = new CloudflareCli('cloudflared', process.cwd())
  const signal = new AbortController().signal

  await expect(cli.createOrRecover(name, Buffer.alloc(32).toString('base64'), signal)).resolves.toBe(id)
})
