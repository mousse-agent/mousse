/** Redirects a download may follow besides its own host: release assets GitHub serves elsewhere. */
export const REDIRECT_HOSTS: Readonly<Record<string, readonly string[]>> = {
  'github.com': ['objects.githubusercontent.com', 'release-assets.githubusercontent.com']
}

/** The most redirects one download follows. */
export const MAX_REDIRECTS = 5

/** A redirect the download does not follow: too many, or to a host outside the allowed ones. */
export class RedirectRefusedError extends Error {}

/**
 * Fetches `url`, following its redirects by hand: each may only stay on the declared host (same
 * scheme) or go to the fixed `REDIRECT_HOSTS` table, at most `MAX_REDIRECTS` times. Returns the first
 * answer that is not a redirect, its body unread, and the address that gave it.
 *
 * `label` names the download in errors ("The Codex download…"); `from` is what Mousse downloads from
 * the allowed hosts ("agents"), for the error about a host outside them.
 */
export async function fetchWithAllowedRedirects(
  url: string,
  options: { fetch?: typeof fetch; signal?: AbortSignal; headers?: Record<string, string>; label: string; from: string }
): Promise<{ response: Response; url: URL }> {
  const fetchFile = options.fetch ?? fetch
  const declared = new URL(url)
  const allowed = new Set([declared.host, ...(REDIRECT_HOSTS[declared.hostname] ?? [])])
  let current = declared
  for (let hop = 0; ; hop += 1) {
    const response = await fetchFile(current.href, { signal: options.signal, redirect: 'manual', ...(options.headers ? { headers: options.headers } : {}) })
    if (response.status < 300 || response.status >= 400) return { response, url: current }
    const location = response.headers.get('location')
    await response.body?.cancel().catch(() => undefined)
    if (!location || hop >= MAX_REDIRECTS) throw new RedirectRefusedError(`The ${options.label} download redirected too often.`)
    const next = new URL(location, current)
    if (next.protocol !== declared.protocol || !allowed.has(next.host))
      throw new RedirectRefusedError(`The ${options.label} download redirected to ${next.host}, which Mousse does not download ${options.from} from.`)
    current = next
  }
}
