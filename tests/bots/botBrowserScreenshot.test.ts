/**
 * A bot's browser_screenshot reaches its owner (no browser: a scripted browser service): with the bot's files folder the
 * picture is saved under `images/<date>/`, waits for the activation's next message (`takeToolImages`), and the bot is
 * told where it is; the model still gets the picture alone. Without a files folder nothing is saved or kept.
 */
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BotBrowsers, type BotBrowserService } from '../../src/mms/bots/browser/BotBrowsers'
import { resetToolImages, takeToolImages } from '../../src/mms/bots/chat/toolImages'
import { dispatchBrowserTool } from '../../src/mms/orchestrator/browser/dispatch'
import type { BrowserSessionRecord } from '../../src/shared/browser/types'

const profileId = '44444444-4444-4444-8444-444444444444'
const BOT = 'bot-shotshotshot'
/** A PNG as the browser worker hands it over: its first bytes are what makes it a picture. */
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])

const folders: string[] = []
afterEach(() => {
  resetToolImages()
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
})

/** A browser service with one managed session whose screenshot is `PNG`. */
function fakeService(): BotBrowserService {
  let record: BrowserSessionRecord | undefined
  return {
    tools: {
      invoke: async (name: string, args: Record<string, unknown>) => {
        if (name === 'browser_open') {
          record = { id: 'sess_1', profileId, threadId: 'home', persistent: true, workspaceId: String(args.workspaceId), backend: 'managed-chromium', browserVersion: '1', generation: 1, lifecycle: 'agent-controlled', controlLeaseId: 'lease_1', createdAt: '', updatedAt: '' }
          return { ok: true, value: { session: record, observation: { tabId: 'tab_1', sessionId: 'sess_1' } } }
        }
        if (name === 'browser_screenshot')
          return { ok: true, value: { observation: { tabId: 'tab_1', sessionId: 'sess_1', screenshot: { artifactId: 'art_1', pixelWidth: 1, pixelHeight: 1, cssToImageScaleX: 1, cssToImageScaleY: 1 } } } }
        return { ok: true, value: { observation: { tabId: 'tab_1', sessionId: 'sess_1' } } }
      }
    },
    sessions: {
      trustedSessionScope: () => { if (!record) throw new Error('none'); return { threadId: 'home', record } },
      retireViewerBudget: () => {}
    },
    artifacts: {
      read: async (_scope: unknown, artifactId: string) => {
        expect(artifactId).toBe('art_1')
        return { ref: { mediaType: 'image/png' }, bytes: new Uint8Array(PNG) }
      }
    },
    workspaceDataDir: () => '/nonexistent'
  } as unknown as BotBrowserService
}

/** One activation's browser_screenshot, the way the bot's app tool makes it (on a model that sees images). */
async function screenshot(activationId: string, filesFolder?: string) {
  const service = fakeService()
  const bots = new BotBrowsers({ profileId, browser: () => service, homeThread: () => 'home', setTimer: () => ({ clear: () => undefined }) })
  const turn = bots.turn({ botId: BOT, activationId, lane: 'run', homeThreadId: 'home', runId: `run-${activationId}`, signal: new AbortController().signal, ...(filesFolder ? { filesFolder } : {}) })!
  const binding = { ...turn.binding, vision: true }
  const opened = await dispatchBrowserTool({ port: turn.runtime, binding, name: 'browser_open', args: { url: 'https://example.com/' } })
  expect(opened.isError, opened.text).toBe(false)
  return dispatchBrowserTool({ port: turn.runtime, binding, name: 'browser_screenshot', args: {} })
}

describe("a bot's browser screenshot", () => {
  it('with its files folder is saved there, waits for its next message, and the bot is told where; without one, none of that', async () => {
    const files = join(realpathSync(mkdtempSync(join(tmpdir(), 'mousse-bot-shot-'))), 'files')
    folders.push(join(files, '..'))
    const kept = await screenshot('act-kept', files)
    // The control: the same screenshot with no files folder.
    const plain = await screenshot('act-plain')
    for (const result of [kept, plain]) {
      expect(result.isError, result.text).toBe(false)
      // The model sees the picture as before: no note rides along with it.
      expect(result.image).toStrictEqual({ data: PNG.toString('base64'), mimeType: 'image/png' })
    }
    // Kept for this activation's next message, as the PNG the browser took, under images/<date>/ in its files folder.
    const saved = takeToolImages('act-kept')
    expect(saved).toHaveLength(1)
    expect(saved[0]!.path.startsWith(join(files, 'images'))).toBe(true)
    expect(saved[0]!.path).toMatch(/[\\/]images[\\/]\d{4}-\d{2}-\d{2}[\\/]browser-screenshot-[^\\/]+\.png$/)
    expect(readFileSync(saved[0]!.path).equals(PNG)).toBe(true)
    // The bot is told where, on one line after the tool's own output; without a files folder the output is unchanged.
    const lines = kept.text.split('\n')
    expect(lines.at(-1)).toContain(saved[0]!.path)
    expect(lines.slice(0, -1).join('\n')).toBe(plain.text)
    expect(takeToolImages('act-plain')).toEqual([])
  })
})
