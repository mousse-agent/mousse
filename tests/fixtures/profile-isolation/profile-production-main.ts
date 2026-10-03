import { app, BrowserWindow, session } from 'electron'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { MousseMainService } from '../../../src/mms/MousseMainService'
import { MmsProtocolServer } from '../../../src/mms/protocol/server'
import { GuiMmsController } from '../../../src/main/mms/GuiMmsController'
import { registerGuiIpc } from '../../../src/main/ipc/registerGuiIpc'
import { PresentationState } from '../../../src/main/mms/PresentationState'
import { MousseConfigStore } from '../../../src/mms/config/MousseConfigStore'
import { SettingsStore } from '../../../src/mms/settings/SettingsStore'
import { FileService } from '../../../src/mms/files/FileService'
import { GitService } from '../../../src/mms/git/GitService'
import { LineEditStatsStore } from '../../../src/mms/stats/LineEditStatsStore'
import { BrowserViewManager } from '../../../src/main/browser/BrowserViewManager'
import { profileBrowserPartition } from '../../../src/main/browser/browserPolicy'
import { defaultAgentSettings } from '../../../src/shared/agents/defaults'

const output = resolve(process.env.MOUSSE_PROFILE_PRODUCTION_EVIDENCE ?? '.mousse-dev/profile-production-evidence')
const runtimeRoot = join(output, 'runtime')
const home = join(runtimeRoot, 'home')
const preload = resolve(process.env.MOUSSE_PROFILE_PRODUCTION_PRELOAD ?? '')
app.setPath('userData', join(runtimeRoot, 'electron-user-data'))
setTimeout(() => { console.error('Production profile fixture timed out'); app.exit(1) }, 90_000).unref()

const delay = (ms: number): Promise<void> => new Promise((resolveDelay) => setTimeout(resolveDelay, ms))
const execute = <T>(win: BrowserWindow, source: string): Promise<T> => win.webContents.executeJavaScript(source) as Promise<T>
async function waitFor<T>(read: () => Promise<T>, accept: (value: T) => boolean, label: string): Promise<T> {
  for (let index = 0; index < 60; index += 1) {
    const value = await read()
    if (accept(value)) return value
    await delay(100)
  }
  throw new Error(`Timed out: ${label}`)
}

