/**
 * What a bot's reply shows beside its words, as a thread's reply does (docs/bots.md, "What a bot's chat shows"): an
 * applet its turn published (matched to its thread's publication, never shown as source, named in its journal), a
 * picture an MCP tool handed its turn (kept in its files folder, under its next message, readable by a phone), and how
 * another device sees both. Also which turns are offered `publish_applet`.
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppletStore } from '../../src/mms/applets/AppletStore'
import { BotMcp, callForBot } from '../../src/mms/bots/mcp/BotMcp'
import { compileBotThread } from '../../src/mms/bots/grants/compile'
import { resetToolImages } from '../../src/mms/bots/chat/toolImages'
import { publishedApplets } from '../../src/mms/bots/chat/replyApplets'
import { remoteBotMessage } from '../../src/mms/bridge/remote/RemoteBots'
import type { AppletReference, AppletSubmission } from '../../src/shared/applets'
import type { BotMcpTool } from '../../src/shared/bots/personal/authority'
import { botStarterManifest, botMayBeOffered } from '../../src/shared/bots/personal/manifest'
import { botFixture, chatOf, createBot, finish, start, type BotFixture } from './botFixture'

/** A 1×1 PNG and an SVG that carries a script. */
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString('base64')

const budget: AppletSubmission = { schemaVersion: 1, title: 'Budget', description: 'Monthly budget.', html: '<output id="t"></output>', css: '', js: 'document.getElementById("t").textContent = "4000"', stateVersion: 1 }
const fence = (submission: unknown) => `\`\`\`mousse-applet\n${JSON.stringify(submission)}\n\`\`\``

let f: BotFixture
let scratch: string

beforeEach(() => {
  f = botFixture()
  scratch = mkdtempSync(join(tmpdir(), 'mousse-bot-reply-parts-'))
  resetToolImages()
})

afterEach(() => {
  f.close()
  rmSync(scratch, { recursive: true, force: true })
})

/** `budget` published by the real applet store, as a thread's reply publishes it: its reference. */
function published(submission: AppletSubmission = budget): AppletReference {
  const store = new AppletStore(scratch, (threadId) => join(scratch, 'threads', threadId))
  const bundle = store.publish({ threadId: 'home', messageId: 'msg-1', turnId: 'turn-1', submission })
  return { appletId: bundle.appletId, revisionId: bundle.revisionId, sourceHash: bundle.sourceHash, title: bundle.title, description: bundle.description }
}

describe('a bot\'s applet', () => {
  it('shows from what its thread published, never as source, and its journal names it', async () => {
    const reference = published()
    const asked: string[] = []
    f.bots.chat.setReplyParts({ published: (threadId) => { asked.push(threadId); return [reference] } })
    const { botId, firstActivation } = await createBot(f)
    const { payload } = await start(f, firstActivation)
    // The bot published Budget, and wrote an Other applet its thread never published.
    const other = { ...budget, title: 'Other', js: '' }
    await finish(f, payload, 'completed', { text: `Here is your budget.\n\n${fence(budget)}\n\n${fence(other)}` })

    const reply = chatOf(f, botId).filter((message) => message.author === 'bot').at(-1)!
    expect(asked).toEqual([payload.threadId])
    expect(reply.applets).toEqual([{ threadId: payload.threadId, reference }])
    expect(reply.text).toBe('Here is your budget.\n\n*Applet unavailable: Other*')
    expect(reply.text).not.toContain('mousse-applet')
    // An applet is not a file: the files a phone may open keep their indexes.
    expect(reply.attachments).toBeUndefined()
    const journaled = f.journal.find((row) => row.sourceKey === `bm:${reply.id}`)!
    expect(journaled.text).toContain('[Applet: Budget]')
    expect(journaled.text).not.toContain('textContent')
  })

  it('is offered to a bot\'s chat and work turns, never to a consult, and is no permission anyone grants', async () => {
    const { firstActivation } = await createBot(f)
    const { prepared } = await start(f, firstActivation)
    expect(prepared.authority.appTools.has('publish_applet')).toBe(true)
    expect(botMayBeOffered('publish_applet')).toBe(true)
    const compile = (botTools: Parameters<typeof compileBotThread>[0]['botTools']) => compileBotThread({
      grant: botStarterManifest(), digest: 'd', thread: {}, scratch: join(scratch, 'run'), profileHome: scratch,
      nativeNames: (tools) => ({ ok: true, names: [...tools] }), remaining: { deadlineMs: 60_000 }, ...(botTools ? { botTools } : {})
    })
    const consult = compile({ escalate: true, consult: false, memory: true })
    const work = compile({ escalate: true, consult: false, memory: true, frontDesk: false, threads: 'read', applets: true })
    expect(consult.ok && consult.permissions.appTools).not.toContain('publish_applet')
    expect(work.ok && work.permissions.appTools).toContain('publish_applet')
    // A grant that names it is refused: it is always on where it belongs, never a permission.
    const granted = compile(undefined)
    expect(granted.ok).toBe(true)
    expect(compileBotThread({
      grant: { ...botStarterManifest(), appTools: [...botStarterManifest().appTools, 'publish_applet'] }, digest: 'd', thread: {}, scratch: join(scratch, 'run'), profileHome: scratch,
      nativeNames: (tools) => ({ ok: true, names: [...tools] }), remaining: { deadlineMs: 60_000 }
    }).ok).toBe(false)
  })
})

