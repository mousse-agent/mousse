import { useEffect, useRef, useState, type RefObject } from 'react'
import type { AppletReference } from '../../../shared/applets'
import { readAppletAppearance, subscribeAppletAppearance } from './appearance'
import { appletHeightKey, rememberAppletHeight, rememberedAppletHeight } from './appletHeights'
import type { AppletUiEvent } from '../../../shared/appletRuntime'

/**
 * Where a preview sits. In the transcript it scrolls with the chat and takes the height its page reports; in the side
 * panel it fills a fixed stage.
 */
export type AppletHost = 'transcript' | 'panel'

export interface AppletRuntimeOptions {
  host: AppletHost
  threadId: string | null
  profileId: string | null
  reference: AppletReference
  /** False while the preview element is not shown (the source view replaces it). */
  enabled: boolean
  /** Bumped to start the applet again. */
  restart: number
}

/** Mounts begin this far before the card scrolls into view, so its page is usually ready when it arrives. */
const MOUNT_MARGIN = '200px 0px'

/**
 * Cards waiting for an applet slot (all three hold applets on screen). Each tries again when a slot may have come
 * free: a page of this window was unmounted, released or stopped, or a card left the screen.
 */
const slotWaiters = new Set<() => void>()
function slotMayBeFree() {
  for (const retry of [...slotWaiters]) retry()
}

/**
 * Starts the applet when its preview comes near the screen and returns the address of its page, which the preview
 * draws in a `<webview>` (`AppletFrame`). The page runs in its own process and session that the main process owns; the
 * window's own scrolling, clipping and layering place it, so nothing here follows geometry. A card out of sight tells
 * main, which may then release its page for a newer applet; a released card starts again when it comes back.
 */
