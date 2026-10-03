import { isElectronMainProcess } from './cliLaunch'

interface QuitEvent { preventDefault(): void }
interface QuitSource {
  on(event: 'before-quit', listener: (event: QuitEvent) => void): unknown
  removeListener(event: 'before-quit', listener: (event: QuitEvent) => void): unknown
}

/** Electron handles OS termination as app quit, without Node's SIGTERM event.
 * Hold that quit for the foreground owner's existing awaited cleanup. The
 * foreground lifetime alone decides when the CLI entry may finally exit. */
export function holdElectronDaemonQuit(app: QuitSource, shutdown: (reason: string) => Promise<void>, onError: (error: unknown) => void): () => void {
  let closing: Promise<void> | undefined
  const listener = (event: QuitEvent): void => {
    event.preventDefault()
    if (closing) return
    closing = Promise.resolve().then(() => shutdown('electron-before-quit'))
    void closing.catch(error => { closing = undefined; onError(error) })
  }
  app.on('before-quit', listener)
  return () => { app.removeListener('before-quit', listener) }
}

export async function installElectronDaemonQuit(shutdown: (reason: string) => Promise<void>, onError: (error: unknown) => void): Promise<() => void> {
  if (!isElectronMainProcess()) return () => undefined
  const { app } = await import('electron')
  return holdElectronDaemonQuit(app, shutdown, onError)
}
