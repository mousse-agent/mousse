import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { Script } from 'node:vm'
import { join } from 'node:path'
import {
  APPLET_SOURCE_LIMIT,
  APPLET_STATE_LIMIT,
  extractAppletParts,
  validateAppletSubmission
} from '../src/shared/applets'
import { AppletStore, exportAppletHtml } from '../src/mms/applets/AppletStore'
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
