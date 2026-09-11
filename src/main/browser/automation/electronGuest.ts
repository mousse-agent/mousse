import { session as electronSession, type Debugger as ElectronDebugger, type WebContents } from 'electron'
import type { GuestDebuggerHandle, GuestWebContentsHandle } from './guestHandle'

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
