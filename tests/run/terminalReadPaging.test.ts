/**
 * `terminal_read`'s cut-text fields (docs/plans/tool-api.md §1.2 "Paging"): a page of a long terminal says it is cut,
 * how long the kept output is, and the call that reads the page before it, as bounded as this one. Over a fake terminal,
 * so it reads the same on every platform (`terminalRead.test.ts` drives real shells).
 */
import { describe, expect, it } from 'vitest'
import { readTerminals } from '../../src/mms/run/mcp/appTools/terminals'

const scrollback = Array.from({ length: 300 }, (_, at) => `row ${at + 1}`).join('\r\n') + '\r\n'
const host = {
  list: () => [{ ptyId: 'pty-1', threadId: 't', shell: 'bash', cwd: '/w', status: 'running' as const, startedAt: 1, lastOutputAt: 2 }],
  output: () => ({ scrollback, droppedLines: 0 }),
  mask: (text: string) => text
}
const read = (args: Record<string, unknown>) => JSON.parse(readTerminals(host, 't', args).text).output

describe('terminal_read pages', () => {
  it('a cut page carries truncated, totalChars and readMore, the call for the page before; the first page has no readMore', () => {
    const last = read({ lines: 100 })
    expect(last).toMatchObject({ fromLine: 201, toLine: 300, truncated: true, totalChars: scrollback.length })
    expect(last.readMore).toEqual({ tool: 'terminal_read', args: { threadId: 't', terminalId: 'pty-1', before: 201, lines: 100 } })
    const back = read(last.readMore.args)
    expect(back).toMatchObject({ fromLine: 101, toLine: 200 })
    const first = read(back.readMore.args)
    expect(first.fromLine).toBe(1)
    expect(first).not.toHaveProperty('readMore')
    expect(first.truncated).toBe(false)
  })
})
