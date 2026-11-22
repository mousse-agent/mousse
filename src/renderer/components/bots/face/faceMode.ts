import { useSyncExternalStore } from 'react'

/**
 * How a moving bot face is drawn, from Settings → Labs → Performance (`experimental.hybridBotFaces`):
 * - `live` (the default): the whole face ray-marched every frame (`BotFaceLive`).
 * - `hybrid`: the clay body drawn once per state by the shader and kept as a picture, with flat 2D
 *   eyes animated on top (`HybridFace.tsx`). Nothing is ray-marched while it moves.
 * Every face follows the setting as it changes.
 */
export type FaceMode = 'hybrid' | 'live'

type SettingsLike = { experimental?: { hybridBotFaces?: boolean } } | null | undefined

const listeners = new Set<() => void>()
let mode: FaceMode = 'live'
let watching = false

export function faceMode(): FaceMode {
  return mode
}

export function applyFaceMode(settings: SettingsLike): void {
  const next: FaceMode = settings?.experimental?.hybridBotFaces === true ? 'hybrid' : 'live'
  if (next === mode) return
  mode = next
  for (const listener of listeners) listener()
}

/** Reads the setting once and follows its changes, from the first face that asks. */
function watch(): void {
  if (watching) return
  const api = typeof window === 'undefined' ? undefined : window.mousse?.settings
  if (!api) return
  watching = true
  api.onChanged?.((settings) => applyFaceMode(settings))
  void api.get?.().then(applyFaceMode).catch(() => undefined)
}

function subscribe(listener: () => void): () => void {
  watch()
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useFaceMode(): FaceMode {
  return useSyncExternalStore(subscribe, faceMode, () => 'live' as const)
}
