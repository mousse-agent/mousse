import { app, BrowserWindow, type WebContents } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { AttachedBrowserHost } from '../../../../src/main/browser/AttachedBrowserHost'
import { GuiMmsController } from '../../../../src/main/mms/GuiMmsController'
import { profileBrowserPartition } from '../../../../src/main/browser/browserPolicy'
import type { WorkflowRunView } from '../../../../src/shared/workflowRunPlatform'

const config = JSON.parse(readFileSync(process.env.MOUSSE_E2E_CONFIG!, 'utf8')) as {
  home: string; endpoint: string; ownerToken: string; profileId: string; threadId: string;
  pageUrl: string; workflowUrl: string; workflowDefinitionId: string; workflowRevisionId: string;
  userData: string; evidence: string
}
app.setPath('userData', config.userData)
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-gpu')
app.commandLine.appendSwitch('in-process-gpu')
const timeout = setTimeout(() => app.exit(2), 90_000)
timeout.unref()

async function run(): Promise<void> {
  await app.whenReady()
  const gui = new GuiMmsController({ homeDir: config.home, endpointOverride: config.endpoint,
    ownerTokenOverride: config.ownerToken, disableAutoStart: true, requestTimeoutMs: 45_000 })
  gui.on('error', () => {})
  const host = new AttachedBrowserHost({
    binding: (senderId) => gui.getWindowBindingForSender(senderId),
    request: (sender, method, params) => gui.requestAttachedBrowser(sender, method, params)
  })
  gui.setAttachedBrowserHost(host)
  const window = new BrowserWindow({ show: false, width: 1000, height: 750,
    webPreferences: { webviewTag: true, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  let guest: WebContents | undefined
  const ready = new Promise<WebContents>((resolve) => {
    window.webContents.on('did-attach-webview', (_event, attached) => {
      host.observeGuest(window.webContents, attached)
      guest = attached
      attached.once('did-finish-load', () => resolve(attached))
    })
  })
  try {
    await gui.start()
    const prepared = await gui.prepareWindow(window.webContents)
    if (prepared.profileId !== config.profileId) throw new Error('Prepared window bound the wrong profile')
    const partition = profileBrowserPartition(config.profileId)
    await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html><title>Mousse browser pipeline</title><webview style="position:absolute;inset:0;width:100%;height:100%" partition="${partition}" src="${config.pageUrl}" webpreferences="contextIsolation=yes,nodeIntegration=no,sandbox=yes"></webview>`))
    guest = await ready
    const guestId = guest.id
    await guest.executeJavaScript("document.cookie='existing=preserved; path=/'; document.querySelector('#name').value='before agent'")
    await host.registerTab(window.webContents, { localTabId: 'fixture-tab', webContentsId: guest.id, threadId: config.threadId })
    await host.selectTab(window.webContents, 'fixture-tab', config.threadId)
    // Registration selects a tab; user consent remains an explicit, separate RPC.
    await gui.runWithSender(window.webContents, () => gui.request('browser.access.set', { allowed: true }))
    const handoffResponse = await gui.runWithSender(window.webContents, () => gui.request<{ message: string }>('orchestrator.send', {
      threadId: config.threadId, content: 'Use the selected browser tab, then request human review before completing the form.', mode: 'build'
    }))
    const beforeTakeover = await guest.executeJavaScript("document.querySelector('#name').value")
    if (beforeTakeover !== 'before agent') throw new Error('Agent completed the form before human handoff: ' + beforeTakeover + '; ' + handoffResponse.message)
    const snapshot = await gui.runWithSender(window.webContents, () => gui.request<{ session: { id: string; humanHandoff?: { state: string; reason: string } }; controlOwner: string }>('browser.sessions.get', { threadId: config.threadId }))
    if (snapshot.controlOwner !== 'human' || snapshot.session.humanHandoff?.state !== 'waiting-human' || snapshot.session.humanHandoff.reason !== 'Please complete the form after resuming the agent.') throw new Error('Agent human handoff was not visible in the browser viewer')
    await host.control(window.webContents, 'fixture-tab', 'takeControl')
    await guest.executeJavaScript("document.querySelector('#name').value='human takeover'")
    await host.control(window.webContents, 'fixture-tab', 'resume')
    const resumed = await gui.runWithSender(window.webContents, () => gui.request<{ session: { humanHandoff?: { state: string } }; observation?: { elements: unknown[] } }>('browser.sessions.get', { threadId: config.threadId, sessionId: snapshot.session.id }))
    if (resumed.session.humanHandoff?.state !== 'resumed' || !resumed.observation?.elements.length) throw new Error('Human resume or latest observation did not survive a separate viewer request')
    const response = await gui.runWithSender(window.webContents, () => gui.request<{ message: string }>('orchestrator.send', {
      threadId: config.threadId, content: 'Human review is complete. Re-observe the selected tab, complete the Name field, and submit the form.', mode: 'build'
    }))
    const value = await guest.executeJavaScript("document.querySelector('#result')?.textContent")
    const cookie = await guest.executeJavaScript('document.cookie')
    if (value !== 'Submitted Mousse pipeline') {
      const inputState = await guest.executeJavaScript('({visibility:document.visibilityState,focused:document.hasFocus(),active:document.activeElement?.id,value:document.querySelector("#name")?.value,selectionStart:document.querySelector("#name")?.selectionStart,selectionEnd:document.querySelector("#name")?.selectionEnd})')
      throw new Error('Native post-resume form submission was not observed: ' + value + '; ' + response.message + '; input state=' + JSON.stringify(inputState))
    }
    if (guest.id !== guestId || !cookie.includes('existing=preserved')) throw new Error('Browser identity or cookies were replaced')
    await host.releaseWindow(window.webContents)
    if (guest.isDestroyed()) throw new Error('Releasing automation destroyed the human tab')
    await host.registerTab(window.webContents, { localTabId: 'fixture-tab', webContentsId: guest.id, threadId: config.threadId })
    await host.selectTab(window.webContents, 'fixture-tab', config.threadId)
    const started = await gui.runWithSender(window.webContents, () => gui.request<WorkflowRunView>('workflowRuns.start', {
      profileId: config.profileId, threadId: config.threadId, requestId: crypto.randomUUID(),
      definitionId: config.workflowDefinitionId, revisionId: config.workflowRevisionId, input: {}
    }))
    let workflow = started
    let approvals = 0
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline && workflow.state !== 'succeeded') {
      if (workflow.state === 'failed' || workflow.state === 'unknown-effect' || workflow.state === 'cancelled') {
        throw new Error(`Workflow browser run stopped as ${workflow.state}: ${workflow.error ?? ''}`)
      }
      if (workflow.pendingApproval) {
        const pending = workflow.pendingApproval
        approvals += 1
        workflow = await gui.runWithSender(window.webContents, () => gui.request<WorkflowRunView>('workflowRuns.approve', {
          profileId: config.profileId, runId: workflow.runId, approvalId: pending.approvalId,
          nodeId: pending.nodeId, instanceKey: pending.instanceKey, attempt: pending.attempt, approved: true
        }))
      } else {
        await new Promise((resolve) => setTimeout(resolve, 20))
        workflow = await gui.runWithSender(window.webContents, () => gui.request<WorkflowRunView>('workflowRuns.get', {
          profileId: config.profileId, runId: workflow.runId
        }))
      }
    }
    if (workflow.state !== 'succeeded') throw new Error(`Workflow browser run timed out as ${workflow.state}`)
    const workflowGuestUrl = guest.getURL()
    const workflowCookie = await guest.executeJavaScript('document.cookie')
    const actionAttempt = workflow.attempts.find((attempt) => attempt.nodeId === 'navigate')
    const actionOutcome = (workflow.result as { action?: { outcome?: string } } | undefined)?.action?.outcome
    if (workflowGuestUrl !== config.workflowUrl || actionOutcome !== 'verified') {
      throw new Error(`Workflow did not verify navigation: ${workflowGuestUrl}; ${JSON.stringify(actionAttempt)}`)
    }
    writeFileSync(config.evidence, JSON.stringify({ ok: true, sameGuest: true, cookiePreserved: true,
      value, takeover: true, resumed: true, automationReleased: true, finalAnswer: response.message,
      workflow: { runId: workflow.runId, state: workflow.state, approvals, sameGuest: guest.id === guestId,
        cookiePreserved: workflowCookie.includes('existing=preserved'), managedFallback: false, actionOutcome } }))
  } finally {
    await gui.stop()
    if (!window.isDestroyed()) window.destroy()
  }
}

void run().then(() => { clearTimeout(timeout); app.exit(0) }, (error) => {
  writeFileSync(config.evidence, JSON.stringify({ ok: false, message: String(error), stack: error?.stack }))
  process.stderr.write(String(error?.stack ?? error) + '\n')
  app.exit(1)
})
