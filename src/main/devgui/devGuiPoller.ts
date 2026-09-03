import type { BrowserWindow } from 'electron'
import type { GuiMmsController } from '../mms/GuiMmsController'
import {
  executeDevGuiAction,
  isDevGuiMainEnabled
} from './devGuiMain'

/**
 * Dev-only poller: takes pending self-inspection requests queued by the MMS
 * daemon (`gui.devtoolsPoll`), executes them against the live dev window, and
 * answers via `gui.devtoolsRespond` so orchestrator tools resolve.
 *
 * No-op unless the dev GUI is enabled. Poll failures are silent (the daemon
 * bridge times out on its side and reports back to the model).
 */

const POLL_INTERVAL_MS = 1_000

interface PolledRequest {
  id: string
  action: string
  payload?: Record<string, unknown>
}

export function startDevGuiPoller(
  guiMms: GuiMmsController,
  getWindow: () => BrowserWindow | null
): () => void {
  if (!isDevGuiMainEnabled()) return () => {}

  let stopped = false
  let inFlight = false
  let loggedStart = false

  const tick = async (): Promise<void> => {
    if (stopped || inFlight) return
    if (!guiMms.connected) return
    inFlight = true
    try {
      if (!loggedStart) {
        loggedStart = true
        const home = process.env.MOUSSE_HOME ?? '(default)'
        const instance = guiMms.hello?.instanceId ?? '(unknown)'
        console.log(`[devgui] poller started (MOUSSE_HOME=${home}, daemon=${instance})`)
      }
      const res = await guiMms.request<{ requests: PolledRequest[] }>('gui.devtoolsPoll')
      const requests = Array.isArray(res.requests) ? res.requests : []
      for (const req of requests) {
        if (stopped) return
        if (!req || typeof req.id !== 'string' || typeof req.action !== 'string') continue
        const payload =
          req.payload && typeof req.payload === 'object' && !Array.isArray(req.payload)
            ? (req.payload as Record<string, unknown>)
            : {}
        try {
          const outcome = await executeDevGuiAction(req.action, payload, getWindow)
          console.log(`[devgui] ${req.action} (${req.id}) -> ${outcome.ok ? 'ok' : `error: ${outcome.error ?? 'unknown'}`}`)
          await guiMms.request('gui.devtoolsRespond', {
            requestId: req.id,
            ok: outcome.ok,
            ...(outcome.text !== undefined ? { text: outcome.text } : {}),
            ...(outcome.dataUrl !== undefined ? { dataUrl: outcome.dataUrl } : {}),
            ...(outcome.savedPath !== undefined ? { savedPath: outcome.savedPath } : {}),
            ...(outcome.width !== undefined ? { width: outcome.width } : {}),
            ...(outcome.height !== undefined ? { height: outcome.height } : {}),
            ...(outcome.error !== undefined ? { error: outcome.error } : {})
          })
        } catch (err) {
          try {
            await guiMms.request('gui.devtoolsRespond', {
              requestId: req.id,
              ok: false,
              error: err instanceof Error ? err.message : String(err)
            })
          } catch {
            /* bridge times out on its own */
          }
        }
      }
    } catch {
      /* daemon restarting or unreachable — retry on the next tick */
    } finally {
      inFlight = false
    }
  }

  const timer = setInterval(() => {
    void tick()
  }, POLL_INTERVAL_MS)
  return () => {
    stopped = true
    clearInterval(timer)
  }
}
