export const MOUSSE_BROWSER_PARTITION = 'persist:mousse-browser'

/**
 * Google and other identity providers reject or alter flows for Electron-branded UAs.
 * Keep the real Chromium version while removing only the application/runtime products.
 */
export function browserCompatibleUserAgent(userAgent: string, appName = 'Mousse'): string {
  const escapedAppName = appName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return userAgent
    .replace(/\sElectron\/[\w.-]+/gi, '')
    .replace(new RegExp(`\\s${escapedAppName}/[\\w.-]+`, 'gi'), '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

/** Only normal web pages and an initial blank popup may stay inside Mousse. */
export function isAllowedBrowserPopupUrl(url: string): boolean {
  if (url === 'about:blank') return true
  try {
    const protocol = new URL(url).protocol
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}
