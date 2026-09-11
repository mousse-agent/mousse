import { runBrowserWorkerMain } from './ipc/host'

export { runBrowserWorkerHost, runBrowserWorkerMain } from './ipc/host'
export { SessionManager } from './session/SessionManager'
export { ManagedSession } from './session/Session'
export { resolveCertifiedBrowser } from './binary/resolver'
export { installCertifiedChrome } from './binary/install'
export { encodeWorkerFrame, WorkerFrameDecoder } from './ipc/framing'
export { encodeCdpMessage, CdpAsciiDecoder } from './cdp/framing'
export { CdpConnection } from './cdp/connection'
export type { CdpTransport, CdpCommandOptions } from './cdp/transport'
export { BrowserReferenceStore } from './observation/ReferenceStore'

if (process.env.MOUSSE_BROWSER_WORKER === '1') {
  runBrowserWorkerMain().catch((error) => {
    process.stderr.write((error instanceof Error ? error.stack ?? error.message : String(error)) + '\n')
    process.exit(1)
  })
}
