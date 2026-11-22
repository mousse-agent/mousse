// A preload stand-in, set before the renderer's modules load: every `on…` returns an unsubscribe, every other call
// fails as if the service were offline. The bot's home thread (where its chat turn writes its reply) is driven by hand
// through `homeThread`, as the window's thread message events would.
const call = (name: string) => (name.startsWith('on') ? () => () => {} : async () => { throw new Error('offline') })
const group = (known: Record<string, unknown> = {}) => new Proxy(known, { get: (target, key: string) => target[key] ?? call(key) })
type Listener = (event: { threadId: string; message: unknown }) => void
export const homeThread = { added: [] as Listener[], updated: [] as Listener[] }
const groups: Record<string, unknown> = {
  personalBots: group({ attachmentPath: async () => '' }),
  app: group({ setViewedBot: async () => undefined }),
  orchestrator: group({
    onThreadMessage: (listener: Listener) => { homeThread.added.push(listener); return () => {} },
    onThreadMessageUpdated: (listener: Listener) => { homeThread.updated.push(listener); return () => {} }
  })
}
;(window as unknown as { mousse: unknown }).mousse = new Proxy(groups, { get: (target, key: string) => target[key] ?? group() })
