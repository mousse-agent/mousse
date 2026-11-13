import { useEffect, useRef, useState, type RefObject } from 'react'
import type { AppletReference } from '../../../shared/applets'
import { readAppletAppearance, subscribeAppletAppearance } from './appearance'
import { subscribeAppletScroll } from './scrollPresentation'
import { appletHostBlocked, appletHostShown, subscribeAppletHostVisibility } from './hostVisibility'

/**
 * Where a preview sits. In the transcript it scrolls with the chat and stays above the composer; in the side panel
 * it fills a fixed stage and is clipped to it.
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

/**
 * Mounts the applet's isolated native view over `preview`, keeps it on the element's bounds and clip, and parks it
 * when hidden. No generated code enters this DOM: the guest is a separate sandboxed view placed by the main process.
 */
export function useAppletRuntime(preview: RefObject<HTMLDivElement | null>, options: AppletRuntimeOptions) {
  const { host, threadId, profileId, reference, enabled, restart } = options
  const runtime = useRef<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [ready, setReady] = useState(false)
  const [scrollImage, setScrollImage] = useState<string | null>(null)
  const [height, setHeight] = useState<number | null>(null)
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
    // The panel stage does not scroll; it is the clip itself.
    const clipHost = host === 'transcript' ? scroller : node.parentElement
    let disposed = false
    let scrollPaused = false
    setScrollImage(null)
    let parked = false
    let mounting = false
    let intersecting = false
    let failed = false
    let frame = 0
    let appearance = readAppletAppearance()
    let lastGeometry = ''
    let resizeTimer: ReturnType<typeof setTimeout> | undefined
    setReady(false)
    const remove = () => {
      const id = runtime.current
      runtime.current = null
      if (id) void api.unmount({ runtimeId: id }).catch(() => {})
      setReady(false)
    }
    let snapshotTimer: ReturnType<typeof setTimeout> | undefined
    let capturing = false
    let snapshotVersion = 0
    // Prepare the DOM frame while stationary, never on the wheel's critical path.
    const refreshSnapshot = () => {
      clearTimeout(snapshotTimer)
      if (!scroller || disposed || scrollPaused || parked || !runtime.current) return
      const captureSnapshot = async () => {
        if (disposed || scrollPaused || parked || !runtime.current) return
        if (capturing) { refreshSnapshot(); return }
        const id = runtime.current, version = snapshotVersion
        capturing = true
        try {
          const result = await api.snapshot({ runtimeId: id })
          if (!result.image) return
          const image = new Image()
          image.src = result.image
          await image.decode()
          if (!disposed && !scrollPaused && !parked && runtime.current === id && version === snapshotVersion)
            setScrollImage(result.image)
        } catch {
          /* A missing cached frame must never prevent native scrolling. */
        } finally {
          capturing = false
        }
      }
      snapshotTimer = setTimeout(() => { void captureSnapshot() }, 100)
    }
    const suspend = async () => {
      scrollPaused = true
      snapshotVersion++
      clearTimeout(snapshotTimer)
      cancelAnimationFrame(frame)
      frame = 0
      const id = runtime.current
      if (id) await api.suspend({ runtimeId: id }).catch(() => {})
    }
    const measure = async () => {
      frame = 0
      if (disposed || failed) return
      // A hidden window (minimized, or hidden to the tray) releases the applet; it starts again when shown.
      if (document.visibilityState === 'hidden') {
        remove()
        return
      }
      // Hidden native guests need no per-frame geometry or teardown while scrolling.
      if (scrollPaused) return
      const rect = node.getBoundingClientRect()
      const viewport = clipHost?.getBoundingClientRect()
      // The composer of the conversation the applet is in: a hidden one elsewhere (the thread's, behind a bot's chat)
      // has no place on screen.
      const composer = host === 'transcript'
        ? node.closest('.mousse-chat-shell, [data-applet-conversation]')?.querySelector('.chat-composer-stack, [data-applet-composer]') ??
          document.querySelector('.chat-composer-stack')
        : null
      const composerTop = composer?.getBoundingClientRect().top ?? window.innerHeight
      const clip = {
        x: Math.max(0, viewport?.left ?? 0),
        y: Math.max(0, viewport?.top ?? 0),
        width:
          Math.min(window.innerWidth, viewport?.right ?? window.innerWidth) -
          Math.max(0, viewport?.left ?? 0),
        height:
          Math.min(window.innerHeight, composerTop, viewport?.bottom ?? window.innerHeight) -
          Math.max(0, viewport?.top ?? 0)
      }
      const area = {
        x: Math.max(rect.left, clip.x),
        y: Math.max(rect.top, clip.y),
        width: Math.min(rect.right, clip.x + clip.width) - Math.max(rect.left, clip.x),
        height: Math.min(rect.bottom, clip.y + clip.height) - Math.max(rect.top, clip.y)
      }
      // The native view draws above the whole page, so it shows only while its host really does: inside its clip,
      // in the page, rendered, not in a replaced or covered part of the app, and with nothing drawn over it.
      const visible = area.width > 0 && area.height > 0 && appletHostShown(node, area)
      if (!visible) {
        const id = runtime.current
        if (id && !parked) {
          parked = true
          clearTimeout(snapshotTimer)
          void api.update({ runtimeId: id, bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, clip, visible: false }).catch(() => {})
        }
        return
      }
      if (parked) { parked = false; lastGeometry = '' }
      if (scrollPaused && !runtime.current) return
      const bounds = { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
      if (!runtime.current && !mounting) {
        mounting = true
        try {
          const result = await api.mount({
            threadId,
            appletId: reference.appletId,
            revisionId: reference.revisionId,
            sourceHash: reference.sourceHash,
            bounds,
            clip,
            appearance
          })
          if (disposed) {
            await api.unmount({ runtimeId: result.runtimeId })
            return
          }
          runtime.current = result.runtimeId
          await api.appearance({ runtimeId: result.runtimeId, appearance }).catch(() => {})
          if (disposed) return
          lastGeometry = ''
          setReady(true)
          if (scrollPaused) await suspend()
          else refreshSnapshot()
          schedule()
        } catch (cause) {
          if (!disposed) {
            failed = true
            setError(cause instanceof Error ? cause.message : 'Unable to open applet.')
          }
        } finally {
          mounting = false
        }
      }
      const geometry = JSON.stringify({ bounds, clip })
      if (runtime.current && !scrollPaused && geometry !== lastGeometry) {
        lastGeometry = geometry
        void api
          .update({ runtimeId: runtime.current, bounds, clip, visible: true })
          .then(refreshSnapshot)
          .catch((cause) => {
            if (!disposed) {
              failed = true
              setError(cause instanceof Error ? cause.message : 'Applet preview stopped.')
              remove()
            }
          })
      }
    }
    const schedule = () => {
      if (scrollPaused && document.visibilityState !== 'hidden' && !appletHostBlocked()) return
      if (!intersecting && !runtime.current) return
      if (!frame)
        frame = requestAnimationFrame(() => {
          void measure()
        })
    }
    const unsubscribeScroll = scroller
      ? subscribeAppletScroll(scroller, {
          active: () => !!runtime.current || (mounting && intersecting),
          suspend,
          resume: () => {
            scrollPaused = false
            lastGeometry = ''
            schedule()
          }
        })
      : () => {}
    const unsubscribeAppearance = subscribeAppletAppearance((value) => {
      appearance = value
      const id = runtime.current
      if (id) void api.appearance({ runtimeId: id, appearance: value }).then(refreshSnapshot).catch(() => {})
    })
    const unsubscribeHost = subscribeAppletHostVisibility(schedule)
    const observer = new ResizeObserver(schedule)
    observer.observe(node)
    if (clipHost) observer.observe(clipHost)
    if (scroller?.firstElementChild) observer.observe(scroller.firstElementChild)
    const composerNode = host === 'transcript' ? document.querySelector('.chat-composer-stack') : null
    if (composerNode) observer.observe(composerNode)
    const intersection = new IntersectionObserver(
      (entries) => {
        intersecting = entries.some((entry) => entry.isIntersecting)
        schedule()
      },
      { root: scroller }
    )
    intersection.observe(node)
    window.addEventListener('scroll', schedule, true)
    window.addEventListener('resize', schedule)
    document.addEventListener('visibilitychange', schedule)
    const unsubscribe = api.onEvent((event) => {
      if (event.runtimeId !== runtime.current) return
      if (event.type === 'released') {
        runtime.current = null
        parked = false
        lastGeometry = ''
        snapshotVersion++
        setScrollImage(null)
        setReady(false)
        if (intersecting) schedule()
        return
      }
      if (event.type === 'error') {
        failed = true
        setError(event.message || 'Applet stopped.')
        remove()
      }
      if (event.type === 'resize' && Number.isFinite(event.height)) {
        clearTimeout(resizeTimer)
        resizeTimer = setTimeout(() => {
          if (!disposed) setHeight(event.height!)
        }, 80)
      }
      if (event.type === 'ready') { setReady(true); refreshSnapshot() }
      if (event.type === 'state-changed' || event.type === 'visual-changed') {
        // Inner scroll/input changed pixels without changing saved state.
        snapshotVersion++
        setScrollImage(null)
        refreshSnapshot()
      }
      if (event.type === 'conversation-input' && typeof event.text === 'string')
        setConversationInput(event.text.slice(0, 8000))
    })
    schedule()
    return () => {
      disposed = true
      cancelAnimationFrame(frame)
      observer.disconnect()
      intersection.disconnect()
      unsubscribe()
      unsubscribeHost()
      unsubscribeAppearance()
      unsubscribeScroll()
      clearTimeout(resizeTimer)
      clearTimeout(snapshotTimer)
      window.removeEventListener('scroll', schedule, true)
      window.removeEventListener('resize', schedule)
      document.removeEventListener('visibilitychange', schedule)
      const id = runtime.current
      runtime.current = null
      if (id) void api.unmount({ runtimeId: id }).catch(() => {})
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

  return { runtime, ready, error, setError, scrollImage, height, conversationInput, setConversationInput }
}
