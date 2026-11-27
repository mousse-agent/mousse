// @vitest-environment jsdom
/**
 * The window keeps each bot's face picture current: it draws a bot whose saved picture was drawn from another look (or
 * none), only in idle time and once the faces draw live, and never loops on a save the service refuses.
 */
import { describe, expect, it } from 'vitest'
import { FACE_PICTURE_PX, facePictureKey, startFacePictureSync, type FacePictureSyncDeps } from '../../src/renderer/components/bots/face/facePictureSync'
import type { BotSummary } from '../../src/shared/bots/personal/chat'
import type { BotLook } from '../../src/shared/bots/personal/look'

const bot = (id: string, look: BotLook, facePicture?: { key?: string }): BotSummary => ({ id, name: id, look, ...(facePicture ? { facePicture } : {}) }) as BotSummary

function fakeWindow(bots: BotSummary[], status: 'pending' | 'ready' | 'failed' = 'ready', save: (key: string) => Promise<unknown> = async () => ({}), lostDraws = 0) {
  let list = bots
  let state = status
  const idle: Array<() => void> = []
  const botListeners: Array<() => void> = []
  const rendererListeners: Array<() => void> = []
  const drawn: Array<{ look: BotLook; side: number }> = []
  const saved: Array<{ botId: string; key: string; png: string }> = []
  let rendererReads = 0
  const deps: FacePictureSyncDeps = {
    bots: () => list,
    onBots: (listener) => {
      botListeners.push(listener)
      return () => {}
    },
    renderer: () => {
      rendererReads++
      return {
        status: () => state,
        subscribe: (listener) => {
          rendererListeners.push(listener)
          return () => {}
        },
        portrait: (look, side) => {
          // A lost context: the faces can't draw for a moment.
          if (lostDraws > 0) { lostDraws--; return null }
          drawn.push({ look, side })
          return document.createElement('canvas')
        }
      }
    },
    encode: async () => 'iVBORw0KGgo=',
    save: async (botId, key, png) => {
      saved.push({ botId, key, png })
      return save(key)
    },
    idle: (callback) => { idle.push(callback) }
  }
  /** Runs every idle callback, and the ones they schedule, until the window is quiet. */
  const settle = async () => {
    for (let round = 0; round < 20 && idle.length; round++) {
      idle.shift()!()
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
  }
  return {
    deps,
    drawn,
    saved,
    settle,
    idleWaiting: () => idle.length,
    rendererReads: () => rendererReads,
    setBots: (next: BotSummary[]) => { list = next; for (const listener of botListeners) listener() },
    becomeReady: () => { state = 'ready'; for (const listener of rendererListeners) listener() }
  }
}

const BLUE = { colour: 'blue', accessory: 'headphones' } as BotLook
const TEAL = { colour: 'teal', accessory: 'cap' } as BotLook

describe('face picture sync', () => {
  it('draws only bots whose picture is missing or from another look, at 512 px, in idle time only', async () => {
    const w = fakeWindow([
      bot('new', BLUE, {}),
      bot('current', TEAL, { key: facePictureKey(TEAL) }),
      bot('stale', TEAL, { key: facePictureKey(BLUE) }),
      // Another computer's bot, or an older service: no face picture field.
      bot('remote', BLUE)
    ])
    startFacePictureSync(w.deps)
    // Nothing on the window's start: not even the renderer is read before the window is idle.
    expect(w.rendererReads()).toBe(0)
    expect(w.idleWaiting()).toBe(1)
    await w.settle()
    expect(w.saved.map((entry) => [entry.botId, entry.key])).toEqual([['new', facePictureKey(BLUE)], ['stale', facePictureKey(TEAL)]])
    expect(w.drawn.every((entry) => entry.side === FACE_PICTURE_PX)).toBe(true)
  })

  it('waits for the faces to draw live, and draws nothing where they never will', async () => {
    const w = fakeWindow([bot('b1', BLUE, {})], 'pending')
    startFacePictureSync(w.deps)
    await w.settle()
    expect(w.drawn).toEqual([])
    w.becomeReady()
    await w.settle()
    expect(w.saved.map((entry) => entry.botId)).toEqual(['b1'])

    const failed = fakeWindow([bot('b1', BLUE, {})], 'failed')
    startFacePictureSync(failed.deps)
    await failed.settle()
    expect(failed.drawn).toEqual([])
  })

  it('a picture the renderer could not draw a moment is drawn once the faces draw again', async () => {
    const w = fakeWindow([bot('b1', BLUE, {}), bot('b2', TEAL, {})], 'ready', async () => ({}), 1)
    startFacePictureSync(w.deps)
    await w.settle()
    expect(w.saved).toEqual([])
    w.becomeReady()
    await w.settle()
    expect(w.saved.map((entry) => entry.botId)).toEqual(['b1', 'b2'])
  })

  it('tries a refused save once in this window, and draws again when the look changes', async () => {
    const w = fakeWindow([bot('b1', BLUE, {})], 'ready', async () => { throw new Error('refused') })
    startFacePictureSync(w.deps)
    await w.settle()
    w.setBots([bot('b1', BLUE, {})])
    await w.settle()
    expect(w.saved).toHaveLength(1)
    w.setBots([bot('b1', TEAL, {})])
    await w.settle()
    expect(w.saved.map((entry) => entry.key)).toEqual([facePictureKey(BLUE), facePictureKey(TEAL)])
  })
})