describe('a picture an MCP tool hands a bot', () => {
  const chart: BotMcpTool = {
    name: 'Charts__render', providerName: 'mcp__Charts__render__1', server: 'srv-charts', tool: 'render', serverName: 'Charts',
    description: 'Renders a chart.', inputSchema: { type: 'object' }
  }

  it('is kept in the bot\'s files folder and shows under its next message, where a phone can open it; an SVG never', async () => {
    const { botId, firstActivation } = await createBot(f)
    const { payload, prepared } = await start(f, firstActivation)
    const manager = { callTool: vi.fn(async () => ({ content: [{ type: 'text', text: 'Rendered.' }, { type: 'image', data: PNG, mimeType: 'image/png' }, { type: 'image', data: SVG, mimeType: 'image/svg+xml' }] }) as never) }
    const mcp = new BotMcp({ catalog: { ensure: async () => undefined, servers: () => [], listing: () => [] }, manager, enabled: () => true })
    // The grant's decision is another test's: here the call is allowed.
    const bot = { ...prepared.authority, mcpTools: [chart], check: () => ({ ok: true as const }) }
    const outcome = await callForBot({ bot, name: chart.name, args: {}, signal: new AbortController().signal, mcp })
    expect(outcome.text).toContain('Your owner sees this picture under your next message')

    const files = prepared.authority.workspace!.files!
    const days = readdirSync(join(files, 'images'))
    expect(days).toHaveLength(1)
    const saved = readdirSync(join(files, 'images', days[0]!))
    expect(saved).toHaveLength(1)
    expect(saved[0]).toMatch(/^charts-render-\d{6}\.png$/)

    await finish(f, payload, 'completed', { text: 'Here is the chart.' })
    const reply = chatOf(f, botId).filter((message) => message.author === 'bot').at(-1)!
    expect(reply.attachments).toEqual([{ name: saved[0], path: join(files, 'images', days[0]!, saved[0]!) }])
    expect(f.bots.service.attachmentFile(botId, reply.id, 0).name).toBe(saved[0])

    // Taken by that message: the activation's next one carries none.
    const next = f.bots.chat.post({ botId, author: 'bot', kind: 'notice', text: 'One more thing.', activationId: firstActivation, threadId: payload.threadId })
    expect(next.attachments).toBeUndefined()
  })

  it('is not kept through a link out of the files folder', async () => {
    const { firstActivation } = await createBot(f)
    const { prepared } = await start(f, firstActivation)
    const files = prepared.authority.workspace!.files!
    const outside = join(scratch, 'outside')
    mkdirSync(outside)
    mkdirSync(files, { recursive: true })
    try {
      symlinkSync(outside, join(files, 'images'), 'junction')
    } catch {
      return // No way to make a link here: nothing to check.
    }
    const manager = { callTool: vi.fn(async () => ({ content: [{ type: 'image', data: PNG, mimeType: 'image/png' }] }) as never) }
    const mcp = new BotMcp({ catalog: { ensure: async () => undefined, servers: () => [], listing: () => [] }, manager, enabled: () => true })
    const outcome = await callForBot({ bot: { ...prepared.authority, mcpTools: [chart], check: () => ({ ok: true as const }) }, name: chart.name, args: {}, signal: new AbortController().signal, mcp })
    expect(outcome.text).not.toContain('Your owner sees')
    expect(readdirSync(outside)).toEqual([])
  })
})

describe('what a bot\'s thread published', () => {
  it('is what its finished, shown replies carry, newest first: what the app may run from it', () => {
    const ref = (id: string): AppletReference => ({ appletId: id, revisionId: `r-${id}`, sourceHash: id, title: id, description: '' })
    const part = (id: string) => ({ type: 'applet' as const, reference: ref(id) })
    const messages = [
      { id: '1', role: 'assistant', content: '', timestamp: '', presentationParts: [part('old')] },
      { id: '2', role: 'user', content: '', timestamp: '', presentationParts: [part('typed')] },
      { id: '3', role: 'assistant', content: '', timestamp: '', hidden: true, presentationParts: [part('hidden')] },
      { id: '4', role: 'assistant', content: '', timestamp: '', streaming: true, presentationParts: [part('streaming')] },
      { id: '5', role: 'assistant', content: '', timestamp: '', presentationParts: [{ type: 'text' as const, text: 'Hi' }, part('new')] }
    ] as unknown as Parameters<typeof publishedApplets>[0]
    expect(publishedApplets(messages).map((reference) => reference.appletId)).toEqual(['new', 'old'])
  })
})

describe('another device', () => {
  it('reads an applet as one plain line naming it, and gets no reference to run', () => {
    const remote = remoteBotMessage({
      seq: 1, id: 'm1', at: '2026-11-13T09:00:00.000Z', author: 'bot', kind: 'text', text: 'Here it is.', chips: [],
      applets: [{ threadId: 'home', reference: { appletId: 'a', revisionId: 'r', sourceHash: 'h', title: 'Budget ![x](https://e.example/p.png)', description: '' } }]
    })
    expect(remote).not.toHaveProperty('applets')
    expect(remote.text).toBe('Here it is.\n\n_Applet: Budget xhttps://e.example/p.png. It opens on the computer._')
  })
})
