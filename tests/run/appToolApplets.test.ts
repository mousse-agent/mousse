/**
 * `publish_applet` from a vendor runtime (PR 2 §2): the turn stages applets for its response when an
 * applet store is set, and the runtime is told about applets in its session text and turn preamble.
 */
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AppletStore } from '../../src/mms/applets/AppletStore'
import { APPLET_GENERATION_GUIDANCE } from '../../src/shared/appletGuidance'
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
      for (const title of ['One', 'Two', 'Three', 'Four']) results.push(await callTool(mcp!, 'publish_applet', applet(title)))
      return 'Here are the charts.'
    })
    d = await vendorDaemon([vendor])
    d.orch.setAppletStore(new AppletStore(d.home, (threadId) => join(d!.home, 'applet-threads', threadId)))
    await d.send('Chart it')

    for (const result of results) expect(result.error).toBeUndefined()
    expect(results[0]).toMatchObject({ isError: true, text: 'Unsupported applet schema version.' })
    expect(results.slice(1, 4).map((result) => [result.isError, JSON.parse(result.text!)])).toEqual([
      [undefined, { queued: true, title: 'One' }],
      [undefined, { queued: true, title: 'Two' }],
      [undefined, { queued: true, title: 'Three' }]
    ])
    expect(results[4]).toMatchObject({ isError: true, text: 'Only three applets may be published per response.' })

    // The reply in the transcript carries one fence per staged applet, after the model's text.
    const reply = d.orch.getMessages(d.thread.id).filter((message) => message.role === 'assistant').at(-1)!
    expect(reply.content.startsWith('Here are the charts.')).toBe(true)
    expect(fences(reply.content)).toBe(3)
    for (const title of ['One', 'Two', 'Three']) expect(reply.content).toContain(`"title":"${title}"`)
    expect(reply.content).not.toContain('"title":"Four"')
    expect(reply.content).not.toContain('"title":"Broken"')
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
    expect(result).toMatchObject({ isError: true, text: 'Applets are off for this turn.' })
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
