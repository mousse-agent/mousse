/**
 * `mousse://pair#<ticket>` links (design 1b §5.2): the OS hands one to Mousse in the launch argv (Windows, Linux),
 * in a second instance's argv, or as `open-url` (macOS). Main keeps the newest until a window takes it, and tells
 * the windows one waits; the window opens "Enter link" with it. Only packaged builds register the scheme, and never
 * an app a check started (`MOUSSE_CHECK`).
 */

import { readEngineControl } from '../mms/netEngine/limits'

export const MOUSSE_SCHEME = 'mousse'

/** The IPC a window invokes to take the waiting link, and the event that says one waits. */
export const PAIR_LINK_IPC = { take: 'netEngine:takePairLink', arrived: 'netEngine:pairLink' } as const

/** Longest link accepted from the OS: a ticket is a few hundred bytes. */
const PAIR_LINK_MAX_CHARS = 4096

/** The first `mousse://pair` link among `args` (argv, or the URL `open-url` gave); anything else is none. */
export function pairLinkFrom(args: readonly unknown[]): string | undefined {
  for (const arg of args) {
    if (typeof arg !== 'string') continue
    const text = arg.trim()
    if (text.length > PAIR_LINK_MAX_CHARS) continue
    if (!/^mousse:\/\/pair[/?#]/i.test(text)) continue
    if (!text.includes('#')) continue
    return text
  }
  return undefined
}

/**
 * Whether this app registers itself for `mousse://`: packaged builds only, and not when a check started it. The
 * control `link-scheme-registered` (which an installed app ignores) registers anyway, so the check can fail.
 */
export function shouldRegisterMousseScheme(options: {
  packaged: boolean
  env: NodeJS.ProcessEnv
}): boolean {
  if (readEngineControl(options.env).control === 'link-scheme-registered') return true
  return options.packaged && !options.env.MOUSSE_CHECK
}

/** What `attachPairLinks` needs of Electron's `app` and `ipcMain`. */
export interface PairLinkApp {
  isPackaged: boolean
  setAsDefaultProtocolClient(protocol: string): boolean
  on(event: 'open-url', listener: (event: { preventDefault(): void }, url: string) => void): unknown
}
export interface PairLinkIpc {
  removeHandler(channel: string): void
  handle(channel: string, listener: (...args: unknown[]) => unknown): void
}

export interface PairLinks {
  /** A second instance started with `argv`: its link, if any, waits for a window. Answers whether it had one. */
  fromArgv(argv: readonly unknown[]): boolean
  /** The waiting link, once. */
  take(): string | undefined
}

/**
 * Registers the scheme (when allowed), reads the launch argv, listens for `open-url`, and answers the window's
 * take. `notify` tells the windows a link waits (and brings one up).
 */
export function attachPairLinks(options: {
  app: PairLinkApp
  ipc: PairLinkIpc
  argv: readonly unknown[]
  env: NodeJS.ProcessEnv
  notify(): void
}): PairLinks {
  let waiting: string | undefined
  const receive = (link: string | undefined): boolean => {
    if (!link) return false
    waiting = link
    options.notify()
    return true
  }
  if (shouldRegisterMousseScheme({ packaged: options.app.isPackaged, env: options.env })) {
    try {
      options.app.setAsDefaultProtocolClient(MOUSSE_SCHEME)
    } catch {
      // The OS refused; links then open only by paste.
    }
  }
  options.app.on('open-url', (event, url) => {
    const link = pairLinkFrom([url])
    if (!link) return
    event.preventDefault()
    receive(link)
  })
  options.ipc.removeHandler(PAIR_LINK_IPC.take)
  options.ipc.handle(PAIR_LINK_IPC.take, () => {
    const link = waiting
    waiting = undefined
    return link ?? null
  })
  waiting = pairLinkFrom(options.argv)
  return {
    fromArgv: (argv) => receive(pairLinkFrom(argv)),
    take: () => {
      const link = waiting
      waiting = undefined
      return link
    }
  }
}
