import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { Script } from 'node:vm'
import { join } from 'node:path'
import {
  APPLET_SOURCE_LIMIT,
  APPLET_STATE_LIMIT,
  extractAppletParts,
  appendStagedApplets,
  modelFacingReplyText,
  redactAppletFences,
  redactAppletTail,
  validateAppletSubmission
} from '../src/shared/applets'
import { AppletStore, exportAppletHtml } from '../src/mms/applets/AppletStore'
import { DefinitionTurnRecord } from '../src/mms/agentDefinitions/definitionTurnRecord'
import { stripActionBlocks } from '../src/mms/orchestrator/actions'
import {
  publishAppletPresentation,
  recoverAppletPresentation
} from '../src/mms/applets/publishPresentation'
const source = {
  schemaVersion: 1,
  title: 'Calculator',
  description: 'Illustrative costs',
  html: '<main>Costs</main>',
  css: 'main{color:red}',
  js: 'document.body.dataset.ready="true"'
}
const fence = (value: unknown) => '```mousse-applet\n' + JSON.stringify(value) + '\n```\n'
const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'mousse-applets-'))
  directories.push(home)
  const resolve = (threadId: string) => {
    if (!['one', 'two'].includes(threadId)) throw new Error('Unknown thread')
    return join(home, threadId)
  }
  return { home, store: new AppletStore(home, resolve), resolve }
}
describe('explicit applet extraction', () => {
  it('keeps ordinary code and partial streaming inert', () => {
    const content = '```html\n<script>alert(1)</script>\n```\n' + fence(source)
    expect(extractAppletParts(content, false)).toEqual([{ type: 'text', text: content }])
    expect(extractAppletParts(content, true).map((part) => part.type)).toEqual([
      'text',
      'submission'
    ])
    expect(extractAppletParts('```mousse-applet\n{}', true)[0].type).toBe('text')
  })
  it('preserves position and does not activate fences nested inside ordinary code', () => {
    const quoted = '````text\n' + fence(source) + '````\n'
    expect(extractAppletParts('````text\n' + fence(source), true)[0].type).toBe('text')
    const parts = extractAppletParts(quoted + 'Before\n' + fence(source) + 'After', true)
    expect(parts.map((part) => part.type)).toEqual(['text', 'submission', 'text'])
    expect(parts[0]).toEqual({ type: 'text', text: quoted + 'Before\n' })
  })
  it('isolates malformed submissions and enforces per-message limit', () => {
    expect(extractAppletParts('```mousse-applet\ninvalid\n```', true)[0].type).toBe('error')
    expect(extractAppletParts(fence(source).repeat(4), true).map((part) => part.type)).toEqual([
      'submission',
      'submission',
      'submission',
      'error'
    ])
  })
  it('rejects ownership fields, unsafe update paths, oversize input and circular JSON', () => {
    expect(() => validateAppletSubmission({ ...source, profileId: 'other' })).toThrow('unsupported')
    expect(() =>
      validateAppletSubmission({ ...source, appletId: '../other', expectedRevision: 'revision' })
    ).toThrow('Invalid')
    expect(() =>
      validateAppletSubmission({ ...source, html: 'x'.repeat(APPLET_SOURCE_LIMIT) })
    ).toThrow('512 KiB')
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(() => validateAppletSubmission({ ...source, data: circular })).toThrow('JSON')
  })
})
describe('applets sized to the viewport', () => {
  // The frame grows to fit the page, so a page sized to the frame grows without end. Rejected where a new applet
  // enters the thread; one already published still loads.
  const rejected: Array<[string, Partial<typeof source>]> = [
    ['vh in css', { css: 'main{min-height:100vh}' }],
    ['dvh in css', { css: '.wrap{height:50dvh}' }],
    ['svh in css', { css: '.wrap{height:80svh}' }],
    ['lvh in css', { css: '.wrap{height:80lvh}' }],
    ['vh inside calc', { css: '.wrap{height:calc(100vh - 40px)}' }],
    ['a fractional vh', { css: '.wrap{max-height:.5vh}' }],
    ['vmin, which is vh in a wide frame', { css: '.dial{width:40vmin}' }],
    ['vh inside @media', { css: '@media (min-width:1px){.wrap{height:100vh}}' }],
    ['height:100% on html and body', { css: 'html,body{height:100%}' }],
    ['min-height:100% on body with a class', { css: 'body.dark { color: red; min-height: 100% !important }' }],
    ['height:100% on :root', { css: ':root{height:100%}' }],
    ['vh in a style attribute', { html: '<div style="height: 100vh">x</div>' }],
    ['vh in a <style> element', { html: '<style>.a{height:100dvh}</style><div class=a></div>' }],
    ['height:100% on a stray <body>', { html: '<body style="height:100%"><p>x</p></body>' }]
  ]
  const accepted: Array<[string, Partial<typeof source>]> = [
    ['pixel heights', { css: 'main{min-height:240px;height:80px}' }],
    ['height:100% on an inner element', { css: '.chart{height:100%}' }],
    ['max-height and line-height 100% on body', { css: 'body{max-height:100%;line-height:100%}' }],
    ['width in vw', { css: '.row{width:50vw}' }],
    ['"100vh" in prose', { html: '<p>Panels used to be 100vh tall.</p>' }],
    ['a vh unit in a comment', { css: '/* not 100vh */ main{height:80px}' }],
    ['a class name that ends in vh', { css: '.h-100vh-free{height:80px}', html: '<div class="h-100vh-free"></div>' }]
  ]
  it.each(rejected)('rejects %s at publish, telling the agent to use content or pixel heights', (_name, change) => {
    const submission = { ...source, ...change }
    expect(() => validateAppletSubmission(submission, { publishing: true })).toThrow(
      /sizes itself to the viewport.*Use content-driven heights or pixel heights/
    )
    // Loading, recovering and exporting an applet already published still accept it.
    expect(validateAppletSubmission(submission).css).toBe(submission.css)
  })
  it('quotes a long selector shortened, as the reason goes back to the model', () => {
    const selector = '.chart_' + 'x'.repeat(5_000) + ' body'
    expect(() => validateAppletSubmission({ ...source, css: `${selector}{height:100%}` }, { publishing: true })).toThrow(/"\.chart_x{52}…" in css/)
  })
  it.each(accepted)('accepts %s', (_name, change) => {
    expect(() => validateAppletSubmission({ ...source, ...change }, { publishing: true })).not.toThrow()
  })
  it('a reply fence that sizes to the viewport stays text with the reason; an earlier published one still recovers', () => {
    const { store } = fixture()
    const sized = { ...source, css: 'main{min-height:100vh}' }
    const parts = publishAppletPresentation(store, { threadId: 'one', messageId: 'm', turnId: 't', content: fence(sized) })
    expect(parts?.map((part) => part.type)).toEqual(['text'])
    expect(JSON.stringify(parts)).toContain('Applet unavailable: Applet sizes itself to the viewport')
    expect(store.list('one')).toEqual([])

    // Published before this check existed: it loads, and a restart recovers it from the reply.
    const input = { threadId: 'one', messageId: 'old', turnId: 'old', content: fence(sized) }
    const legacy = store.publish({ ...input, submission: sized })
    expect(store.load('one', legacy.appletId, legacy.revisionId).source.css).toBe(sized.css)
    expect(recoverAppletPresentation(store, input)?.map((part) => part.type)).toEqual(['applet'])
  })
})
describe('durable applet publication', () => {
  it('survives restart, deduplicates retries and preserves immutable revisions', () => {
    const { home, store, resolve } = fixture()
    const input = { threadId: 'one', messageId: 'message1', turnId: 'turn1', submission: source }
    const first = store.publish(input)
    const restarted = new AppletStore(home, resolve)
    expect(restarted.publish(input)).toEqual(first)
    expect(() =>
      restarted.publish({ ...input, submission: { ...source, title: 'Changed' } })
    ).toThrow('retry changed')
    const second = restarted.publish({
      ...input,
      messageId: 'message2',
      turnId: 'turn2',
      submission: {
        ...source,
        title: 'Updated',
        appletId: first.appletId,
        expectedRevision: first.revisionId
      }
    })
    expect(restarted.load('one', first.appletId, first.revisionId).title).toBe('Calculator')
    expect(second.previousRevisionId).toBe(first.revisionId)
    expect(restarted.list('one')[0].revisionId).toBe(second.revisionId)
    expect(() =>
      restarted.publish({
        ...input,
        messageId: 'message3',
        turnId: 'turn3',
        submission: { ...source, appletId: first.appletId, expectedRevision: first.revisionId }
      })
    ).toThrow('revision changed')
  })
  it('rejects cross-thread access and tampered source', () => {
    const { home, store } = fixture()
    const first = store.publish({
      threadId: 'one',
      messageId: 'm',
      turnId: 't',
      submission: source
    })
    expect(() => store.load('two', first.appletId, first.revisionId)).toThrow()
    expect(() => store.load('one', '../one', first.revisionId)).toThrow('identifier')
    const path = join(home, 'one', 'applets', first.appletId, `${first.revisionId}.json`)
    const corrupt = JSON.parse(readFileSync(path, 'utf8'))
    corrupt.source.js = 'corrupted'
    writeFileSync(path, JSON.stringify(corrupt))
    expect(() => store.load('one', first.appletId, first.revisionId)).toThrow('integrity')
  })
  it('retains compatible state, rejects stale saves, and resets incompatible revisions', () => {
    const { store } = fixture()
    const first = store.publish({
      threadId: 'one',
      messageId: 'm1',
      turnId: 't1',
      submission: source
    })
    store.saveState('one', first.appletId, first.revisionId, { slider: 10 })
    expect(() =>
      store.saveState('one', first.appletId, first.revisionId, 'x'.repeat(APPLET_STATE_LIMIT))
    ).toThrow('64 KiB')
    const second = store.publish({
      threadId: 'one',
      messageId: 'm2',
      turnId: 't2',
      submission: { ...source, appletId: first.appletId, expectedRevision: first.revisionId }
    })
    expect(store.loadState('one', second.appletId, second.revisionId)).toEqual({ slider: 10 })
    expect(() => store.saveState('one', first.appletId, first.revisionId, {})).toThrow('stale')
    store.saveState('one', second.appletId, second.revisionId, { slider: 20 })
    expect(store.loadState('one', first.appletId, first.revisionId)).toEqual({ slider: 10 })
    const third = store.publish({
      threadId: 'one',
      messageId: 'm3',
      turnId: 't3',
      submission: {
        ...source,
        stateVersion: 2,
        appletId: second.appletId,
        expectedRevision: second.revisionId
      }
    })
    expect(store.loadState('one', third.appletId, third.revisionId)).toBeNull()
  })
  it('exports offline sandboxed HTML without injecting supplied source into host markup', () => {
    const exported = exportAppletHtml(
      validateAppletSubmission({ ...source, title: '</script><script>evil()</script>' })
    )
    const hostScript = exported.slice(
      exported.indexOf('<script>') + 8,
      exported.lastIndexOf('</script>')
    )
    expect(() => new Script(hostScript)).not.toThrow()
    expect(exported).toContain('sandbox="allow-scripts"')
    expect(exported).toContain("connect-src 'none'")
    expect(exported).not.toContain('</script><script>evil()')
  })
})

