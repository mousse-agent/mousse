import { memo, useEffect, useRef, useState } from 'react'
import type { AppletBundle, AppletReference } from '../../../shared/applets'
import { useAppStore } from '../../stores/appStore'
import './applets.css'
import { Button } from '../ui/Button'
import { readAppletAppearance, subscribeAppletAppearance } from './appearance'
import { subscribeAppletScroll } from './scrollPresentation'
import { appletHostBlocked, subscribeAppletHostVisibility } from './hostVisibility'

export function isAppletPart(
  value: unknown
): value is { type: 'data-applet'; data: AppletReference } {
  if (!value || typeof value !== 'object') return false
  const part = value as { type?: unknown; data?: unknown }
  if (part.type !== 'data-applet' || !part.data || typeof part.data !== 'object') return false
  const ref = part.data as Record<string, unknown>
  return ['appletId', 'revisionId', 'sourceHash', 'title', 'description'].every(
    (key) => typeof ref[key] === 'string'
  )
}

/** Native guest content is mounted only in the measured preview; no generated code enters this DOM. */
export const AppletCard = memo(function AppletCard({ reference }: { reference: AppletReference }) {
  const threadId = useAppStore((s) => s.activeThreadId)
  const profileId = useAppStore((s) => s.profileId)
  const preview = useRef<HTMLDivElement>(null)
  const runtime = useRef<string | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [sourceOpen, setSourceOpen] = useState(false)
  const [bundle, setBundle] = useState<AppletBundle | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [ready, setReady] = useState(false)
  const [scrollImage, setScrollImage] = useState<string | null>(null)
  const [restart, setRestart] = useState(0)
  const [height, setHeight] = useState(320)
  const [conversationInput, setConversationInput] = useState<string | null>(null)

  useEffect(() => {
    setBundle(null)
    setConversationInput(null)
    setSourceOpen(false)
    setError(null)
  }, [profileId, threadId, reference.revisionId])

  useEffect(() => {
    if (!threadId || !preview.current || sourceOpen) return
    const node = preview.current
    const api = window.mousse.applets
    const scroller = node.closest<HTMLElement>('.an-message-list')
    let disposed = false
    let scrollPaused = false
    setScrollImage(null)
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
    const suspend = async () => {
      scrollPaused = true
      const id = runtime.current
      if (!id) return
      try {
        const result = await api.snapshot({ runtimeId: id })
        if (!disposed && scrollPaused && runtime.current === id) {
          if (result.image) {
            const image = new Image()
            image.src = result.image
            await image.decode().catch(() => {})
          }
          if (disposed || !scrollPaused || runtime.current !== id) return
          setScrollImage(result.image)
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
          if (!disposed && scrollPaused && runtime.current === id)
            await api.suspend({ runtimeId: id })
        }
      } catch {
        /* Profile/thread teardown owns the guest lifecycle. */
      }
    }
    const measure = async () => {
      frame = 0
      if (disposed || failed) return
      const rect = node.getBoundingClientRect()
      const viewport = scroller?.getBoundingClientRect()
      const composer =
        node.closest('.mousse-chat-shell')?.querySelector('.chat-composer-stack') ??
        document.querySelector('.chat-composer-stack')
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
      const visible =
        rect.bottom > clip.y &&
        rect.top < clip.y + clip.height &&
        rect.width > 0 &&
        document.visibilityState !== 'hidden' &&
        !appletHostBlocked()
      if (!visible) {
        remove()
        return
      }
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
      if (id) void api.appearance({ runtimeId: id, appearance: value }).catch(() => {})
    })
    const unsubscribeHost = subscribeAppletHostVisibility(schedule)
    const observer = new ResizeObserver(schedule)
    observer.observe(node)
    if (scroller) observer.observe(scroller)
    if (scroller?.firstElementChild) observer.observe(scroller.firstElementChild)
    const composerNode = document.querySelector('.chat-composer-stack')
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
      if (event.type === 'error') {
        failed = true
        setError(event.message || 'Applet stopped.')
        remove()
      }
      if (event.type === 'resize' && Number.isFinite(event.height)) {
        clearTimeout(resizeTimer)
        resizeTimer = setTimeout(() => {
          if (!disposed) setHeight(Math.max(180, Math.min(540, event.height!)))
        }, 80)
      }
      if (event.type === 'ready') setReady(true)
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
      window.removeEventListener('scroll', schedule, true)
      window.removeEventListener('resize', schedule)
      document.removeEventListener('visibilitychange', schedule)
      const id = runtime.current
      runtime.current = null
      if (id) void api.unmount({ runtimeId: id }).catch(() => {})
    }
  }, [
    threadId,
    profileId,
    reference.appletId,
    reference.revisionId,
    reference.sourceHash,
    sourceOpen,
    restart
  ])

  const showSource = async () => {
    setSourceOpen((value) => !value)
    if (!bundle && threadId) {
      try {
        const result = await window.mousse.applets.get({
          threadId,
          appletId: reference.appletId,
          revisionId: reference.revisionId
        })
        const current = useAppStore.getState()
        if (current.profileId === profileId && current.activeThreadId === threadId)
          setBundle(result)
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Source unavailable.')
      }
    }
  }
  const addConversationInput = () => {
    if (!threadId || !conversationInput) return
    const state = useAppStore.getState()
    if (state.profileId !== profileId || state.activeThreadId !== threadId) return
    const draft = state.composerDrafts[threadId] ?? ''
    const request = `From applet "${reference.title}":\n${conversationInput}`
    state.setComposerDraft(threadId, draft ? `${draft}\n\n${request}` : request)
    setConversationInput(null)
  }
  const requestRepair = () => {
    if (!threadId) return
    const state = useAppStore.getState()
    if (state.profileId !== profileId || state.activeThreadId !== threadId) return
    const request = `Please fix applet "${reference.title}" (appletId: ${reference.appletId}, expectedRevision: ${reference.revisionId}). Runtime diagnostic: ${(error ?? 'The applet needs repair.').slice(0, 2000)}`
    const draft = state.composerDrafts[threadId] ?? ''
    state.setComposerDraft(threadId, draft ? `${draft}\n\n${request}` : request)
  }
  const exportApplet = async (format: 'html' | 'source' | 'png') => {
    if (!threadId) return
    try {
      await window.mousse.applets.export({
        threadId,
        appletId: reference.appletId,
        revisionId: reference.revisionId,
        format,
        appearance: readAppletAppearance(),
        runtimeId: runtime.current ?? undefined
      })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Export failed.')
    }
  }
  return (
    <section className="mousse-applet" aria-label={`Interactive applet: ${reference.title}`}>
      <header className="mousse-applet-header">
        <div>
          <strong>{reference.title}</strong>
          <p>{reference.description}</p>
        </div>
        <span className="mousse-applet-revision" title={reference.revisionId}>
          Revision {reference.revisionId.slice(0, 8)}
        </span>
      </header>
      <div className="mousse-applet-actions">
        <Button
          size="sm"
          type="button"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
        >
          {expanded ? 'Collapse' : 'Expand'}
        </Button>
        <Button
          size="sm"
          type="button"
          onClick={() => {
            setError(null)
            setRestart((value) => value + 1)
          }}
        >
          Restart
        </Button>
        <Button
          size="sm"
          type="button"
          onClick={() => void showSource()}
          aria-expanded={sourceOpen}
        >
          {sourceOpen ? 'Preview' : 'Source'}
        </Button>
        <Button size="sm" type="button" onClick={() => void exportApplet('html')}>
          Export HTML
        </Button>
        <Button size="sm" type="button" onClick={() => void exportApplet('source')}>
          Export source
        </Button>
        <Button size="sm" type="button" disabled={!ready} onClick={() => void exportApplet('png')}>
          Export PNG
        </Button>
      </div>
      {error && (
        <p className="mousse-applet-error" role="alert">
          {error}
          <Button size="sm" type="button" onClick={requestRepair}>
            Ask the assistant to fix this
          </Button>
        </p>
      )}
      {sourceOpen ? (
        <div className="mousse-applet-source scrollbar-ultra-thin">
          {bundle ? (
            <>
              <h4>HTML</h4>
              <pre>{bundle.source.html}</pre>
              <h4>CSS</h4>
              <pre>{bundle.source.css}</pre>
              <h4>JavaScript</h4>
              <pre>{bundle.source.js}</pre>
              <h4>Data</h4>
              <pre>{JSON.stringify(bundle.source.data ?? {}, null, 2)}</pre>
            </>
          ) : (
            'Loading source…'
          )}
        </div>
      ) : (
        <div
          ref={preview}
          className="mousse-applet-preview"
          style={{ height: expanded ? 620 : height }}
          aria-label="Applet preview"
        >
          {scrollImage && (
            <img
              className="mousse-applet-scroll-frame"
              src={scrollImage}
              alt=""
              aria-hidden="true"
            />
          )}
          {!ready && (
            <span>
              {error
                ? 'Preview stopped. Use Restart to try again.'
                : 'Interactive preview loads when visible.'}
            </span>
          )}
        </div>
      )}
      {conversationInput && (
        <aside className="mousse-applet-conversation-input scrollbar-ultra-thin">
          <p>{conversationInput}</p>
          <Button size="sm" type="button" onClick={addConversationInput}>
            Add to conversation draft
          </Button>
          <Button size="sm" type="button" onClick={() => setConversationInput(null)}>
            Dismiss
          </Button>
        </aside>
      )}
      <footer>Offline applet · interactions stay on this device</footer>
    </section>
  )
})
