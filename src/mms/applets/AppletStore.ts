import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteJsonSync } from '../data/AtomicFs'
import { withFileLock } from '../scheduled/fileLock'
import {
  APPLET_STATE_LIMIT,
  AppletValidationError,
  appletJsonBytes,
  validateAppletSubmission,
  type AppletBundle,
  type AppletReference,
  type AppletSubmission
} from '../../shared/applets'

interface AppletIndex {
  heads: Record<string, AppletReference>
  receipts: Record<string, { appletId: string; revisionId: string; sourceHash: string }>
}
const digest = (value: string): string => createHash('sha256').update(value).digest('hex')
function safeId(id: string): string {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id))
    throw new AppletValidationError('Invalid applet identifier.')
  return id
}
/** Thread-directory resolution stays with ThreadDataStore; profile ownership stays with this service. */
export class AppletStore {
  constructor(
    readonly profileHome: string,
    private readonly resolveThreadDirectory: (threadId: string) => string
  ) {}
  private directory(threadId: string): string {
    return join(this.resolveThreadDirectory(threadId), 'applets')
  }
  private index(directory: string): AppletIndex {
    const path = join(directory, 'index.json')
    return existsSync(path)
      ? (JSON.parse(readFileSync(path, 'utf8')) as AppletIndex)
      : { heads: {}, receipts: {} }
  }
  publish(input: {
    threadId: string
    messageId: string
    turnId: string
    submission: unknown
    index?: number
  }): AppletBundle {
    const source = validateAppletSubmission(input.submission)
    if (
      !input.messageId ||
      !input.turnId ||
      !Number.isSafeInteger(input.index ?? 0) ||
      (input.index ?? 0) < 0
    )
      throw new AppletValidationError('Missing applet publication ownership.')
    const directory = this.directory(input.threadId)
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    return withFileLock(join(directory, '.publication.lock'), () => {
      const index = this.index(directory)
      const receiptId = digest(JSON.stringify([input.messageId, input.turnId, input.index ?? 0]))
      const sourceHash = digest(JSON.stringify(source))
      const receipt = index.receipts[receiptId]
      if (receipt) {
        if (receipt.sourceHash !== sourceHash)
          throw new AppletValidationError('Applet publication retry changed its source.')
        return this.load(input.threadId, receipt.appletId, receipt.revisionId)
      }
      const appletId = source.appletId ?? `applet_${receiptId.slice(0, 32)}`
      const head = index.heads[appletId]
      if (source.appletId && (!head || head.revisionId !== source.expectedRevision))
        throw new AppletValidationError(
          'Applet revision changed. Refresh the applet before updating it.'
        )
      const revisionId = `rev_${digest(`${receiptId}:${sourceHash}`).slice(0, 32)}`
      const bundle: AppletBundle = {
        schemaVersion: 1,
        appletId,
        revisionId,
        sourceHash,
        title: source.title,
        description: source.description,
        source,
        threadId: input.threadId,
        messageId: input.messageId,
        turnId: input.turnId,
        createdAt: new Date().toISOString(),
        runtimePolicyVersion: 1,
        ...(head ? { previousRevisionId: head.revisionId } : {})
      }
      const path = join(directory, safeId(appletId), `${safeId(revisionId)}.json`)
      // Source is durable before its reference is published. A retry recovers an orphan bundle.
      if (existsSync(path)) {
        const prior = this.load(input.threadId, appletId, revisionId)
        if (prior.sourceHash !== sourceHash)
          throw new AppletValidationError('Applet revision collision.')
        bundle.createdAt = prior.createdAt
      } else atomicWriteJsonSync(path, bundle, { mode: 0o600 })
      const reference = {
        appletId,
        revisionId,
        sourceHash,
        title: source.title,
        description: source.description
      }
      index.heads[appletId] = reference
      index.receipts[receiptId] = { appletId, revisionId, sourceHash }
      atomicWriteJsonSync(join(directory, 'index.json'), index, { mode: 0o600 })
      return bundle
    })
  }
  /** Restore references only to bytes already committed by publication, never historical fences alone. */
  recoverPublication(input: {
    threadId: string
    messageId: string
    turnId: string
    submission: unknown
    index?: number
  }): AppletBundle | undefined {
    const source = validateAppletSubmission(input.submission)
    if (
      !input.messageId ||
      !input.turnId ||
      !Number.isSafeInteger(input.index ?? 0) ||
      (input.index ?? 0) < 0
    )
      return undefined
    const directory = this.directory(input.threadId)
    if (!existsSync(directory)) return undefined
    const receiptId = digest(JSON.stringify([input.messageId, input.turnId, input.index ?? 0]))
    const sourceHash = digest(JSON.stringify(source))
    const appletId = source.appletId ?? `applet_${receiptId.slice(0, 32)}`
    const revisionId = `rev_${digest(`${receiptId}:${sourceHash}`).slice(0, 32)}`
    const path = join(directory, safeId(appletId), `${safeId(revisionId)}.json`)
    if (!existsSync(path)) return undefined
    return withFileLock(join(directory, '.publication.lock'), () => {
      const bundle = this.load(input.threadId, appletId, revisionId)
      if (
        bundle.messageId !== input.messageId ||
        bundle.turnId !== input.turnId ||
        bundle.sourceHash !== sourceHash
      )
        return undefined
      const index = this.index(directory)
      const receipt = index.receipts[receiptId]
      if (receipt) {
        if (
          receipt.appletId !== appletId ||
          receipt.revisionId !== revisionId ||
          receipt.sourceHash !== sourceHash
        )
          return undefined
        return bundle
      }
      // A bundle can survive a crash before index publication. Do not rewind a newer head.
      const head = index.heads[appletId]
      if (!head || head.revisionId === source.expectedRevision) {
        index.heads[appletId] = {
          appletId,
          revisionId,
          sourceHash,
          title: source.title,
          description: source.description
        }
      }
      index.receipts[receiptId] = { appletId, revisionId, sourceHash }
      atomicWriteJsonSync(join(directory, 'index.json'), index, { mode: 0o600 })
      return bundle
    })
  }
  load(threadId: string, appletId: string, revisionId: string): AppletBundle {
    const bundle = JSON.parse(
      readFileSync(
        join(this.directory(threadId), safeId(appletId), `${safeId(revisionId)}.json`),
        'utf8'
      )
    ) as AppletBundle
    const source = validateAppletSubmission(bundle.source)
    if (
      bundle.threadId !== threadId ||
      bundle.appletId !== appletId ||
      bundle.revisionId !== revisionId ||
      bundle.sourceHash !== digest(JSON.stringify(source))
    )
      throw new AppletValidationError('Applet source integrity check failed.')
    return { ...bundle, source }
  }
  list(threadId: string): AppletReference[] {
    return Object.values(this.index(this.directory(threadId)).heads).map((reference) => {
      this.load(threadId, reference.appletId, reference.revisionId)
      return reference
    })
  }
  saveState(threadId: string, appletId: string, revisionId: string, state: unknown): void {
    if (appletJsonBytes(state) > APPLET_STATE_LIMIT)
      throw new AppletValidationError('Applet state exceeds 64 KiB.')
    const directory = this.directory(threadId)
    withFileLock(join(directory, '.publication.lock'), () => {
      const bundle = this.load(threadId, appletId, revisionId)
      if (this.index(directory).heads[appletId]?.revisionId !== revisionId)
        throw new AppletValidationError('Cannot save state from a stale applet revision.')
      atomicWriteJsonSync(
        join(directory, safeId(appletId), `${safeId(revisionId)}.state.json`),
        { revisionId, stateVersion: bundle.source.stateVersion, state },
        { mode: 0o600 }
      )
    })
  }
  loadState(threadId: string, appletId: string, revisionId: string): unknown {
    let bundle = this.load(threadId, appletId, revisionId)
    const stateVersion = bundle.source.stateVersion
    const visited = new Set<string>()
    while (!visited.has(bundle.revisionId)) {
      visited.add(bundle.revisionId)
      if (bundle.source.stateVersion !== stateVersion) return null
      const path = join(
        this.directory(threadId),
        safeId(appletId),
        `${safeId(bundle.revisionId)}.state.json`
      )
      if (existsSync(path)) {
        const saved = JSON.parse(readFileSync(path, 'utf8')) as {
          revisionId: string
          stateVersion: number
          state: unknown
        }
        if (
          saved.revisionId !== bundle.revisionId ||
          saved.stateVersion !== stateVersion ||
          appletJsonBytes(saved.state) > APPLET_STATE_LIMIT
        )
          return null
        return saved.state
      }
      if (!bundle.previousRevisionId) return null
      bundle = this.load(threadId, appletId, bundle.previousRevisionId)
    }
    return null
  }