describe('completed-message applet presentation', () => {
  it('keeps ordinary prose unchanged and durably publishes ordered references across restart', () => {
    const { home, store, resolve } = fixture()
    const input = {
      threadId: 'one',
      messageId: 'm',
      turnId: 't',
      content: 'Before\n' + fence(source) + 'After'
    }
    expect(publishAppletPresentation(store, { ...input, content: 'Ordinary text' })).toBeUndefined()
    const parts = publishAppletPresentation(store, input)
    expect(parts?.map((part) => part.type)).toEqual(['text', 'applet', 'text'])
    expect(publishAppletPresentation(new AppletStore(home, resolve), input)).toEqual(parts)
  })
  it('preserves malformed or conflicting source without failing the assistant turn', () => {
    const { store } = fixture()
    const input = { threadId: 'one', messageId: 'm', turnId: 't', content: fence(source) }
    publishAppletPresentation(store, input)
    const failed = publishAppletPresentation(store, {
      ...input,
      content: fence({ ...source, title: 'Changed retry' })
    })
    expect(failed?.[0].type).toBe('text')
    expect(JSON.stringify(failed)).toContain('publication failed')
    expect(JSON.stringify(failed)).toContain('Changed retry')
    const invalid = publishAppletPresentation(store, {
      ...input,
      content: '```mousse-applet\ninvalid\n```'
    })
    expect(JSON.stringify(invalid)).toContain('invalid JSON')
  })
})

