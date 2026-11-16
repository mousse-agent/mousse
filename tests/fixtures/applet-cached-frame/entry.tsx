import { createRoot } from 'react-dom/client'
import { AppletCard } from '../../../src/renderer/components/applets/AppletCard'
import { useAppStore } from '../../../src/renderer/stores/appStore'

// A transcript with one applet card in it, above a composer, as the chat lays them out.
useAppStore.setState({ activeThreadId: 'thread', profileId: 'profile' })
const reference = { appletId: 'applet', revisionId: 'revision', sourceHash: 'hash', title: 'Cached frame', description: 'A block on a see-through page' }

function Transcript() {
  return (
    <div className="mousse-chat-shell" style={{ position: 'fixed', inset: 0 }}>
      <div className="an-message-list" style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 500, overflowY: 'auto' }}>
        <div style={{ padding: 20 }}>
          <AppletCard reference={reference} />
          <div style={{ height: 800 }} />
        </div>
      </div>
      <div className="chat-composer-stack" style={{ position: 'absolute', top: 500, left: 0, right: 0, bottom: 0 }} />
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<Transcript />)

const preview = () => document.querySelector<HTMLElement>('.mousse-applet-preview')
Object.assign(window, {
  qa: {
    /** The cached frame has arrived in the host page. */
    framed: () => !!document.querySelector('.mousse-applet-scroll-frame'),
    /** A point inside the applet's block, in window pixels. */
    blockPoint: () => {
      const box = preview()!.getBoundingClientRect()
      return { x: Math.round(box.left + 40), y: Math.round(box.top + 40) }
    },
    /** The transcript starts to scroll: the live view hides and the cached frame stands in. */
    scroll: () => document.querySelector('.an-message-list')!.dispatchEvent(new Event('scroll')),
    /** Resolves after the next two painted frames. */
    frames: () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))
  }
})
