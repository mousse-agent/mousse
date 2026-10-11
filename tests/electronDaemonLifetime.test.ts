import { EventEmitter } from 'node:events'
import { expect, it, vi } from 'vitest'
import { holdElectronDaemonQuit } from '../src/cli/electronDaemonLifetime'

it('holds every Electron quit until the existing owner drain resolves, without synthesizing process exit', async () => {
  const app = new EventEmitter()
  let release!: () => void
  const drain = new Promise<void>(resolve => { release = resolve })
  const shutdown = vi.fn(() => drain), failed = vi.fn()
  const off = holdElectronDaemonQuit(app, shutdown, failed)
  const first = { preventDefault: vi.fn() }, concurrent = { preventDefault: vi.fn() }
  app.emit('before-quit', first); app.emit('before-quit', concurrent)
  await Promise.resolve()
  expect(first.preventDefault).toHaveBeenCalledOnce()
  expect(concurrent.preventDefault).toHaveBeenCalledOnce()
  expect(shutdown).toHaveBeenCalledExactlyOnceWith('electron-before-quit')
  expect(app.listenerCount('before-quit')).toBe(1)
  release(); await drain
  off()
  expect(app.listenerCount('before-quit')).toBe(0)
  expect(failed).not.toHaveBeenCalled()
})

it('keeps failed quit cleanup fenced and allows an explicit later quit retry', async () => {
  const app = new EventEmitter(), cause = new Error('owned drain failed')
  const shutdown = vi.fn().mockRejectedValueOnce(cause).mockResolvedValue(undefined), failed = vi.fn()
  const off = holdElectronDaemonQuit(app, shutdown, failed)
  const first = { preventDefault: vi.fn() }
  app.emit('before-quit', first)
  await vi.waitFor(() => expect(failed).toHaveBeenCalledWith(cause))
  const second = { preventDefault: vi.fn() }
  app.emit('before-quit', second)
  await vi.waitFor(() => expect(shutdown).toHaveBeenCalledTimes(2))
  expect(first.preventDefault).toHaveBeenCalledOnce()
  expect(second.preventDefault).toHaveBeenCalledOnce()
  off()
})
