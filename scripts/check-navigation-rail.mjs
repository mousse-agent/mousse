import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import electron from 'electron'
import { build } from 'esbuild'

// Exercise the real app layout and rail; substitute only the unrelated heavy panels.
const directory = await mkdtemp(join(tmpdir(), 'mousse-navigation-'))
try {
  const bundle = await build({
    stdin: {
      resolveDir: new URL('..', import.meta.url).pathname, loader: 'tsx', contents: `
        import { createRoot } from 'react-dom/client'
        import App from './src/renderer/App'
        import { useAppStore } from './src/renderer/stores/appStore'
        import { registerNavigationGuard } from './src/renderer/services/navigationGuards'
        window.fixture = { store: useAppStore, errors: [], project: '/fixture', registerNavigationGuard,
          profile: 'default', usageLoads: 0 }
        window.addEventListener('error', event => window.fixture.errors.push(event.message))
        window.addEventListener('unhandledrejection', event => window.fixture.errors.push(String(event.reason)))
        const subscription = () => () => {}
        const profiles = [
          { id: 'default', displayName: 'Default', isDefault: true, status: 'active', revision: 1 },
          { id: 'second', displayName: 'Second', isDefault: false, status: 'active', revision: 1 }
        ]
        window.mousse = {
          platform: 'linux',
          window: { closeAgentsTasks: async () => {}, openAgentsTasks: async () => {},
            isMaximized: async () => false, onMaximizedChange: subscription },
          providers: { getUsage: async () => { window.fixture.usageLoads++; return { providers: [
            { id: 'test', label: 'Test subscription', windows: [
              { id: 'daily', label: 'Daily', remainingPercent: 75, resetsAt: '2030-01-01T00:00:00Z' }
            ] }
          ] } } },
          profiles: { list: async () => ({ profiles, defaultProfileId: 'default' }),
            status: async () => ({ binding: { profileId: window.fixture.profile } }),
            bind: async id => { window.fixture.profile = id; return { profile: profiles.find(p => p.id === id) } },
            update: async (id, revision, patch) => {
              const index = profiles.findIndex(p => p.id === id)
              profiles[index] = { ...profiles[index], ...patch, revision: revision + 1 }
              return { profile: profiles[index] }
            } },
          app: { getInfo: async () => ({ platform: window.mousse.platform }),
            getActiveProjectPath: async () => window.fixture.project, onNavigateMainView: subscription },
          workspace: { getStatus: async () => ({}) },
          orchestrator: { getMessages: async () => [], onThreadMessage: subscription,
            onThreadMessageUpdated: subscription, onThreadMessages: subscription },
          agents: { list: async () => [], onUpdated: subscription, onActivated: subscription },
          tasks: { list: async () => [], onUpdated: subscription },
          projects: { list: async () => [], onUpdated: subscription },
          threads: { listAll: async () => [], active: async () => null, getActivity: async () => ({}),
            onUpdated: subscription, onSelected: subscription, onActivity: subscription, onView: subscription,
            select: async id => { window.fixture.selected = id } },
          turn: { getSnapshot: async () => ({}), onTurnState: subscription, onTurnSnapshot: subscription },
          channels: { onActivity: subscription }, documents: { onOpened: subscription }
        }
        useAppStore.setState({ mainAreaOpen: false, threadsSidebarOpen: true, threadsSidebarWidth: 240 })
        createRoot(document.getElementById('root')).render(<App />)
      `
    },
    bundle: true, platform: 'browser', format: 'iife', write: false,
    outfile: join(directory, 'fixture.js'), jsx: 'automatic',
    loader: { '.svg': 'dataurl', '.webp': 'dataurl' },
    define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [{ name: 'unrelated-panels', setup(builder) {
      builder.onResolve({ filter: /\/components\/(OrchestratorChat|MainViewPanel|MainViewTabs|QuickActionsButton)$/ }, args => ({
        path: args.path.split('/').at(-1), namespace: 'fixture-panel'
      }))
      builder.onLoad({ filter: /.*/, namespace: 'fixture-panel' }, args => ({ resolveDir: new URL('..', import.meta.url).pathname, loader: 'tsx', contents:
        `export function ${args.path}() { return <div className="${args.path === 'TitleBar' ? 'titlebar' : ''}">${args.path === 'TitleBar' ? 'Mousse' : args.path === 'OrchestratorChat' ? 'Chat' : args.path === 'MainViewPanel' ? 'App panel' : ''}</div> }`
      }))
    } }]
  })
  for (const file of bundle.outputFiles) await writeFile(file.path, file.contents)
  // Hidden Chromium windows can suspend CSS animations; check settled layout without motion.
  const globalCss = await readFile(new URL('../src/renderer/styles/global.css', import.meta.url), 'utf8').catch(() => '')
  await writeFile(join(directory, 'fixture.html'), `<html><head><link rel="stylesheet" href="fixture.css"><style>
    ${globalCss}
    :root{--surface-base-rgb:12,12,14;--surface-strong-rgb:24,24,27;--surface-soft-rgb:24,24,27;
      --surface-elevated-rgb:30,30,33;--accent-rgb:170,140,200;--accent-pale-rgb:200,180,220;
      --accent:#b7a1d0;--text-primary:#f0f0f2;--text-secondary:#a4a1a8;--border:#303034;
      --bg-secondary:#18181b;--app-window-bg:#0c0c0e;--titlebar-height:48px;--gradient-surface:#121214}
    body{margin:0;color:var(--text-primary);font:14px sans-serif}*{box-sizing:border-box;animation:none!important}
    button{border:0;background:none;color:inherit;cursor:pointer;font:inherit}
    .header{min-height:42px}
  </style></head><body><div id="root"></div><script src="fixture.js"></script></body></html>`)
  await writeFile(join(directory, 'check.cjs'), String.raw`
    const assert = require('node:assert/strict')
    const { writeFileSync } = require('node:fs')
    const { app, BrowserWindow } = require('electron')
    const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
    app.whenReady().then(async () => {
      const window = new BrowserWindow({ width: 1100, height: 800, show: false,
        webPreferences: { backgroundThrottling: false } })
      const evaluate = async code => {
        try { return await window.webContents.executeJavaScript(code) }
        catch (error) { console.error("Renderer evaluation:", code); throw error }
      }
      const click = async selector => {
        assert(await evaluate('!!document.querySelector(' + JSON.stringify(selector) + ')'), selector)
        await evaluate('document.querySelector(' + JSON.stringify(selector) + ').click()')
        await pause(60)
      }
      const railClick = label => click('.navigation-rail [aria-label="' + label + '"]')
      const state = () => evaluate('({mainView: fixture.store.getState().mainView, mainAreaOpen: fixture.store.getState().mainAreaOpen})')
      const rect = selector => evaluate('(() => { const r=document.querySelector(' + JSON.stringify(selector) + ').getBoundingClientRect(); return {left:r.left,right:r.right,width:r.width,top:r.top} })()')
      try {
        await window.loadFile(__dirname + '/fixture.html')
        await pause(300)
        for (const platform of ['linux', 'win32', 'darwin']) {
          await evaluate('window.mousse.platform=' + JSON.stringify(platform) + '; fixture.store.setState({appInfo:{platform:window.mousse.platform}})')
          await railClick('Home')
          assert.equal((await rect('.navigation-rail')).width, 72)
          assert.equal((await rect('.threads-sidebar')).left, 72)
          assert.equal(await evaluate('document.querySelector(".navigation-rail [aria-label=Home]").getAttribute("aria-current")'), 'page')
          assert.equal(await evaluate('!!document.querySelector(".navigation-rail [aria-label=Browser]")'), false)
          assert.equal(await evaluate('!!document.querySelector(".navigation-rail [aria-label=Automations] .lucide-workflow")'), true)
          assert.equal(await evaluate('!!document.querySelector(".navigation-rail [aria-label=Channels] .lucide-radio")'), true)
          assert.deepEqual(await evaluate('Array.from(document.querySelectorAll(".navigation-rail button")).map(b=>b.getAttribute("aria-label"))'),
            ['Home', 'Automations', 'Channels', 'More', 'Subscription usage', 'Profiles', 'Settings'])
          assert.equal(await evaluate('!!document.querySelector(".titlebar [aria-label=Profiles], .titlebar [aria-label=Settings], .titlebar .titlebar-usage-btn")'), false)
          const loads = await evaluate('fixture.usageLoads')
          await railClick('Subscription usage')
          assert.equal(await evaluate('fixture.usageLoads'), loads + 1)
          assert.equal(await evaluate('document.querySelector(".usage-bar").getAttribute("aria-valuenow")'), '75')
          await click('.usage-heading button')
          assert.equal(await evaluate('fixture.usageLoads'), loads + 2)
          window.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'})
          window.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'})
          await pause(50)
          assert.equal(await evaluate('!!document.querySelector(".usage-dialog")'), false)
          await railClick('Profiles')
          const menu = await rect('.profile-menu')
          assert(menu.left >= (await rect('.navigation-rail [aria-label=Profiles]')).right)
          assert(menu.top >= 0 && menu.width > 200)
          assert.equal(await evaluate('document.querySelector(".profile-menu").parentElement === document.body'), true)
          await click('.profile-menu button:first-of-type')
          assert.equal(await evaluate('!!document.querySelector(".profile-menu input")'), true)
          await click('.profile-inline-form button')
          assert.equal(await evaluate('!!document.querySelector(".profile-menu input")'), false)
          window.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'})
          window.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'})
          await pause(50)
          assert.equal(await evaluate('document.activeElement.getAttribute("aria-label")'), 'Profiles')
          await railClick('Settings')
          assert.equal(await evaluate('fixture.store.getState().settingsOpen'), true)
          await evaluate('fixture.store.setState({settingsOpen:false})')
          await railClick('Automations')
          assert.equal(await evaluate('fixture.store.getState().scheduledOpen'), true)
          await evaluate('fixture.store.setState({scheduledOpen:false})')
          await railClick('Channels')
          assert.equal(await evaluate('fixture.store.getState().channelsOpen'), true)
          await evaluate('fixture.store.setState({channelsOpen:false,threadsSidebarOpen:false})')
          await pause(240)
          assert.equal(await evaluate('!!document.querySelector(".threads-sidebar-pane")'), false)
          assert.equal((await rect('.navigation-rail')).width, 72)
          assert.equal((await rect('.threads-sidebar-edge-trigger')).left, 72)
          await evaluate('document.querySelector(".threads-sidebar-edge-trigger").dispatchEvent(new MouseEvent("mouseover",{bubbles:true}))')
          await pause(240)
          assert.equal((await rect('.threads-sidebar-peek')).left, 72)
          await railClick('More')
          assert.equal(await evaluate('document.activeElement.textContent'), 'Search threads')
          window.webContents.sendInputEvent({type:'keyDown',keyCode:'Down'})
          window.webContents.sendInputEvent({type:'keyUp',keyCode:'Down'})
          await pause(50)
          assert.equal(await evaluate('document.activeElement.textContent'), 'Files')
          window.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'})
          window.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'})
          await pause(50)
          assert.equal(await evaluate('document.activeElement.getAttribute("aria-label")'), 'More')
          await railClick('More')
          await click('.navigation-rail-menu button:first-child')
          assert.equal(await evaluate('!!document.querySelector(".thread-search-dialog")'), true)
          await click('.thread-search-close')
          await railClick('More')
          await click('.navigation-rail-menu button:last-child')
          assert.deepEqual(await state(), { mainView: 'terminal', mainAreaOpen: true })
          await railClick('Home')
          await pause(240)
          const divider = await rect('.resizer-threads')
          window.webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(divider.left), y: 150, button: 'left', clickCount: 1 })
          window.webContents.sendInputEvent({ type: 'mouseMove', x: 390, y: 150 })
          window.webContents.sendInputEvent({ type: 'mouseUp', x: 390, y: 150, button: 'left', clickCount: 1 })
          await pause(70)
          assert.equal(await evaluate('fixture.store.getState().threadsSidebarWidth'), 318)
          assert.equal((await rect('.resizer-threads')).left, 390)
        }
        await evaluate('fixture.stopGuard=fixture.registerNavigationGuard(()=>false); true')
        await railClick('More')
        await click('.navigation-rail-menu button:nth-child(2)')
        assert.equal((await state()).mainView, 'terminal')
        assert.equal((await state()).mainAreaOpen, false)
        await railClick('More')
        await evaluate('fixture.stopGuard(); fixture.project=null; fixture.store.setState({activeThreadId:"no-project"})')
        await pause(70)
        await railClick('More')
        assert.equal(await evaluate('document.querySelector(".navigation-rail-menu button:nth-child(2)").disabled'), true)
        await evaluate('document.body.dispatchEvent(new PointerEvent("pointerdown",{bubbles:true}))')
        await railClick('Profiles')
        await evaluate('document.body.dispatchEvent(new MouseEvent("mousedown",{bubbles:true}))')
        await pause(50)
        assert.equal(await evaluate('!!document.querySelector(".profile-menu")'), false)
        await railClick('Profiles')
        await click('.profile-menu-profile')
        assert.equal(await evaluate('fixture.store.getState().profileId'), 'second')
        assert.equal(await evaluate('fixture.profile'), 'second')
        assert.deepEqual(await evaluate('fixture.errors'), [])
        await railClick('Home')
        writeFileSync('/tmp/mousse-navigation-rail.png', (await window.webContents.capturePage()).toPNG())
        console.log('Navigation rail passed: rail order, titlebar removal, usage dialog/refresh, profile popup/edit/switch, settings, menu keyboard/dismissal, navigation guard, collapsed peek and divider alignment (three platform settings).')
        window.destroy(); app.quit()
      } catch (error) { console.error(error); app.exit(1) }
    })
  `)
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const code = await new Promise((resolve, reject) => {
    const child = spawn(electron, [join(directory, 'check.cjs')], { env, stdio: 'inherit' })
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Navigation rail check timed out')) }, 30_000)
    child.once('error', error => { clearTimeout(timeout); reject(error) })
    child.once('exit', code => { clearTimeout(timeout); resolve(code) })
  })
  assert.equal(code, 0, 'Navigation rail Chromium check failed')
} finally {
  await rm(directory, { recursive: true, force: true })
}
