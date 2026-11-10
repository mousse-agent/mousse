import { useEffect, useRef } from 'react'
import { useAppStore } from '../stores/appStore'

/**
 * The empty thread's glow (ambient-glow.css): a box pinned to the composer that holds the two wave layers.
 * While the window is not focused, or the search palette covers the chat, it marks the chat data-ambient-rest,
 * which holds the glow, the composer's rim and the logo's swirl where they are. An unfocused window then
 * draws nothing, and the palette's full-window blur is not drawn again on every frame of the glow.
 */
export function AmbientGlow() {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const chat = ref.current?.closest('.chat--empty')
    if (!chat) return
    const update = () => chat.toggleAttribute('data-ambient-rest', !document.hasFocus() || useAppStore.getState().paletteOpen)
    update()
    window.addEventListener('focus', update)
    window.addEventListener('blur', update)
    const unsubscribe = useAppStore.subscribe((state, previous) => {
      if (state.paletteOpen !== previous.paletteOpen) update()
    })
    return () => {
      unsubscribe()
      window.removeEventListener('focus', update)
      window.removeEventListener('blur', update)
      chat.removeAttribute('data-ambient-rest')
    }
  }, [])

  return (
    <div ref={ref} className="ambient-glow" aria-hidden="true">
      <span className="ambient-glow-wave ambient-glow-wave--a" />
      <span className="ambient-glow-wave ambient-glow-wave--b" />
    </div>
  )
}
