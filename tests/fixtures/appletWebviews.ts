import { webContents, type BrowserWindow, type WebContents } from 'electron'
import { isAppletWebviewSource, type AppletRuntimeManager } from '../../src/main/applets/AppletRuntimeManager'

/**
 * The window plays the app: it draws each applet in a `<webview>` at a fixed place in its page, routed to the applet
 * manager as the app's main process routes it. The window needs `webviewTag: true`.
 */
export function hostAppletWebviews(window: BrowserWindow, manager: () => AppletRuntimeManager) {
  window.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    if (!isAppletWebviewSource(params.src) || !manager().attach(webPreferences, params)) event.preventDefault()
  })
  window.webContents.on('did-attach-webview', (_event, guest) => { manager().adopt(guest) })
  const page = (script: string) => window.webContents.executeJavaScript(script)
  return {
    /** Mounts an applet and draws it at `box` (the page's CSS pixels); resolves with its page once attached. */
    async place(id: string, src: string, box: { x: number; y: number; width: number; height: number }): Promise<WebContents> {
      const before = new Set(webContents.getAllWebContents().map((contents) => contents.id))
      await page(`(()=>{const view=document.createElement('webview');view.id=${JSON.stringify(id)};view.src=${JSON.stringify(src)};view.style.cssText='display:flex;position:absolute;left:${box.x}px;top:${box.y}px;width:${box.width}px;height:${box.height}px';document.body.append(view)})()`)
      for (let waited = 0; waited < 100; waited++) {
        const guest = webContents.getAllWebContents().find((contents) => !before.has(contents.id) && contents.getType() === 'webview')
        if (guest) return guest
        await new Promise((done) => setTimeout(done, 50))
      }
      throw new Error(`no guest for ${id}`)
    },
    /** Sets the drawn height, as the transcript card does when its page reports one. */
    resize(id: string, height: number) {
      return page(`document.getElementById(${JSON.stringify(id)}).style.height='${height}px'`)
    },
    remove(id: string) {
      return page(`document.getElementById(${JSON.stringify(id)})?.remove()`)
    }
  }
}