describe('publication crash recovery', () => {
  it('recovers a committed bundle when the transcript reference or index was not saved', () => {
    const { home, store, resolve } = fixture()
    const input = {
      threadId: 'one',
      messageId: 'm1',
      turnId: 't1',
      content: 'Before\n' + fence(source) + 'After'
    }
    const first = store.publish({ ...input, submission: source })
    rmSync(join(home, 'one', 'applets', 'index.json'))
    const restarted = new AppletStore(home, resolve)
    const recovered = recoverAppletPresentation(restarted, input)
    expect(recovered?.map((part) => part.type)).toEqual(['text', 'applet', 'text'])
    const part = recovered?.[1]
    expect(part?.type === 'applet' ? part.reference.revisionId : null).toBe(first.revisionId)
    expect(restarted.list('one')[0].revisionId).toBe(first.revisionId)
    expect(restarted.publish({ ...input, submission: source })).toEqual(first)
  })
  it('never creates a bundle for historical source without a matching durable publication', () => {
    const { store } = fixture()
    const input = { threadId: 'one', messageId: 'm1', turnId: 't1', content: fence(source) }
    expect(recoverAppletPresentation(store, input)).toBeUndefined()
    expect(store.list('one')).toEqual([])
    store.publish({ ...input, submission: source })
    expect(recoverAppletPresentation(store, { ...input, messageId: 'different' })).toBeUndefined()
    expect(recoverAppletPresentation(store, { ...input, turnId: 'different' })).toBeUndefined()
    expect(
      recoverAppletPresentation(store, { ...input, content: fence({ ...source, js: 'changed' }) })
    ).toBeUndefined()
  })
  it('recovers an orphan old revision without rewinding a newer durable head', () => {
    const { home, store } = fixture()
    const firstInput = { threadId: 'one', messageId: 'm1', turnId: 't1', submission: source }
    const first = store.publish(firstInput)
    const updated = store.publish({
      threadId: 'one',
      messageId: 'm2',
      turnId: 't2',
      submission: { ...source, appletId: first.appletId, expectedRevision: first.revisionId }
    })
    const path = join(home, 'one', 'applets', 'index.json')
    const index = JSON.parse(readFileSync(path, 'utf8'))
    index.receipts = {}
    writeFileSync(path, JSON.stringify(index))
    expect(store.recoverPublication(firstInput)?.revisionId).toBe(first.revisionId)
    expect(store.list('one')[0].revisionId).toBe(updated.revisionId)
  })
})

