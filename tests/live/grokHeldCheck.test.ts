/**
 * The held check (`grok/heldCheck.ts`) on the real Grok: every tool of a held turn asks Mousse before any effect, in a
 * plain project with the person's allow rules and a saved answer present, in a trusted project whose own config allows
 * everything, and in a worktree whose main checkout has a saved answer; no hook or MCP server from another agent's
 * setup or the project starts; the one-shot route sends one request with no tools, Mousse's text alone and the
 * message as written, and nothing anywhere else. It runs against a stub model with a dummy key: no account, no
 * sign-in, nothing leaves the loopback. Only with MOUSSE_LIVE_GROK=1; MOUSSE_GROK_BINARIES lists the executables to
 * check, separated by the path delimiter (else the `grok` on PATH). Its passing records are what `GROK_HELD_SHIPPED`
 * holds (MOUSSE_GROK_RECORDS names a file to write them to).
 */
import { execFileSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { delimiter } from 'node:path'
import { describe, expect, it } from 'vitest'
import { cliNames, findOnPath } from '../../src/mms/harness/env'
import { GROK_HELD_SWITCHES } from '../../src/mms/harness/grok/held'
import { runGrokHeldCheck, type GrokCheckLaunch } from '../../src/mms/harness/grok/heldCheck'

const live = process.env.MOUSSE_LIVE_GROK === '1'
const binaries = (process.env.MOUSSE_GROK_BINARIES?.split(delimiter).filter(Boolean)) ??
  [findOnPath(cliNames('grok'), { env: process.env, searchPath: [] })].filter((path): path is string => Boolean(path))

const versionOf = (binary: string) => /(\d+\.\d+\.\d+)/.exec(execFileSync(binary, ['--version'], { encoding: 'utf8' }))?.[1]
const check = (binary: string, seams: Pick<GrokCheckLaunch, 'heldConfig' | 'dropHeldEnv'> = {}) => runGrokHeldCheck({
  command: binary, args: [], env: process.env, cliVersion: versionOf(binary)!, log: (line) => console.log(line), ...seams
}, new AbortController().signal)

describe.runIf(live && binaries.length)('the held check on the real Grok', () => {
  for (const binary of binaries) {
    it(`holds every turn item, every startup source and the one-shot route: ${binary}`, async () => {
      const record = await check(binary)
      // MOUSSE_GROK_RECORDS names a file the passing records are added to, for `GROK_HELD_SHIPPED`.
      if (process.env.MOUSSE_GROK_RECORDS) appendFileSync(process.env.MOUSSE_GROK_RECORDS, `${JSON.stringify(record)}\n`)
      expect(record).toMatchObject({ cliVersion: versionOf(binary), platform: process.platform, turns: true, titles: true })
      expect(record!.reason).toBeUndefined()
    }, 300_000)
  }

  // Controls: each fails the check when one guard of the held launch is taken away, so a pass above is that guard's doing.
  it('fails without the held config: reads, searches, a read-only shell, writes, edits and the saved MCP answer run unasked', async () => {
    const record = await check(binaries[0]!, { heldConfig: '' })
    expect(record).toMatchObject({ turns: false })
    for (const item of ['read', 'list', 'search', 'read-only shell', 'write', 'edit', 'MCP']) expect(record!.reason).toContain(item)
  }, 300_000)

  it('fails with the ask rule alone: the saved "always allow" answer runs the MCP tool unasked', async () => {
    const record = await check(binaries[0]!, { heldConfig: '[permission]\nrules = [ { action = "ask", tool = "any" } ]\n' })
    expect(record).toMatchObject({ turns: false })
    expect(record!.reason).toContain('Grok ran MCP without asking Mousse first.')
  }, 300_000)

  it('fails when a worktree may take its main checkout’s answers', async () => {
    const record = await check(binaries[0]!, { heldConfig: '[permission]\nrules = [ { action = "ask", tool = "any" } ]\n\n[ui]\nremember_tool_approvals = true\n', dropHeldEnv: ['GROK_WORKTREE_INHERITS_MAIN_APPROVALS'] })
    expect(record).toMatchObject({ turns: false })
    expect(record!.reason).toContain('In a worktree')
  }, 300_000)

  it('fails without the startup switches: hooks from the person’s and the project’s Claude Code settings run', async () => {
    const record = await check(binaries[0]!, { dropHeldEnv: Object.keys(GROK_HELD_SWITCHES) })
    expect(record).toMatchObject({ turns: false })
    expect(record!.reason).toMatch(/Grok started .*claude-user-hook/)
  }, 300_000)
})
