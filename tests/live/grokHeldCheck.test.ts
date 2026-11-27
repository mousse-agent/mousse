/**
 * The held check (`grok/heldCheck.ts`) on the real Grok: every tool of a held turn asks Mousse before any effect, with
 * a Claude Code allow rule and a saved "always allow" answer present, and the one-shot route sends one request with no
 * tools and Mousse's system text alone. It runs against a stub model with a dummy key: no account, no sign-in, nothing
 * leaves the loopback. Only with MOUSSE_LIVE_GROK=1; MOUSSE_GROK_BINARIES lists the executables to check, separated by
 * the path delimiter (else the `grok` on PATH). Its passing records are what `GROK_HELD_SHIPPED` holds.
 */
import { execFileSync } from 'node:child_process'
import { delimiter } from 'node:path'
import { describe, expect, it } from 'vitest'
import { cliNames, findOnPath } from '../../src/mms/harness/env'
import { runGrokHeldCheck } from '../../src/mms/harness/grok/heldCheck'

const live = process.env.MOUSSE_LIVE_GROK === '1'
const binaries = (process.env.MOUSSE_GROK_BINARIES?.split(delimiter).filter(Boolean)) ??
  [findOnPath(cliNames('grok'), { env: process.env, searchPath: [] })].filter((path): path is string => Boolean(path))

const versionOf = (binary: string) => /(\d+\.\d+\.\d+)/.exec(execFileSync(binary, ['--version'], { encoding: 'utf8' }))?.[1]
const check = (binary: string, heldConfig?: string) => runGrokHeldCheck({
  command: binary, args: [], env: process.env, cliVersion: versionOf(binary)!, log: (line) => console.log(line), ...(heldConfig !== undefined ? { heldConfig } : {})
}, new AbortController().signal)

describe.runIf(live && binaries.length)('the held check on the real Grok', () => {
  for (const binary of binaries) {
    it(`holds every turn item and the one-shot route: ${binary}`, async () => {
      const record = await check(binary)
      console.log(JSON.stringify(record))
      expect(record).toMatchObject({ cliVersion: versionOf(binary), platform: process.platform, turns: true, titles: true })
      expect(record!.reason).toBeUndefined()
    }, 300_000)
  }

  // Controls: the check fails when either pin of the held home is missing, so a pass above is the pins' doing.
  it('fails without the held config: reads, searches and read-only shell run unasked, and the MCP grant stands', async () => {
    const record = await check(binaries[0]!, '')
    expect(record).toMatchObject({ turns: false })
    for (const item of ['read', 'list', 'search', 'read-only shell', 'writing shell', 'MCP']) expect(record!.reason).toContain(item)
  }, 300_000)

  it('fails with the ask rule alone: the saved "always allow" answer runs the MCP tool unasked', async () => {
    const record = await check(binaries[0]!, '[permission]\nrules = [ { action = "ask", tool = "any" } ]\n')
    expect(record).toMatchObject({ turns: false })
    expect(record!.reason).toBe('Grok ran MCP without asking Mousse first.')
  }, 300_000)
})
