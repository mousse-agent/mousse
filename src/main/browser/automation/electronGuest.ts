import { session as electronSession, type Debugger as ElectronDebugger, type WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import type { GuestDebuggerHandle, GuestWebContentsHandle } from './guestHandle'

// Two owned guests may share one embedder. Keep its focus routing exclusive for
// the entire keyboard action, including asynchronous native input settlement.
const keyboardOwners = new WeakMap<WebContents, Promise<void>>()

async function acquireKeyboardFocus(contents: WebContents, signal: AbortSignal) {
  const owner = contents.hostWebContents
  const guestId = contents.id
  if (!owner || owner.isDestroyed()) throw new Error('Attached guest has no live embedder')
  const previous = keyboardOwners.get(owner) ?? Promise.resolve()
  let unlock!: () => void
  const reservation = new Promise<void>((resolve) => { unlock = resolve })
  keyboardOwners.set(owner, reservation)
  const token = randomUUID()
  const check = () => { if (signal.aborted) throw Object.assign(new Error('cancelled'), { code: 'cancelled' }) }
  const evaluate = (body: string) => owner.executeJavaScript(`(() => { const key = Symbol.for('mousse.attached.keyboardFocus'); const token = ${JSON.stringify(token)}; ${body} })()`)
  try {
    await previous
    check()
    await evaluate(`
      const target = [...document.querySelectorAll('webview')].find(element => {
        try { return element.getWebContentsId() === ${guestId}; } catch { return false; }
      });
      if (!target) throw new Error('Owned webview is no longer attached');
      window[key] = { token, target, previous: document.activeElement };
    `)
    check()
  } catch (error) {
    if (!owner.isDestroyed()) await evaluate('if (window[key]?.token === token) delete window[key];').catch(() => undefined)
    unlock()
    if (keyboardOwners.get(owner) === reservation) keyboardOwners.delete(owner)
    throw error
  }
  let released = false
  return {
    async focus() {
      check()
      await evaluate(`
        const state = window[key];
        if (state?.token !== token || !state.target.isConnected || state.target.getWebContentsId() !== ${guestId}) throw new Error('Owned keyboard focus scope expired');
        state.target.focus({ preventScroll: true });
        if (document.activeElement !== state.target) throw new Error('Owned webview cannot receive keyboard input');
      `)
      check()
    },
    async release(restore: boolean) {
      if (released) return
      released = true
      try {
        if (!owner.isDestroyed()) await evaluate(`
          const state = window[key];
          if (state?.token !== token) return;
          delete window[key];
          let sameGuest = false;
          try { sameGuest = state.target.isConnected && state.target.getWebContentsId() === ${guestId}; } catch { /* guest is gone: treat as a different guest */ }
          if (${restore} && sameGuest && document.activeElement === state.target) {
            state.target.blur();
            if (state.previous?.isConnected) state.previous.focus?.({ preventScroll: true });
          }
        `)
      } finally {
        unlock()
        if (keyboardOwners.get(owner) === reservation) keyboardOwners.delete(owner)
      }
    }
  }
}

class ElectronDebuggerAdapter implements GuestDebuggerHandle {
  constructor(private readonly debuggerRef: ElectronDebugger) {}

  attach(protocolVersion?: string): void {
    this.debuggerRef.attach(protocolVersion)
  }

  detach(): void {
    this.debuggerRef.detach()
  }

  isAttached(): boolean {
    return this.debuggerRef.isAttached()
  }

  sendCommand(method: string, commandParams?: Record<string, unknown>, sessionId?: string): Promise<unknown> {
    if (sessionId) return this.debuggerRef.sendCommand(method, commandParams, sessionId)
    return this.debuggerRef.sendCommand(method, commandParams)
  }

  on(event: 'message' | 'detach', listener: (...args: never[]) => void): void {
    this.debuggerRef.on(event as 'message', listener as never)
  }

  off(event: 'message' | 'detach', listener: (...args: never[]) => void): void {
    this.debuggerRef.off(event as 'message', listener as never)
  }
}

export function wrapElectronWebContents(contents: WebContents): GuestWebContentsHandle {
  return {
    nativeId: contents.id,
    isDestroyed: () => {
      try {
        return contents.isDestroyed()
      } catch {
        return true
      }
    },
    getURL: () => {
      try {
        return contents.getURL()
      } catch {
        return ''
      }
    },
    getTitle: () => {
      try {
        return contents.getTitle()
      } catch {
        return ''
      }
    },
    hostWebContents: () => {
      try {
        const host = contents.hostWebContents
        return host && !host.isDestroyed() ? wrapElectronWebContents(host) : null
      } catch {
        return null
      }
    },
    session: {
      matchesPartition(expected: string) {
        try {
          return contents.session === electronSession.fromPartition(expected)
        } catch {
          return false
        }
      }
    },
    debugger: new ElectronDebuggerAdapter(contents.debugger),
    acquireKeyboardFocus: (signal) => acquireKeyboardFocus(contents, signal),
    onDestroyed(listener) {
      const onDestroyed = () => listener()
      contents.once('destroyed', onDestroyed)
      return () => {
        try {
          contents.off('destroyed', onDestroyed)
        } catch { /* already gone */ }
      }
    },
    onNavigated(listener) {
      const onNav = (_event: unknown, url: string) => listener(url)
      const onInPage = (_event: unknown, url: string) => listener(url)
      contents.on('did-navigate', onNav)
      contents.on('did-navigate-in-page', onInPage)
      return () => {
        try {
          contents.off('did-navigate', onNav)
          contents.off('did-navigate-in-page', onInPage)
        } catch { /* already gone */ }
      }
    },
    executeJavaScript<T = unknown>(code: string): Promise<T> {
      return contents.executeJavaScript(code) as Promise<T>
    }
  }
}
