// A preload stand-in, set before the renderer's modules load: every `on…` returns an unsubscribe, every other call
// fails as if the service were offline. The bot chat's own data comes from the bots client the entry installs.
const call = (name: string) => (name.startsWith('on') ? () => () => {} : async () => { throw new Error('offline') })
const group = (known: Record<string, unknown> = {}) => new Proxy(known, { get: (target, key: string) => target[key] ?? call(key) })
const groups: Record<string, unknown> = {
  personalBots: group({ attachmentPath: async () => '' }),
  app: group({ setViewedBot: async () => undefined })
}
;(window as unknown as { mousse: unknown }).mousse = new Proxy(groups, { get: (target, key: string) => target[key] ?? group() })
