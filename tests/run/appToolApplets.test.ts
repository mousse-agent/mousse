/**
 * `publish_applet` from a vendor runtime (PR 2 §2): the turn stages applets for its response when an
 * applet store is set, and the runtime is told about applets in its session text and turn preamble. Its parts may be
 * files in the thread's folder (#761).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AppletStore } from '../../src/mms/applets/AppletStore'
import { appletFromFiles, appletTools } from '../../src/mms/run/mcp/appTools/applets'
import { APPLET_SOURCE_LIMIT } from '../../src/shared/applets'
import { APPLET_GENERATION_GUIDANCE } from '../../src/shared/appletGuidance'
import { refusalOf } from './appToolsFixture'
import { callTool, VendorAdapter, vendorDaemon, type ToolCallResult, type VendorDaemon } from './appToolVendorFixture'

const applet = (title: string) => ({
  schemaVersion: 1,
  title,
  description: `${title} chart`,
  html: `<h1>${title}</h1>`,
  css: 'h1 { color: teal; }',
  js: 'void 0'
})

const fences = (text: string) => text.split('```mousse-applet').length - 1

describe('publish_applet from a vendor turn', () => {
  let d: VendorDaemon | undefined
  afterEach(async () => {
    await d?.dispose()
    d = undefined
  })

  it('stages up to three applets per response into the transcript; an invalid one or a fourth is an error result', async () => {
    const results: ToolCallResult[] = []
    const vendor = new VendorAdapter(async ({ input, mcp }) => {
      if (input.prompt !== 'Chart it') return 'Revised.'
      results.push(await callTool(mcp!, 'publish_applet', { ...applet('Broken'), schemaVersion: 2 }))
      results.push(await callTool(mcp!, 'publish_applet', { ...applet('Viewport'), css: 'main { min-height: 100dvh }' }))
      for (const title of ['One', 'Two', 'Three', 'Four']) results.push(await callTool(mcp!, 'publish_applet', applet(title)))
      return 'Here are the charts.'
    })
    d = await vendorDaemon([vendor])
    d.orch.setAppletStore(new AppletStore(d.home, (threadId) => join(d!.home, 'applet-threads', threadId)))
    await d.send('Chart it')

    for (const result of results) expect(result.error).toBeUndefined()
    expect(refusalOf(results[0])).toMatchObject({ message: 'Unsupported applet schema version.' })
    // An applet sized to the viewport is refused with the reason, and stages nothing.
    expect(refusalOf(results[1])?.message).toMatch(/sizes itself to the viewport.*Use content-driven heights or pixel heights/)
    expect(results.slice(2, 5).map((result) => [result.isError, JSON.parse(result.text!)])).toEqual([
      [undefined, { queued: true, title: 'One' }],
      [undefined, { queued: true, title: 'Two' }],
      [undefined, { queued: true, title: 'Three' }]
    ])
    expect(refusalOf(results[5])).toMatchObject({ message: 'Only three applets may be published per response.' })

    // The reply in the transcript carries one fence per staged applet, after the model's text.
    const reply = d.orch.getMessages(d.thread.id).filter((message) => message.role === 'assistant').at(-1)!
    expect(reply.content.startsWith('Here are the charts.')).toBe(true)
    expect(fences(reply.content)).toBe(3)
    for (const title of ['One', 'Two', 'Three']) expect(reply.content).toContain(`"title":"${title}"`)
    expect(reply.content).not.toContain('"title":"Four"')
    expect(reply.content).not.toContain('"title":"Broken"')
    expect(reply.content).not.toContain('"title":"Viewport"')
    expect(reply.presentationParts?.filter((part) => part.type === 'applet')).toHaveLength(3)

    // Session text carries the generation guidance; the next turn's preamble lists the published applets.
    expect(vendor.bridges[0].sessionInstructions).toContain(APPLET_GENERATION_GUIDANCE.trim())
    expect(vendor.bridges[0].turnPreamble).not.toContain('## Applets')
    await d.send('Make the second one bigger')
    const preamble = vendor.bridges[1].turnPreamble
    expect(preamble).toContain('## Applets')
    expect(preamble).toContain('Existing applets in this conversation')
    for (const title of ['One', 'Two', 'Three']) expect(preamble).toContain(`"title":"${title}"`)
    expect(vendor.bridges[1].sessionInstructions).toBe(vendor.bridges[0].sessionInstructions)
  }, 30_000)

  it('without an applet store the call returns "Applets are off for this turn." and nothing is staged', async () => {
    let result: ToolCallResult | undefined
    const vendor = new VendorAdapter(async ({ mcp }) => {
      result = await callTool(mcp!, 'publish_applet', applet('One'))
      return 'No charts.'
    })
    d = await vendorDaemon([vendor])
    await d.send('Chart it')
    expect(result!.error).toBeUndefined()
    expect(refusalOf(result)).toMatchObject({ message: 'Applets are off for this turn.' })
    const reply = d.orch.getMessages(d.thread.id).filter((message) => message.role === 'assistant').at(-1)!
    expect(reply.content).toBe('No charts.')
    expect(vendor.bridges[0].sessionInstructions).not.toContain('In-thread applets')
    expect(vendor.bridges[0].turnPreamble).not.toContain('## Applets')
    expect(vendor.bridges[0].turnPreamble).not.toMatch(/Usable now: .*publish_applet/)
  }, 30_000)

  it('an unstamped call (no turn token) is refused before it can stage anything', async () => {
    let result: ToolCallResult | undefined
    const vendor = new VendorAdapter(async ({ mcp }) => {
      result = await callTool({ url: mcp!.url, token: mcp!.token }, 'publish_applet', applet('One'))
      return 'Plain.'
    })
    d = await vendorDaemon([vendor])
    d.orch.setAppletStore(new AppletStore(d.home, (threadId) => join(d!.home, 'applet-threads', threadId)))
    await d.send('Chart it')
    expect(result!.error).toMatchObject({ data: { reason: 'mousse_caller_not_live' } })
    const reply = d.orch.getMessages(d.thread.id).filter((message) => message.role === 'assistant').at(-1)!
    expect(fences(reply.content)).toBe(0)
  }, 30_000)
})

describe('an applet\'s parts from files (#761)', () => {
  const folders: string[] = []
  afterEach(() => {
    for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
  })
  const folder = () => {
    const base = mkdtempSync(join(tmpdir(), 'mousse-applet-files-'))
    folders.push(base)
    mkdirSync(join(base, 'thread'))
    writeFileSync(join(base, 'thread', 'page.html'), '<p>hi</p>')
    writeFileSync(join(base, 'outside.html'), '<p>out</p>')
    return join(base, 'thread')
  }
  const head = { schemaVersion: 1, title: 'T', description: 'D' }

  it('publish_applet stages from files exactly what the same content inline stages, and refuses a part given twice', async () => {
    const at = folder()
    const page = applet('From files')
    writeFileSync(join(at, 'page.html'), page.html)
    writeFileSync(join(at, 'page.css'), page.css)
    writeFileSync(join(at, 'page.js'), page.js)
    const staged: unknown[] = []
    const [tool] = appletTools()
    const ctx = { turn: { projectPath: at, onPublishApplet: (args: unknown) => (staged.push(args), { queued: true }) } } as unknown as Parameters<typeof tool.handler>[1]
    const { html: _html, css: _css, js: _js, ...rest } = page
    expect((await tool.handler({ ...rest, htmlPath: 'page.html', cssPath: 'page.css', jsPath: join(at, 'page.js') }, ctx)).isError).toBeUndefined()
    await tool.handler(page, ctx)
    expect(staged).toHaveLength(2)
    expect(staged[0]).toEqual(staged[1])
    expect(refusalOf(await tool.handler({ ...rest, html: page.html, htmlPath: 'page.html' }, ctx))?.refused).toMatchObject({ code: 'invalid_arguments', message: 'Give html or htmlPath, not both.' })
    expect(staged).toHaveLength(2)
  })

  it('leaves an inline call as it is', () => {
    const args = { ...head, html: '<p>x</p>', css: '', js: '' }
    expect(appletFromFiles(args, undefined)).toEqual({ args })
  })

  it('reads a path relative to the thread\'s folder, and a part given neither way is empty', () => {
    expect(appletFromFiles({ ...head, htmlPath: 'page.html' }, folder())).toEqual({ args: { ...head, html: '<p>hi</p>', css: '', js: '' } })
  })

  it.each([
    ['a path outside the folder', { htmlPath: '../outside.html' }, /outside this thread's folder/],
    ['a file that is not there', { htmlPath: 'missing.html' }, /no file at htmlPath missing\.html/],
    ['the folder itself', { htmlPath: '.' }, /outside this thread's folder/],
    ['a part given both ways', { css: 'p{}', cssPath: 'page.html' }, /Give css or cssPath, not both/],
    ['a path that is not text', { jsPath: 3 }, /jsPath must be a file path/]
  ])('refuses %s with the reason', (_name, extra, reason) => {
    const read = appletFromFiles({ ...head, ...extra }, folder())
    expect('refused' in read && read.refused).toMatch(reason)
  })

  it('refuses a file over the applet source limit, and a turn with no folder', () => {
    const at = folder()
    writeFileSync(join(at, 'big.js'), 'x'.repeat(APPLET_SOURCE_LIMIT + 1))
    expect(appletFromFiles({ ...head, jsPath: 'big.js' }, at)).toEqual({ refused: expect.stringMatching(/an applet's source is at most 512 KiB/) })
    expect(appletFromFiles({ ...head, htmlPath: 'page.html' }, undefined)).toEqual({ refused: expect.stringMatching(/no folder to read htmlPath from/) })
  })
})
