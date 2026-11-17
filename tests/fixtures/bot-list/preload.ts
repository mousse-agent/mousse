// A preload stand-in, set before the renderer's modules load: every `on…` returns an unsubscribe, every other call
// fails as if the service were offline. The bots come from the bots client the entry installs.
const call = (name: string) => (name.startsWith('on') ? () => () => {} : async () => { throw new Error('offline') })
const group = () => new Proxy({}, { get: (_target, key: string) => call(key) })
;(window as unknown as { mousse: unknown }).mousse = new Proxy({}, { get: () => group() })