describe('applet source kept from a model', () => {
  const CANARY = 'CANARY_SOURCE'
  const LS = String.fromCharCode(0x2028)
  const withCanary = { ...source, js: `window.x = "${CANARY}"` }
  const body = JSON.stringify(withCanary)
  // Each is a reply publication refuses or reads in a way of its own; none may pass the source on.
  const replies: Array<[string, string]> = [
    ['a valid fence', 'Here:\n' + fence(withCanary) + 'Done.'],
    ['a fence after a code block an earlier row left open', '```js\nlet a = 1\nHere:\n' + fence(withCanary) + 'Done.'],
    ['a fourth fence', fence(source).repeat(3) + fence(withCanary)],
    ['a fence over the size limit', fence({ ...withCanary, css: 'x'.repeat(APPLET_SOURCE_LIMIT) })],
    ['invalid JSON', '```mousse-applet\n{"title": "Broken", "js": "' + CANARY + '"\n```\n'],
    ['a fence that never closes', 'Here:\n```mousse-applet\n' + body],
    ['a fence opening after a line separator', 'Here:' + LS + '```mousse-applet\n' + body + '\n```\nDone.'],
    ['a fence opening after a lone carriage return', 'Here:\r```mousse-applet\n' + body + '\n```\nDone.'],
    ['an indented fence in another case', '   ~~~~ Mousse-Applet\n' + body + '\n~~~~\nDone.'],
    ['CRLF line ends', 'Here:\r\n```mousse-applet\r\n' + body + '\r\n```\r\nDone.'],
    ['a fence opening inside another one, closing after it', '~~~mousse-applet\n{"title": "Outer"}\n```mousse-applet\n' + body + '\n~~~\n"' + CANARY + '"\n```\nDone.'],
    ['a fence opening mid-line, as a stopped run joins rows', 'Checking. ~~~mousse-applet\n' + body + '\n~~~\nDone.'],
    ['a body whose string holds a line separator and backticks', '```mousse-applet\n{"html": "<pre>' + LS + '```' + LS + '</pre>", "js": "' + CANARY + '"}\n```\nDone.'],
    ['a fence publication ends early, at a line separator', '~~~mousse-applet\n{"js":\n~~~' + LS + CANARY + '\n~~~\nDone.'],
    ['a failed publication as the reply shows it', 'Here:\n```mousse-applet\n' + JSON.stringify(withCanary, null, 2) + '\n```\n\nApplet unavailable: publication failed.']
  ]

  it.each(replies)('cuts the source of %s, naming the applet', (_name, reply) => {
    const redacted = redactAppletFences(reply)
    expect(redacted).not.toContain(CANARY)
    expect(redacted).toMatch(/\[Applet[:\]]/)
    expect(redactAppletFences(redacted)).toBe(redacted)
    expect(modelFacingReplyText({ role: 'assistant', content: reply })).toBe(redacted)
  })

  it('cuts no more than the fence, and names a valid applet by its title', () => {
    expect(redactAppletFences('Here:\n' + fence(withCanary) + 'Done.')).toBe('Here:\n[Applet: Calculator]\nDone.')
    expect(redactAppletFences('Here:\n```mousse-applet\n' + body)).toBe('Here:\n[Applet: Calculator]')
    expect(redactAppletFences('```mousse-applet\nnot json\n```')).toBe('[Applet]')
    expect(redactAppletFences('Checking. ~~~mousse-applet\n' + body + '\n~~~\nDone.')).toBe('Checking. [Applet: Calculator]\nDone.')
    expect(redactAppletFences('A mousse-applet fence:\n```js\nx\n```')).toBe('A mousse-applet fence:\n```js\nx\n```')
    // Only a top-level title names it: a stopped body's data is not a title.
    expect(redactAppletFences('```mousse-applet\n{"data":{"title":"Dataset heading"},"js":"')).toBe('[Applet]')
  })

  it('reads a stored reply from the text the model wrote, naming published applets by their reference lines', () => {
    const totals = { appletId: 'applet_a', revisionId: 'rev_a', sourceHash: 'h', title: 'Totals' + LS + '```js', description: 'd' }
    // The stored parts are not read: publication's added text could end a cut early.
    const content = 'Here:\n' + fence({ ...source, title: totals.title }) + '\n' + fence(withCanary) + 'Done.'
    const named = modelFacingReplyText({ role: 'assistant', content, presentationParts: [{ type: 'text', text: CANARY }, { type: 'applet', reference: totals }] })
    expect(named).toBe('Here:\n[Applet: Totals ``js (appletId applet_a, revision rev_a)]\n\n[Applet: Calculator]\nDone.')
  })

  it('names a published applet inside an outer fence publication did not read, and cuts the outer one to its end', () => {
    const reference = { appletId: 'applet_a', revisionId: 'rev_a', sourceHash: 'h', title: 'Calculator', description: 'd' }
    const content = ' ~~~mousse-applet\n' + fence(source) + CANARY + '\n~~~\nDone.'
    expect(redactAppletFences(content, [reference])).toBe(' [Applet]\n[Applet: Calculator (appletId applet_a, revision rev_a)]\nDone.')
    // A published applet the text does not name by its title still reaches the model, after the text.
    expect(redactAppletFences('Done.', [reference])).toBe('Done.\n\n[Applet: Calculator (appletId applet_a, revision rev_a)]')
  })

  it('names a published applet the same when its result is redacted again', () => {
    const reference = { appletId: 'applet_a', revisionId: 'rev_a', sourceHash: 'h', title: 'Demo ~~~mousse-applet', description: 'd' }
    const once = redactAppletFences(fence({ ...source, title: reference.title }) + 'Done.', [reference])
    // The title is an opening too, inside the fence: the cut runs to the end, which only hides more.
    expect(once).toContain('[Applet: Demo ~~mousse-applet (appletId applet_a, revision rev_a)]')
    expect(redactAppletFences(once)).toBe(once)
  })

  it.each([
    ['after the text', 'Done.', 'Done.F'],
    ['after closing a code block the reply leaves open', 'Here:\n```js\nx', 'Here:\n```js\nx\n```F'],
    ['after an applet fence the reply leaves open, which stays open', 'Here:\n~~~mousse-applet\n{', 'Here:\n~~~mousse-applet\n{F'],
    ['after a closed block that mentions an applet fence', '```js\n// ~~~mousse-applet\n```\nDone.', '```js\n// ~~~mousse-applet\n```\nDone.F']
  ])('puts staged applets %s', (_name, reply, staged) => {
    expect(appendStagedApplets(reply, 'F')).toBe(staged)
  })
  it('returns the text from a point, read as part of the whole', () => {
    const turn = 'Draft:\n~~~mousse-applet\n{"js":"' + CANARY + '"}\n~~~\nDone.'
    expect(redactAppletFences(turn, [], turn.indexOf('{'))).toBe('[Applet]\nDone.')
    expect(redactAppletFences(turn, [], turn.indexOf('Done.'))).toBe('Done.')
  })

  it('reads a last row with the rows before it as they streamed, so no row closes a fence early', () => {
    // A definition's rows, a tool call between each: the indented middle row closes nothing, trimmed or not.
    const record = new DefinitionTurnRecord()
    const rows = ['Draft:\n~~~mousse-applet\n', '   ~~~', '{"js":"' + CANARY + '"}\n~~~']
    rows.forEach((row, at) => {
      record.text({ phase: 'start', content: row, contentIndex: 0 })
      if (at < rows.length - 1) record.tool({ phase: 'start', callId: `c${at}`, kind: 'mcp_tool_call', title: 'Read', summary: '', details: [] })
    })
    expect(redactAppletTail(record.allText(), record.finalText())).toBe('[Applet]')
    expect(redactAppletTail('Draft:\n', 'Done.')).toBe('Done.')
  })

  it('names a published applet on the fence that has all its parts, not an earlier one with its title', () => {
    const reference = { appletId: 'applet_a', revisionId: 'rev_a', sourceHash: 'h', title: 'Calculator', description: 'd' }
    expect(redactAppletFences(fence({ title: 'Calculator' }) + fence(source), [reference])).toBe('[Applet: Calculator]\n[Applet: Calculator (appletId applet_a, revision rev_a)]\n')
  })

  it('leaves an action block inside an applet fence, so the fence is still cut whole', () => {
    const reply = '~~~mousse-applet\n~~~```mousse-actions\n{"type":"message","content":"ok"}\n```\n{"js":"' + CANARY + '"}\n~~~'
    expect(stripActionBlocks(reply)).toBe(reply)
    expect(redactAppletFences(stripActionBlocks(reply))).toBe('[Applet]')
  })
  it('scans a long run of tildes once', () => {
    expect(redactAppletFences('mousse-applet\n' + '~'.repeat(1_000_000) + 'x')).toHaveLength(1_000_015)
  })
  it('passes a person\'s pasted fence on as written', () => {
    expect(modelFacingReplyText({ role: 'user', content: fence(withCanary) })).toContain(CANARY)
  })
})