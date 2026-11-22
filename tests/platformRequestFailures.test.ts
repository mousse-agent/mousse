/**
 * A window's platform request (sign-in, turning networking on, making a connect link) that failed, as the window is
 * answered by main's `platform:request` handler, and what main's own log keeps of it. A dropped connection or a slow
 * answer from the background service reads in plain words; a refusal keeps the service's own words; anything else is
 * the generic message with a reference, and that reference is in `gui-connection.log` with its causes, redacted.
 */
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

type Handler = (event: unknown, ...args: unknown[]) => unknown
const handlers = vi.hoisted(() => new Map<string, (event: unknown, ...args: unknown[]) => unknown>())

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, handler: Handler) => { handlers.set(channel, handler) }, removeHandler: () => undefined, on: () => undefined },
  BrowserWindow: { getAllWindows: () => [] },
  Notification: class {},
  app: { getPath: () => '', getVersion: () => '0.0.0', on: () => undefined },
  shell: {},
  dialog: {},
  clipboard: {},
  nativeTheme: { on: () => undefined },
  screen: { on: () => undefined, getAllDisplays: () => [] },
  session: {},
  webContents: {}
}))

import { registerGuiIpc, type GuiIpcServices } from '../src/main/ipc/registerGuiIpc'
import { PresentationState } from '../src/main/mms/PresentationState'
import { GuiConnectionLog, logErrorReferences } from '../src/main/mms/guiConnectionLog'
import { MmsProtocolError } from '../src/mms/protocol/client'
import { SERVICE_ANSWERED_LATE, SERVICE_STOPPED_ANSWERING } from '../src/shared/errors'

let failure: unknown
const guiMms = {
  on: () => undefined,
  request: vi.fn(async () => { throw failure }),
  runWithSender: (_sender: unknown, run: () => unknown) => run(),
  getCurrentSenderId: () => 7,
  getWindowBindingForSender: () => ({ profileId: 'profile-1' }),
  getBaseBinding: () => undefined
}
const inert = (base: object = {}): object => new Proxy(base, { get: (target, key) => key in target ? (target as Record<PropertyKey, unknown>)[key] : () => undefined })

type Answer = { ok: boolean; error?: { code: string; message: string; details?: unknown } }
const call = (method: string) => handlers.get('platform:request')!({ sender: { id: 7 } }, { method, params: {} }) as Promise<Answer>

const home = mkdtempSync(join(tmpdir(), 'mousse-platform-failures-'))
const log = new GuiConnectionLog(home)
let stopLogging: () => void

beforeAll(() => {
  registerGuiIpc({ guiMms: inert(guiMms), presentation: new PresentationState(), settings: inert(), browserView: inert(), repoRoot: '' } as unknown as GuiIpcServices, () => null)
  stopLogging = logErrorReferences(log)
})
afterEach(() => vi.restoreAllMocks())
afterAll(() => {
  stopLogging()
  rmSync(home, { recursive: true, force: true })
})

describe('a failed platform request, as the window is answered', () => {
  it.each([
    ['the connection to the service dropped', new Error('Connection closed'), 'service_connection_lost', SERVICE_STOPPED_ANSWERING],
    ['the connection dropped before hello', new Error('Connection closed before hello'), 'service_connection_lost', SERVICE_STOPPED_ANSWERING],
    ['the socket was reset', Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }), 'service_connection_lost', SERVICE_STOPPED_ANSWERING],
    ['the client was not connected', new Error('Not connected'), 'service_connection_lost', SERVICE_STOPPED_ANSWERING],
    ['no answer came in time', new Error('Request timeout: net.link.make'), 'service_timeout', SERVICE_ANSWERED_LATE]
  ])('%s: plain words, no reference', async (_name, cause, code, message) => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    failure = cause
    const answer = await call('net.plus.login.finish')
    expect(answer.ok).toBe(false)
    expect(answer.error).toMatchObject({ code, message })
  })

  it('a refusal from the service keeps its own code and words', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    failure = new MmsProtocolError('forbidden', 'Mousse ID refused the sign-in.')
    expect((await call('net.plus.login.begin')).error).toMatchObject({ code: 'forbidden', message: 'Mousse ID refused the sign-in.' })
  })

  it('anything else is the generic message with a reference, whose redacted cause is in gui-connection.log', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const secret = 'sk-live0123456789abcdefSECRET'
    failure = new Error('keychain read failed', { cause: new Error(`token exchange said no: Bearer ${secret}`) })
    const answer = await call('net.link.make')
    const reference = /Reference: (\S+)$/.exec(answer.error?.message ?? '')?.[1]
    expect(reference).toBeTruthy()
    // The cause never reaches the window.
    expect(JSON.stringify(answer)).not.toContain('keychain')

    await log.flush()
    const lines = readFileSync(log.path, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
    const entry = lines.find((line) => line.event === 'error.reference' && line.reference === reference)
    expect(entry).toMatchObject({ code: 'platform_request_failed', operation: 'net.link.make' })
    expect(entry?.cause).toContain('keychain read failed')
    expect(entry?.cause).toContain('token exchange said no')
    expect(entry?.cause).toContain('[redacted]')
    expect(readFileSync(log.path, 'utf8')).not.toContain(secret)
  })
})
