import type { PlatformRequestApi } from '../../../shared/platform'
import type { BrowserArtifactReadResult, BrowserGuiMethod } from '../../../shared/browser/host'
import type { BrowserViewerClient, BrowserViewerSnapshot } from '../../../shared/browser/viewer'

/** One immutable profile/thread scope per mounted viewer; never transfers a lease to UI. */
export function createBrowserViewerClient(api: PlatformRequestApi, profileId: string, threadId: string): BrowserViewerClient & { dispose(): void } {
  const listeners = new Set<(snapshot: BrowserViewerSnapshot) => void>()
  const urls = new Map<string, string>()
  let disposed = false
  let requestNumber = 0
  let publishedNumber = 0
  let selectedSessionId: string | undefined

  const request = <T>(method: BrowserGuiMethod, params: Record<string, unknown> = {}): Promise<T> => {
    if (disposed) return Promise.reject(new Error('Browser viewer is closed'))
    return api.request<T>(method, { ...params, profileId, threadId })
  }
  const snapshot = async (method: BrowserGuiMethod, params: Record<string, unknown> = {}): Promise<BrowserViewerSnapshot> => {
    const number = ++requestNumber
    const result = await request<BrowserViewerSnapshot>(method, params)
    if (disposed) throw new Error('Browser viewer is closed')
    if (result.session && (result.session.profileId !== profileId || result.session.threadId !== threadId)) throw new Error('Browser viewer owner changed')
    if (result.session) selectedSessionId = result.session.id
    const artifactId = result.observation?.screenshot?.artifactId
    if (artifactId && result.session && !urls.has(artifactId)) {
      try {
        const artifact = await request<BrowserArtifactReadResult>('browser.artifacts.read', { sessionId: result.session.id, artifactId })
        if (!disposed && artifact.artifact.id === artifactId && artifact.artifact.profileId === profileId && artifact.mediaType === 'image/png' && artifact.byteLength <= 1_500_000 && artifact.bytesBase64.length <= 2_000_000) {
          const binary = atob(artifact.bytesBase64)
          if (binary.length !== artifact.byteLength) throw new Error('Screenshot size does not match')
          const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
          const url = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }))
          const previous = urls.get(artifactId)
          if (previous) URL.revokeObjectURL(previous)
          urls.set(artifactId, url)
          while (urls.size > 8) {
            const oldest = urls.keys().next().value!
            URL.revokeObjectURL(urls.get(oldest)!)
            urls.delete(oldest)
          }
        }
      } catch { /* Semantic observation remains usable when screenshot retrieval is unavailable. */ }
    }
    if (disposed) throw new Error('Browser viewer is closed')
    if (number >= publishedNumber) {
      publishedNumber = number
      for (const listener of listeners) listener(result)
    }
    return result
  }
  return {
    snapshot: (input) => snapshot('browser.sessions.get', { ...(selectedSessionId ? { sessionId: selectedSessionId } : {}), ...input }),
    subscribe(listener) {
      if (disposed) return () => {}
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    observe: (input) => snapshot('browser.sessions.observe', input),
    humanAction: (input) => snapshot('browser.sessions.humanAction', { ...input }),
    takeControl: (input) => snapshot('browser.sessions.takeControl', input),
    resumeAgent: (input) => snapshot('browser.sessions.resume', input),
    close: (input) => snapshot('browser.sessions.close', input),
    history: async (input) => (await snapshot('browser.sessions.get', input ? { ...input } : {})).history,
    artifactUrl: (id) => urls.get(id) ?? '',
    dispose() {
      disposed = true
      listeners.clear()
      for (const url of urls.values()) URL.revokeObjectURL(url)
      urls.clear()
    }
  }
}
