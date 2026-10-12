import { appletDocument } from './appletDocument'
import type { AppletAppearance } from './appletAppearance'
import { validateAppletSubmission, type AppletSubmission } from './applets'

/** Export is explicitly executable, offline HTML; generated source is confined to its own sandbox. */
export function exportAppletHtml(source: AppletSubmission, appearance?: AppletAppearance): string {
  const safe = validateAppletSubmission(source)
  const payload = JSON.stringify(appletDocument(safe, undefined, appearance))
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Exported Mousse applet</title><style>html,body,iframe{width:100%;height:100%;margin:0;border:0}</style><iframe sandbox="allow-scripts" title="Exported applet"></iframe><script>document.querySelector('iframe').srcdoc=${payload};</script>`
}
