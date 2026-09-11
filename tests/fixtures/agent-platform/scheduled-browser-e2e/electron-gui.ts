import { app, BrowserWindow } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { GuiMmsController } from '../../../../src/main/mms/GuiMmsController'
import type { WorkflowRunView } from '../../../../src/shared/workflowRunPlatform'

const config = JSON.parse(readFileSync(process.env.MOUSSE_E2E_CONFIG!, 'utf8')) as {
  home: string; endpoint: string; ownerToken: string; profileId: string; userData: string;
  ready: string; close?: string; evidence: string; runId?: string
}
app.setPath('userData', config.userData)
app.disableHardwareAcceleration()
const timeout = setTimeout(() => app.exit(2), 60_000)
timeout.unref()

async function run(): Promise<void> {
  await app.whenReady()
  const gui = new GuiMmsController({ homeDir: config.home, endpointOverride: config.endpoint,
    ownerTokenOverride: config.ownerToken, disableAutoStart: true, requestTimeoutMs: 30_000 })
  gui.on('error', () => {})
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
  try {
    await gui.start()
    const binding = await gui.prepareWindow(window.webContents)
    if (binding.profileId !== config.profileId) throw new Error('GUI bound the wrong profile')
    writeFileSync(config.ready, JSON.stringify({ senderId: window.webContents.id, profileId: binding.profileId }))
    if (!config.runId) {
      while (!config.close || !existsSync(config.close)) await new Promise((resolve) => setTimeout(resolve, 20))
      writeFileSync(config.evidence, JSON.stringify({ closed: true, profileId: binding.profileId }))
      return
    }
    let approvals = 0
    let view = await gui.runWithSender(window.webContents, () => gui.request<WorkflowRunView>('workflowRuns.get', {
      profileId: config.profileId, runId: config.runId
    }))
    const deadline = Date.now() + 40_000
    while (Date.now() < deadline && view.state !== 'succeeded') {
      if (view.state === 'failed' || view.state === 'unknown-effect' || view.state === 'cancelled') {
        throw new Error(`Scheduled browser workflow stopped as ${view.state}: ${view.error ?? ''}`)
      }
      if (view.pendingApproval) {
        const pending = view.pendingApproval
        approvals += 1
        view = await gui.runWithSender(window.webContents, () => gui.request<WorkflowRunView>('workflowRuns.approve', {
          profileId: config.profileId, runId: config.runId, approvalId: pending.approvalId,
          nodeId: pending.nodeId, instanceKey: pending.instanceKey, attempt: pending.attempt, approved: true
        }))
      } else {
        await new Promise((resolve) => setTimeout(resolve, 20))
        view = await gui.runWithSender(window.webContents, () => gui.request<WorkflowRunView>('workflowRuns.get', {
          profileId: config.profileId, runId: config.runId
        }))
      }
    }
    if (view.state !== 'succeeded') throw new Error(`Scheduled browser workflow timed out as ${view.state}`)
    writeFileSync(config.evidence, JSON.stringify({ state: view.state, approvals, profileId: binding.profileId }))
  } finally {
    await gui.stop()
    if (!window.isDestroyed()) window.destroy()
  }
}

void run().then(() => { clearTimeout(timeout); app.exit(0) }, (error) => {
  writeFileSync(config.evidence, JSON.stringify({ error: String(error), stack: error?.stack }))
  process.stderr.write(String(error?.stack ?? error) + '\n')
  app.exit(1)
})
