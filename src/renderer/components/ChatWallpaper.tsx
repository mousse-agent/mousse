import type { CSSProperties } from 'react'
import { useWallpaperLayer } from '../lib/wallpaper'

/**
 * The active theme's wallpaper behind the chat: one still layer under everything in the pane, outside the scrolling
 * transcript, with the theme's background colour laid over it as the scrim (one paint; no fixed attachment, no blur).
 * The colour also fills what `contain` leaves uncovered. Hidden while the theme pauses for a decision (app CSS).
 */
export function ChatWallpaper() {
  const layer = useWallpaperLayer()
  if (!layer) return null
  const scrim = `color-mix(in srgb, ${layer.base} ${Math.round(layer.scrim * 1000) / 10}%, transparent)`
  const style: CSSProperties = {
    backgroundColor: layer.base,
    backgroundImage: `linear-gradient(${scrim}, ${scrim}), url("${layer.url}")`,
    backgroundSize: `auto, ${layer.fit}`,
    backgroundPosition: `center, ${layer.position}`,
    backgroundRepeat: 'no-repeat'
  }
  return <div data-mousse="wallpaper" className="chat-wallpaper" aria-hidden="true" style={style} />
}
