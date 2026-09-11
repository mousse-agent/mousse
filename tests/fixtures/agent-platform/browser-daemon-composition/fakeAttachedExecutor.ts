import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AttachedBrowserCommand } from '../../../../src/mms/protocol/connectionCommands'
import type {
  BrowserObservation,
  BrowserSessionRecord,
  BrowserWorkerRequest,
  BrowserWorkerResponse
} from '../../../../src/shared/browser/types'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aM1cAAAAASUVORK5CYII=', 'base64')

interface FakeSession {
  record: BrowserSessionRecord
  tabId: string
  observationId: string
  documentId: string
  screenshotId: string
}

export class FakeAttachedExecutor {
  readonly calls: BrowserWorkerRequest[] = []
  private readonly sessions = new Map<string, FakeSession>()
  private sequence = 0

  constructor(private readonly artifactRoot: string) {}

  handle = async (command: AttachedBrowserCommand): Promise<BrowserWorkerResponse> => {
    const request = command.request
    this.calls.push(request)
    try {
      return { version: 1, id: request.id, ok: true, result: this.dispatch(request) }
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? String((error as { code: unknown }).code) : 'invalid_action'
      const message = error instanceof Error ? error.message : String(error)
      return { version: 1, id: request.id, ok: false, error: { code: code as never, message } }
    }
  }

  private dispatch(request: BrowserWorkerRequest): unknown {
    if (request.method === 'session.open') return this.open(request)
    const sessionId = String(request.params.sessionId ?? '')
    const session = this.sessions.get(sessionId)
    if (!session) throw Object.assign(new Error('Browser session is unavailable'), { code: 'session_closed' })
    if (request.method === 'session.close') {
      session.record = { ...session.record, lifecycle: 'closed', updatedAt: now() }
      return { session: session.record }
    }
    if (request.method === 'observe') return this.observe(session)
    if (request.method === 'tabs.list') return { tabs: this.observe(session).tabs }
    if (request.method === 'control.take') return this.control(session, request.params.owner === 'human' ? 'human' : 'agent')
    if (request.method === 'human.act') return this.act(session, request, true)
    if (request.method === 'act') return this.act(session, request, false)
    if (request.method === 'wait') return this.observe(session)
    if (request.method === 'find') return { observationId: session.observationId, elements: [] }
    if (request.method === 'extract') return { text: 'fixture' }
    throw Object.assign(new Error('Unsupported attached method'), { code: 'unsupported' })
  }

  private open(request: BrowserWorkerRequest): { session: BrowserSessionRecord; observation: BrowserObservation } {
    this.sequence += 1
    const id = `sess_attached_${randomUUID()}`
    const tabId = `tab_${this.sequence}_${randomUUID().slice(0, 8)}`
    const created = now()
    const record: BrowserSessionRecord = {
      id,
      profileId: request.profileId,
      threadId: typeof request.params.threadId === 'string' ? request.params.threadId : undefined,
      runId: typeof request.params.runId === 'string' ? request.params.runId : undefined,
      persistent: false,
      backend: 'electron-attached',
      browserVersion: 'fixture-attached',
      generation: 1,
      lifecycle: 'agent-controlled',
      controlLeaseId: `lease_${this.sequence}`,
      createdAt: created,
      updatedAt: created
    }
    const session: FakeSession = {
      record,
      tabId,
      observationId: `obs_${this.sequence}_1`,
      documentId: `doc_${this.sequence}`,
      screenshotId: `art_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaa${String(this.sequence).padStart(5, '0')}`
    }
    this.sessions.set(id, session)
    return { session: { ...record }, observation: this.observe(session) }
  }

  private control(session: FakeSession, owner: 'human' | 'agent'): { controlLeaseId: string; generation: number; lifecycle: BrowserSessionRecord['lifecycle'] } {
    session.record = {
      ...session.record,
      generation: session.record.generation + 1,
      lifecycle: owner === 'human' ? 'human-controlled' : 'agent-controlled',
      controlLeaseId: `lease_${session.record.id}_${session.record.generation + 1}`,
      updatedAt: now()
    }
    session.observationId = `obs_${session.record.id}_${session.record.generation}`
    return {
      controlLeaseId: session.record.controlLeaseId!,
      generation: session.record.generation,
      lifecycle: session.record.lifecycle
    }
  }

  private act(session: FakeSession, request: BrowserWorkerRequest, human: boolean): unknown {
    if (human && session.record.lifecycle !== 'human-controlled') {
      throw Object.assign(new Error('A human control lease is not active'), { code: 'human_controlled' })
    }
    if (!human && session.record.lifecycle === 'human-controlled') {
      throw Object.assign(new Error('A human control lease is active'), { code: 'human_controlled' })
    }
    if (request.params.generation !== session.record.generation) {
      throw Object.assign(new Error('Browser generation is stale'), { code: 'stale_generation' })
    }
    session.observationId = `obs_${session.record.id}_${session.record.generation}_act`
    return {
      requestId: request.params.requestId ?? request.id,
      outcome: 'verified',
      dispatched: true,
      artifactIds: [],
      observation: this.observe(session)
    }
  }

  private observe(session: FakeSession): BrowserObservation {
    this.writeScreenshot(session)
    return {
      sessionId: session.record.id,
      tabId: session.tabId,
      generation: session.record.generation,
      observationId: session.observationId,
      documentId: session.documentId,
      capturedAt: now(),
      url: 'https://example.test/attached',
      title: 'Attached fixture',
      viewport: { cssWidth: 1, cssHeight: 1, deviceScaleFactor: 1, scrollX: 0, scrollY: 0 },
      tabs: [{ id: session.tabId, title: 'Attached fixture', url: 'https://example.test/attached' }],
      elements: [{ ref: 'e1', frameRef: 'f1', role: 'button', name: 'Go', text: 'Go', states: [] }],
      screenshot: {
        artifactId: session.screenshotId,
        pixelWidth: 1,
        pixelHeight: 1,
        cssToImageScaleX: 1,
        cssToImageScaleY: 1
      },
      truncated: false,
      warnings: [],
      provenance: 'untrusted-page'
    }
  }

  private writeScreenshot(session: FakeSession): void {
    const dir = join(this.artifactRoot, session.record.profileId, session.record.id)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${session.screenshotId}.png`), PNG)
  }
}

function now(): string {
  return '2026-09-11T00:00:00.000Z'
}

export const FIXTURE_PNG = PNG
