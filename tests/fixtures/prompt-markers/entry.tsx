import React, { useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { UIMessage } from 'ai'
import { PromptMarkersOverlay } from '../../../src/renderer/chat/components/agent-elements/message-list'
import '../../../src/renderer/styles/app.css'

let update!: (ids: string[], missing?: string) => void
let navigateCount = 0
function Fixture() {
  const [ids, setIds] = useState(['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'])
  const [missing, setMissing] = useState<string>()
  const containerRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const animationRef = useRef(0)
  update = (next, absent) => { setIds(next); setMissing(absent) }
  const messages: UIMessage[] = ids.map(id => ({ id, role: 'user', parts: [{ type: 'text', text: `Prompt ${id}` }] }))
  return <div className="an-message-list-wrap" style={{ position: 'relative', width: 420, height: 320 }}>
    <div ref={containerRef} id="viewport" style={{ width: 300, height: 150, overflowY: 'auto' }}>
      <div ref={contentRef}>
        {ids.map((id, index) => <div key={index} data-prompt-id={id === missing ? undefined : id} style={{ height: 40, marginBottom: 40 }}>{id === missing ? null : `Prompt ${id}`}</div>)}
      </div>
    </div>
    <PromptMarkersOverlay messages={messages} containerRef={containerRef} contentRef={contentRef}
      visible={true} onActive={() => {}} onUserNavigate={() => { navigateCount++ }}
      markProgrammatic={() => {}} scrollAnimRef={animationRef} />
  </div>
}
const root = createRoot(document.getElementById('root')!)
root.render(<Fixture />)
;(window as unknown as { qa: unknown }).qa = {
  update: (ids: string[], missing?: string) => update(ids, missing),
  navigateCount: () => navigateCount,
  unmount: () => root.unmount(),
  sample: () => Array.from(document.querySelectorAll<HTMLButtonElement>('.chat-prompt-tick')).map(button => ({
    id: button.dataset.promptMarkerId,
    visible: button.dataset.visible === 'true',
    width: parseFloat(getComputedStyle(button.firstElementChild!).width),
    opacity: parseFloat(getComputedStyle(button.firstElementChild!).opacity),
    height: button.getBoundingClientRect().height,
    transform: getComputedStyle(button.firstElementChild!).transform,
  })),
}