export function useAppletRuntime(preview: RefObject<HTMLDivElement | null>, options: AppletRuntimeOptions) {
  const { host, threadId, profileId, reference, enabled, restart } = options
  const runtime = useRef<string | null>(null)
  const webview = useRef<HTMLWebViewElement | null>(null)
  const [src, setSrc] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [ready, setReady] = useState(false)
  // In the transcript a card starts at the height this revision last measured; the side panel fills its stage.
  const heightKey = host === 'transcript' ? appletHeightKey(profileId, threadId, reference.revisionId) : null
  const [measured, setMeasured] = useState<{ key: string | null; height: number } | null>(null)
  const height = measured && measured.key === heightKey ? measured.height : heightKey ? rememberedAppletHeight(heightKey) : null
  const [conversationInput, setConversationInput] = useState<string | null>(null)

  useEffect(() => {
    setConversationInput(null)
    setError(null)
  }, [profileId, threadId, reference.revisionId])

  useEffect(() => {
    if (!threadId || !preview.current || !enabled) return
    const node = preview.current
    const api = window.mousse.applets
    // A thread's transcript, or another conversation that shows applets (a bot's chat marks its own).
    const scroller = host === 'transcript' ? node.closest<HTMLElement>('.an-message-list, [data-applet-scroller]') : null
    let disposed = false
    let mounting = false
    let failed = false
    let intersecting = false
    // On screen, not just near it: only a card out of sight may lose its page to a newer applet.
    let onScreen = false
    let shown = true
    let appearance = readAppletAppearance()
    let resizeTimer: ReturnType<typeof setTimeout> | undefined
    let sized = false
    setReady(false)
    setSrc(null)
    const drop = () => {
      runtime.current = null
      setSrc(null)
      setReady(false)
    }
    const remove = () => {
      const id = runtime.current
      drop()
      if (id) void api.unmount({ runtimeId: id }).then(slotMayBeFree, () => {})
    }
    const report = () => {
      const id = runtime.current
      if (!id || shown === onScreen) return
      shown = onScreen
      const sent = api.visible({ runtimeId: id, visible: onScreen })
      if (!onScreen) void sent.then(slotMayBeFree, () => {})
      else void sent.catch(() => {})
    }
    const retry = () => {
      slotWaiters.delete(retry)
      void start()
    }
    const start = async () => {
      if (disposed || failed || mounting || runtime.current || !intersecting) return
      mounting = true
      slotWaiters.delete(retry)
      let busy = false
      try {
        const result = await api.mount({
          threadId,
          appletId: reference.appletId,
          revisionId: reference.revisionId,
          sourceHash: reference.sourceHash,
          appearance,
          host
        })
        if ('busy' in result) {
          // Every slot holds an applet on screen: wait quietly (the card stays in its loading state) for one.
          busy = true
          if (!disposed) slotWaiters.add(retry)
          return
        }
        if (disposed) {
          await api.unmount({ runtimeId: result.runtimeId }).catch(() => {})
          return
        }
        runtime.current = result.runtimeId
        shown = true
        setSrc(result.src)
        report()
      } catch (cause) {
        if (!disposed) {
          failed = true
          setError(cause instanceof Error ? cause.message : 'Unable to open applet.')
        }
      } finally {
        mounting = false
      }
      // The card may have come back while a released page was still being replaced.
      if (!busy && !disposed && !runtime.current && intersecting) void start()
    }
    const intersection = new IntersectionObserver(
      (entries) => {
        intersecting = entries.some((entry) => entry.isIntersecting)
        report()
        void start()
      },
      { root: scroller, rootMargin: MOUNT_MARGIN }
    )
    intersection.observe(node)
    const sight = new IntersectionObserver(
      (entries) => {
        onScreen = entries.some((entry) => entry.isIntersecting)
        report()
      },
      { root: scroller }
    )
    sight.observe(node)
    const unsubscribeAppearance = subscribeAppletAppearance((value) => {
      appearance = value
      const id = runtime.current
      if (id) void api.appearance({ runtimeId: id, appearance: value }).catch(() => {})
    })
    const receive = (event: AppletUiEvent) => {
      if (event.type === 'released' || event.type === 'error') queueMicrotask(slotMayBeFree)
      if (event.runtimeId !== runtime.current) return
      if (event.type === 'released') {
        drop()
        void start()
        return
      }
      if (event.type === 'error') {
        failed = true
        setError(event.message || 'Applet stopped.')
        remove()
        return
      }
      if (event.type === 'resize' && Number.isFinite(event.height)) {
        const next = event.height!
        if (heightKey) rememberAppletHeight(heightKey, next)
        clearTimeout(resizeTimer)
        // The first report sizes the frame at once; later ones settle first so a burst moves it once.
        if (!sized) {
          sized = true
          setMeasured({ key: heightKey, height: next })
        } else
          resizeTimer = setTimeout(() => {
            if (!disposed) setMeasured({ key: heightKey, height: next })
          }, 80)
      }
      if (event.type === 'ready') setReady(true)
      // The browser already scrolled the conversation; its own wheel listeners (following the end) hear of it here.
      if (event.type === 'wheel' && Number.isFinite(event.deltaY) && event.deltaY)
        webview.current?.dispatchEvent(new WheelEvent('wheel', { deltaY: event.deltaY, deltaMode: 0, bubbles: true }))
      if (event.type === 'escape') webview.current?.blur()
      if (event.type === 'conversation-input' && typeof event.text === 'string')
        setConversationInput(event.text.slice(0, 8000))
    }
    const unsubscribe = api.onEvent(receive)
    return () => {
      disposed = true
      slotWaiters.delete(retry)
      intersection.disconnect()
      sight.disconnect()
      unsubscribe()
      unsubscribeAppearance()
      clearTimeout(resizeTimer)
      const id = runtime.current
      runtime.current = null
      if (id) void api.unmount({ runtimeId: id }).then(slotMayBeFree, () => {})
      // The page is gone with its runtime; its webview goes too (another thread opened, Source replaced the preview).
      setSrc(null)
      setReady(false)
    }
  }, [
    host,
    threadId,
    profileId,
    reference.appletId,
    reference.revisionId,
    reference.sourceHash,
    enabled,
    restart
  ])

  return { runtime, webview, src, ready, error, setError, height, conversationInput, setConversationInput }
}