async function main(): Promise<void> {
  await rm(runtimeRoot, { recursive: true, force: true })
  await mkdir(home, { recursive: true })
  process.env.MOUSSE_HOME = home
  await app.whenReady()

  const mms = await MousseMainService.create({ homeDir: home, repoRoot: runtimeRoot, headless: true, ownerKind: 'daemon' })
  await mms.start()
  const owner = mms.getOwnerLease()!.owner
  const server = new MmsProtocolServer({ mms, ownerToken: owner.token, version: 'profile-production-fixture' })
  const endpoint = await server.start()
  mms.getOwnerLease()!.setEndpoint(endpoint)
  const gui = new GuiMmsController({
    homeDir: home,
    disableAutoStart: true,
    endpointOverride: endpoint,
    ownerTokenOverride: owner.token,
    requestTimeoutMs: 10_000
  })
  await gui.start()

  const host = mms.getInstallationHost()!
  const defaultId = host.getDefaultProfileId()
  const bob = host.manager.create({ displayName: 'Bob', slug: 'bob' })
  const bobServices = await mms.getProfileServices(bob.id)
  await bobServices.start()

  let activeWindow: BrowserWindow | null = null
  const browserView = new BrowserViewManager()
  browserView.init(() => activeWindow, () => {})
  const chromeSettings = new SettingsStore(MousseConfigStore.load(home, { persist: false }))
  const presentation = new PresentationState()
  presentation.setActiveThreadId('same-thread')
  registerGuiIpc({
    guiMms: gui,
    presentation,
    settings: chromeSettings,
    fileService: new FileService(),
    gitService: new GitService(),
    lineEditStats: new LineEditStatsStore(home),
    browserView,
    repoRoot: runtimeRoot
  }, () => activeWindow)

  const makeWindow = (): BrowserWindow => new BrowserWindow({
    width: 640,
    height: 480,
    show: false,
    webPreferences: {
      offscreen: true,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      preload
    }
  })
  const alice = makeWindow()
  const bobWindow = makeWindow()
  const errors: string[] = []
  for (const win of [alice, bobWindow]) {
    win.webContents.on('console-message', (event) => {
      if (event.level === 'error') errors.push(event.message)
    })
    await win.loadURL('data:text/html,<meta charset=utf-8><title>profile production fixture</title>')
    await execute(win, `window.__profileEvents=[];
      window.mousse.orchestrator.onThreadMessage((value)=>window.__profileEvents.push(['message',value]));
      window.mousse.orchestrator.onQuestionsPending((value)=>window.__profileEvents.push(['question',value]));
      window.mousse.pty.onData((value)=>window.__profileEvents.push(['pty',value]));
      window.mousse.turn.onTurnState((value)=>window.__profileEvents.push(['turn',value]));
      window.mousse.control.onStatusChanged((value)=>window.__profileEvents.push(['control',value])); true`)
  }

  const checks: string[] = []
  const pass = (name: string): void => { checks.push(name); console.log(`PASS ${name}`) }

  activeWindow = alice
  const unboundBrowserRejected = await execute<boolean>(alice, 'window.mousse.browser.getState().then(()=>false,()=>true)')
  if (!unboundBrowserRejected) throw new Error('Unbound renderer accessed browser storage')
  pass('unbound browser storage rejected')

  const aliceBind = await execute<{ profile: { id: string }; epoch: number; home?: string }>(alice, `window.mousse.profiles.bind(${JSON.stringify(defaultId)})`)
  activeWindow = bobWindow
  const bobBind = await execute<{ profile: { id: string }; epoch: number; home?: string }>(bobWindow, `window.mousse.profiles.bind(${JSON.stringify(bob.id)})`)
  if (aliceBind.profile.id !== defaultId || bobBind.profile.id !== bob.id || 'home' in aliceBind || 'home' in bobBind) {
    throw new Error('Trusted binding result was incorrect or exposed a profile path')
  }
  pass('two production preload windows bound without path disclosure')
  activeWindow = alice
  const aliceThread = await execute<{ id: string }>(alice, `window.mousse.threads.createAndSelect('Alice fixture')`)
  activeWindow = bobWindow
  const bobThread = await execute<{ id: string }>(bobWindow, `window.mousse.threads.createAndSelect('Bob fixture')`)

  // Exercise startup through the real Electron preload/IPC after subscription.
  // Concurrent effects must restore once and keep each window's existing choice.
  const originalSnapshot = gui.snapshotThread.bind(gui)
  let startupSnapshots = 0
  gui.snapshotThread = async (threadId) => {
    startupSnapshots += 1
    return originalSnapshot(threadId)
  }
  const initialize = (win: BrowserWindow): Promise<boolean> => execute(win, `
    window.__startupEvents=[];
    const selected=window.mousse.threads.onSelected(({id})=>window.__startupEvents.push(['selected',id]));
    const view=window.mousse.threads.onView(({threadId})=>window.__startupEvents.push(['view',threadId]));
    window.__stopStartup=()=>{selected();view()};
    Promise.all([window.mousse.threads.initialize(),window.mousse.threads.initialize()])
      .then(()=>true)`)
  await Promise.all([initialize(alice), initialize(bobWindow)])
  // IPC replies and event callbacks can arrive in different renderer tasks.
  const [aliceStartup, bobStartup] = await Promise.all([
    waitFor(() => execute<Array<[string, string]>>(alice, 'window.__startupEvents'), (events) => events.length >= 2, 'Alice startup view'),
    waitFor(() => execute<Array<[string, string]>>(bobWindow, 'window.__startupEvents'), (events) => events.length >= 2, 'Bob startup view')
  ])
  await Promise.all([execute(alice, 'window.__stopStartup();true'), execute(bobWindow, 'window.__stopStartup();true')])
  gui.snapshotThread = originalSnapshot
  if (startupSnapshots !== 2 || JSON.stringify(aliceStartup) !== JSON.stringify([['selected', aliceThread.id], ['view', aliceThread.id]]) || JSON.stringify(bobStartup) !== JSON.stringify([['selected', bobThread.id], ['view', bobThread.id]])) {
    throw new Error(`Startup hydration duplicated, raced selection, or crossed windows: ${startupSnapshots} / ${JSON.stringify(aliceStartup)} / ${JSON.stringify(bobStartup)}`)
  }
  pass('subscribed startup restores once per bound window with selection before view')

  const forged = await execute<{ code?: string }>(alice, `window.mousse.platformRequest.request('agentDefinitions.list',{profileId:${JSON.stringify(bob.id)}}).then(()=>({}),error=>error)`)
  if (forged.code !== 'profile_mismatch') throw new Error(`Forged profile was not rejected: ${JSON.stringify(forged)}`)
  pass('forged renderer profile rejected')

  const settings = defaultAgentSettings({ name: 'Fixture', slug: 'fixture', purpose: 'Fixture' })
  const createInput = { profileId: defaultId, settings, systemPrompt: '# Fixture\nProfile fixture.' }
  const created = await execute<{ id: string; draftHash: string }>(alice, `window.mousse.platformRequest.request('agentDefinitions.create',${JSON.stringify(createInput)})`)
  await execute(alice, `window.mousse.platformRequest.request('agentDefinitions.saveDraft',{profileId:${JSON.stringify(defaultId)},id:${JSON.stringify(created.id)},expectedDraftHash:${JSON.stringify(created.draftHash)},systemPrompt:'new draft'})`)
  const stale = await execute<{ code?: string; details?: unknown }>(alice, `window.mousse.platformRequest.request('agentDefinitions.saveDraft',{profileId:${JSON.stringify(defaultId)},id:${JSON.stringify(created.id)},expectedDraftHash:${JSON.stringify(created.draftHash)},systemPrompt:'stale draft'}).then(()=>({}),error=>error)`)
  if (stale.code !== 'REVISION_CONFLICT' || !stale.details) throw new Error(`Structured revision conflict lost: ${JSON.stringify(stale)}`)
  pass('production platform preload preserves revision conflict details')

  activeWindow = alice
  await execute(alice, `window.mousse.settings.set({appearance:{theme:'light'}})`)
  activeWindow = bobWindow
  await execute(bobWindow, `window.mousse.settings.set({appearance:{theme:'dark'}})`)
  const [aliceSettings, bobSettings] = await Promise.all([
    execute<{ appearance: { theme: string } }>(alice, 'window.mousse.settings.get()'),
    execute<{ appearance: { theme: string } }>(bobWindow, 'window.mousse.settings.get()')
  ])
  if (aliceSettings.appearance.theme !== 'light' || bobSettings.appearance.theme !== 'dark') throw new Error('Profile settings crossed windows')
  pass('profile settings remain isolated')

  await Promise.all([
    execute(alice, 'window.__profileEvents=[]; true'),
    execute(bobWindow, 'window.__profileEvents=[]; true')
  ])
  mms.orchestrator.emit('thread-message', { threadId: aliceThread.id, message: { id: 'a', role: 'assistant', content: 'alice-private' } })
  bobServices.orchestrator.emit('thread-message', { threadId: bobThread.id, message: { id: 'b', role: 'assistant', content: 'bob-private' } })
  mms.questions.emit('pending', { requestId: 'alice-question', threadId: aliceThread.id, questions: [{ prompt: 'alice?' }] })
  bobServices.questions.emit('pending', { requestId: 'bob-question', threadId: bobThread.id, questions: [{ prompt: 'bob?' }] })
  mms.ptyManager.emit('data', { ptyId: 'alice-pty', data: 'alice-pty-private', sequence: 1, threadId: aliceThread.id, agentId: 'a' })
  bobServices.ptyManager.emit('data', { ptyId: 'bob-pty', data: 'bob-pty-private', sequence: 1, threadId: bobThread.id, agentId: 'b' })
  mms.orchestrator.emit('turn-state', { threadId: aliceThread.id, turnId: 'alice-turn', phase: 'thinking', updatedAt: new Date().toISOString() })
  bobServices.orchestrator.emit('turn-state', { threadId: bobThread.id, turnId: 'bob-turn', phase: 'thinking', updatedAt: new Date().toISOString() })
  mms.events.emit({ channel: 'control:status-changed', data: { marker: 'alice-control' } })
  bobServices.events.emit({ channel: 'control:status-changed', data: { marker: 'bob-control' } })
  const aliceEvents = await waitFor(() => execute<unknown[]>(alice, 'window.__profileEvents'), (events) => events.length >= 5, 'Alice events')
  const bobEvents = await waitFor(() => execute<unknown[]>(bobWindow, 'window.__profileEvents'), (events) => events.length >= 5, 'Bob events')
  const aliceText = JSON.stringify(aliceEvents)
  const bobText = JSON.stringify(bobEvents)
  if (!aliceText.includes('alice-private') || aliceText.includes('bob-private') || !aliceText.includes('alice-control') || aliceText.includes('bob-control') || !bobText.includes('bob-private') || bobText.includes('alice-private') || !bobText.includes('bob-control') || bobText.includes('alice-control')) {
    throw new Error(`Private events crossed windows: ${aliceText} / ${bobText}`)
  }
  const [aliceTurns, bobTurns] = await Promise.all([
    execute<Record<string, unknown>>(alice, 'window.mousse.turn.getSnapshot()'),
    execute<Record<string, unknown>>(bobWindow, 'window.mousse.turn.getSnapshot()')
  ])
  if (!(aliceThread.id in aliceTurns) || bobThread.id in aliceTurns || !(bobThread.id in bobTurns) || aliceThread.id in bobTurns) {
    throw new Error('Turn snapshots crossed profile windows')
  }
  pass('transcript questions PTY control turn events and snapshots stay bound')

  const partitionA = session.fromPartition(profileBrowserPartition(defaultId))
  const partitionB = session.fromPartition(profileBrowserPartition(bob.id))
  await partitionA.cookies.set({ url: 'https://profile-fixture.invalid', name: 'private', value: 'alice' })
  await partitionB.cookies.set({ url: 'https://profile-fixture.invalid', name: 'private', value: 'bob' })
  const [cookieA, cookieB] = await Promise.all([
    partitionA.cookies.get({ url: 'https://profile-fixture.invalid', name: 'private' }),
    partitionB.cookies.get({ url: 'https://profile-fixture.invalid', name: 'private' })
  ])
  if (cookieA[0]?.value !== 'alice' || cookieB[0]?.value !== 'bob') throw new Error('Browser partition cookies crossed')
  activeWindow = alice
  await execute(alice, 'window.mousse.browser.clearCookies()')
  const [clearedA, retainedB] = await Promise.all([
    partitionA.cookies.get({ url: 'https://profile-fixture.invalid', name: 'private' }),
    partitionB.cookies.get({ url: 'https://profile-fixture.invalid', name: 'private' })
  ])
  if (clearedA.length !== 0 || retainedB[0]?.value !== 'bob') throw new Error('Browser clear crossed its trusted profile partition')
  pass('production browser IPC and partitions isolate cookies')

  await writeFile(join(output, 'result.json'), JSON.stringify({ passed: true, checks, errors, profiles: [defaultId, bob.id] }, null, 2))
  browserView.destroy()
  alice.destroy()
  bobWindow.destroy()
  await gui.stop()
  await server.stop()
  await mms.stop()
  app.exit(errors.length ? 1 : 0)
}

main().catch(async (error) => {
  console.error(error)
  await mkdir(output, { recursive: true })
  await writeFile(join(output, 'result.json'), JSON.stringify({ passed: false, error: String(error) }, null, 2))
  app.exit(1)
})
