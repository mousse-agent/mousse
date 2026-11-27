import { botsClient, useBotsStore } from '../../../stores/botsStore'
import { sharedFaceRenderer } from './faceRenderer'
import { canvasPngBase64, startFacePictureSync } from './facePictureSync'

/** The longest a face picture waits for the window to go idle. */
const IDLE_TIMEOUT_MS = 5_000

/**
 * Keeps this window's bots' face pictures current (`facePictureSync.ts`), from the Bots store, in idle time once the
 * faces draw live: never on the window's start or a bot's turn.
 */
export function startFacePictures(win: Window = window): () => void {
  return startFacePictureSync({
    bots: () => useBotsStore.getState().bots,
    onBots: (listener) => useBotsStore.subscribe((state, previous) => {
      if (state.bots !== previous.bots) listener()
    }),
    renderer: () => sharedFaceRenderer(),
    encode: canvasPngBase64,
    save: (botId, key, png) => botsClient().saveFacePicture(botId, key, png),
    idle: (callback) => {
      if (typeof win.requestIdleCallback === 'function') win.requestIdleCallback(() => callback(), { timeout: IDLE_TIMEOUT_MS })
      else win.setTimeout(callback, 1_000)
    }
  })
}
