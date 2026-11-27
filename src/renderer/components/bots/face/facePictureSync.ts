import { botEyeColourOf, botEyesOf, botKindOf, normalizeBotLook, type KnownBotLook } from '../../../../shared/bots/personal/look'
import type { BotSummary } from '../../../../shared/bots/personal/chat'
import { faceArtVersion, type FaceRenderer } from './faceRenderer'

/**
 * Each bot's face picture (`face.png` in its files folder, `docs/bots.md`): the app draws it, as only the renderer has
 * the face shader, and the service writes it (`bots.facePicture.save`). A bot's summary carries the key its saved
 * picture was drawn from; when the key this window would draw differs (a new look, new art, or no picture yet), the
 * window draws it once the faces draw live, in idle time, one bot at a time, and sends it. Nothing waits on it: a window
 * that can't draw (no WebGL, a failed compile) or a save that fails leaves the old picture, tried again in the next
 * window. A key tried once in this window is not tried again, so a save the service refuses never loops.
 */

/** The picture's side, in pixels: large enough for an account's avatar. */
export const FACE_PICTURE_PX = 512
/** The whole character, front on, so an accessory above or around the head shows. */
export const FACE_PICTURE_VIEW = 'full' as const

let artVersion: string | undefined

/** What a picture of `look` is drawn from: the look as the face shows it, the view and size, and the art version. */
export function facePictureKey(look: KnownBotLook): string {
  artVersion ??= faceArtVersion()
  return `v1|${look.colour}|${look.accessory}|${botKindOf(look)}|${botEyesOf(look)}|${botEyeColourOf(look)}|${FACE_PICTURE_VIEW}|${FACE_PICTURE_PX}|${artVersion}`
}

export interface FacePictureSyncDeps {
  bots(): readonly BotSummary[]
  /** Calls `listener` when the bots change; returns a function that stops it. */
  onBots(listener: () => void): () => void
  /** The window's face renderer, or null when it has none. Read only in idle time, so it is never made early. */
  renderer(): Pick<FaceRenderer, 'status' | 'subscribe' | 'portrait'> | null
  /** The picture as PNG base64, or null. */
  encode(canvas: HTMLCanvasElement): Promise<string | null>
  save(botId: string, key: string, png: string): Promise<unknown>
  /** Runs `callback` when the window is idle. */
  idle(callback: () => void): void
}

/** Starts keeping the face pictures current; returns a function that stops it. */
export function startFacePictureSync(deps: FacePictureSyncDeps): () => void {
  const tried = new Set<string>()
  let scheduled = false
  let busy = false
  let stopped = false
  let unsubscribeRenderer: (() => void) | null = null

  const due = (): { bot: BotSummary; look: KnownBotLook; key: string } | undefined => {
    for (const bot of deps.bots()) {
      // An older service saves no pictures, and another computer's bot is drawn by its own computer's app.
      if (!bot.facePicture) continue
      const look = normalizeBotLook(bot.look)
      const key = facePictureKey(look)
      if (bot.facePicture.key === key || tried.has(`${bot.id}|${key}`)) continue
      return { bot, look, key }
    }
    return undefined
  }

  const run = async (): Promise<void> => {
    scheduled = false
    if (stopped || busy) return
    const next = due()
    if (!next) return
    const renderer = deps.renderer()
    if (!renderer || renderer.status() === 'failed') return
    if (renderer.status() !== 'ready') {
      // Drawn once the shader is ready.
      unsubscribeRenderer ??= renderer.subscribe(() => check())
      return
    }
    tried.add(`${next.bot.id}|${next.key}`)
    const canvas = renderer.portrait(next.look, FACE_PICTURE_PX, FACE_PICTURE_VIEW)
    if (!canvas) return
    busy = true
    try {
      const png = await deps.encode(canvas)
      if (png && !stopped) await deps.save(next.bot.id, next.key, png)
    } catch {
      // Left as it was; the next window tries again.
    } finally {
      busy = false
    }
    // The next bot, in its own idle time.
    check()
  }

  const check = (): void => {
    if (stopped || scheduled || busy) return
    scheduled = true
    deps.idle(() => { void run() })
  }

  const unsubscribeBots = deps.onBots(check)
  check()
  return () => {
    stopped = true
    unsubscribeBots()
    unsubscribeRenderer?.()
  }
}

/** A canvas as PNG base64, in the browser. */
export async function canvasPngBase64(canvas: HTMLCanvasElement): Promise<string | null> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
  if (!blob) return null
  const url = await new Promise<string | null>((resolve) => {
    const reader = new FileReader()
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null)
    reader.onerror = () => resolve(null)
    reader.readAsDataURL(blob)
  })
  const comma = url?.indexOf(',') ?? -1
  return url && comma >= 0 ? url.slice(comma + 1) : null
}
