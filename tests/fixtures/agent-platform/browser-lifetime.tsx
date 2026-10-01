import { createRoot } from 'react-dom/client'
import { MainViewPanel } from '../../../src/renderer/components/MainViewPanel'
import { KeepMounted } from '../../../src/renderer/components/KeepMounted'
import { useAppStore } from '../../../src/renderer/stores/appStore'
import '../../../src/renderer/styles/global.css'
import '../../../src/renderer/styles/app.css'

const style = document.createElement('style')
style.textContent = `html,body,#root{height:100%;margin:0}.fixture-shell{height:100%;display:flex;position:relative;background:#131622;color:#eee}.fixture-sidebar{width:160px;flex:none;padding:20px}.fixture-sidebar.full{flex:1}.main-area{background:#202534}`
document.head.appendChild(style)
const store = useAppStore
store.setState({ profileId: 'fixture-a', activeThreadId: 'thread-a', mainView: 'browser', mainAreaOpen: true, browserTabs: [], browserActiveTabByThread: {} })
const page = new URL('./browser-lifetime-page.html', location.href).href
const add = (thread: string, id?: string) => {
  const created = store.getState().addBrowserTab(thread)
  store.getState().updateBrowserTab(created, { ...(id ? { id } : {}), url: page })
  if (id) store.getState().setActiveBrowserTab(thread, id)
  return id ?? created
}
const first = add('thread-a')
const second = add('thread-b')
Object.assign(window, { lifetimeFixture: {
  first, second,
  view: (view: 'browser' | 'files') => store.getState().setMainView(view),
  collapse: (collapsed: boolean) => store.getState().setMainAreaOpen(!collapsed),
  thread: (id: string) => store.setState({ activeThreadId: id }),
  profile: () => { store.getState().activateProfile('fixture-b'); store.setState({ activeThreadId: 'thread-a', mainView: 'browser' }); add('thread-a', first) },
  close: (id: string) => store.getState().closeBrowserTab(id),
  attachments: () => store.getState().browserElementAttachmentsByThread
} })

function Fixture() {
  const open = store((state) => state.mainAreaOpen)
  return <div className="fixture-shell"><aside className={`fixture-sidebar${open ? '' : ' full'}`}><button id="outside">Outside browser</button></aside>
    <KeepMounted as="main" active={open} preserveLayout className="main-area"><MainViewPanel /></KeepMounted>
  </div>
}
createRoot(document.getElementById('root')!).render(<Fixture />)