  exportSource(threadId: string, appletId: string, revisionId: string): string {
    return JSON.stringify(this.load(threadId, appletId, revisionId).source, null, 2)
  }
  exportHtml(threadId: string, appletId: string, revisionId: string): string {
    return exportAppletHtml(this.load(threadId, appletId, revisionId).source)
  }
}
/** Export is explicitly executable, offline HTML; generated source is confined to its own sandbox. */
export function exportAppletHtml(source: AppletSubmission): string {
  const safe = validateAppletSubmission(source)
  const payload = JSON.stringify(safe)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Exported Mousse applet</title><style>html,body,iframe{width:100%;height:100%;margin:0;border:0}</style><iframe sandbox="allow-scripts" title="Exported applet"></iframe><script>
const s=${payload};
const policy="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; worker-src 'none'; form-action 'none'; base-uri 'none'";
const json=v=>JSON.stringify(v).replace(/</g,'\\\\u003c');
const escapeScript=v=>v.replace(/<\\/script/gi,'<\\\\/script');
const bootstrap="for(const name of ['RTCPeerConnection','webkitRTCPeerConnection','RTCDataChannel','WebTransport']){Object.defineProperty(window,name,{value:undefined,configurable:false,writable:false})}window.mousseApplet={data:"+json(s.data??null)+",state:null,saveState:value=>{window.mousseApplet.state=value},resize:()=>{},reportError:message=>console.error(message),requestConversationInput:()=>{}};";
const script=v=>'<script>'+escapeScript(v)+'<\\/script>';
document.querySelector('iframe').srcdoc='<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="'+policy.replace(/"/g,'&quot;')+'">'+script(bootstrap)+'<style>'+s.css.replace(/<\\/style/gi,'<\\\\/style')+'</style>'+s.html+script(s.js);
</script>`
}
