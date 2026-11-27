/**
 * `cursor:sdk` claims `isolation: verified`, `tools: none_offered` and `attempts: one`. Shown on the real `@cursor/sdk`
 * (`harness/realCursor.ts`: throwaway folders, a loopback stub for Cursor's backend, a made-up key), started through the
 * runtime's single-request transport as a title request starts it.
 *
 * The person's home holds Cursor's setup (`~/.cursor` rules, skills, hooks and MCP servers, `AGENTS.md`, `CLAUDE.md`),
 * and Mousse's profile is in that home, so the folders above every place hold a project's too. Each hook and server
 * writes a marker when it runs. Nothing may run, the SDK may not ask for the person's plugins or managed skills, no
 * request may carry their lines, the run must declare an empty tool list, and the place must be gone after.
 *
 * The control runs the same SDK on the same person and folders with every settings layer on (as a turn runs): hooks
 * run, MCP servers start and plugins are asked for, so the checks above would see them. The stub never answers a run,
 * so rule lines reach no request either way (Cursor's servers ask for them during a run): what keeps them out is that
 * no settings layer loads, which the control shows the SDK logs and the request runs without.
 *
 * Each claim fails when its guard is dropped from `cursorOneShotOptions` (checked on SDK 1.0.35): without
 * `settingSources: []` the person's hooks and MCP servers run; without `tools: []` the run declares no tool list (the
 * default toolset); without `enableAgentRetries: false` a run that fails with 503 or 429 is sent four times.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { classifyOneShotFailure } from '../src/mms/harness/oneShot/runner'
import { placesLeft } from './harness/realOpencode'
import { cursorConfig, cursorHostScript, cursorPerson, cursorRuntime, cursorSdkEntry, cursorStub, DUMMY_KEY, sendCursorOnce, type RunFailure } from './harness/realCursor'

let hostScript: string
beforeAll(async () => {
  hostScript = await cursorHostScript()
}, 60_000)

const cleanups: Array<() => void | Promise<unknown>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/** A person with Cursor's setup in their home and in Mousse's profile folder, above every place. */
function personWithSetup() {
  const person = cursorPerson()
  cleanups.push(person.remove)
  const markers = join(person.root, 'markers')
  mkdirSync(markers)
  const strings = [...cursorConfig(person.home, markers, 'USER'), ...cursorConfig(person.profile, markers, 'ABOVE')]
  return { person, markers, strings }
}

/** Plugins and managed skills: what the SDK asks Cursor for when a settings layer is on. */
const SETTINGS_CALLS = ['GetEffectiveUserPlugins', 'GetManagedSkills']

describe('cursor:sdk holds the person’s Cursor setup out of a single request (real SDK at a stub)', () => {
  it('runs no hook or MCP server of theirs, asks for no plugin, sends none of their lines, declares no tool, and leaves nothing behind', async () => {
    const { person, markers, strings } = personWithSetup()
    const stub = await cursorStub('http503')
    cleanups.push(() => stub.close())
    const runtime = cursorRuntime({ person, hostScript, stub })
    cleanups.push(() => runtime.stop())
    const { seen, sent } = sendCursorOnce(runtime)
    const error = await sent.then(() => undefined, (failure: unknown) => failure)
    expect(classifyOneShotFailure(error)).toBe('unavailable')
    expect(seen.sent).toBe(1)
    // The run went out, so the checks below read what a request carries.
    const run = stub.requests.filter((request) => request.url.endsWith('/BidiAppend'))
    expect(run).toHaveLength(1)
    expect(run[0]!.text).toContain('PROMPT_LINE_7f3a')
    // No tool: the run and its message carry an empty allowed-tools list.
    for (const request of stub.requests.filter((each) => /\/(RunSSE|BidiAppend)$/.test(each.url))) expect(request.headers['x-cursor-agent-allowed-tools']).toBe('')
    // Nothing of theirs ran, was asked for, or was sent.
    expect(readdirSync(markers)).toEqual([])
    expect(stub.requests.filter((request) => SETTINGS_CALLS.some((call) => request.url.endsWith(call)))).toEqual([])
    const everything = stub.requests.map((request) => `${request.url}\n${JSON.stringify(request.headers)}\n${request.text}`).join('\n')
    for (const line of strings) expect(everything).not.toContain(line)
    // Never the ambient key: the entry's own.
    expect(everything).not.toContain('ambient-key')
    expect(everything).toContain(DUMMY_KEY)
    expect(placesLeft(person.profile)).toEqual([])
    // Nothing of Cursor's was made in their home.
    expect(existsSync(join(person.home, '.cursor', 'sdk'))).toBe(false)
  }, 90_000)

  it('control: with every settings layer on, the same SDK runs their hooks and MCP servers and asks for their plugins', async () => {
    const { person, markers } = personWithSetup()
    const stub = await cursorStub('http503')
    cleanups.push(() => stub.close())
    // A project folder under Mousse's profile, as a place is.
    const work = join(person.profile, 'one-shot-control', 'work')
    mkdirSync(work, { recursive: true })
    cursorConfig(work, markers, 'CWD')
    const script = join(person.root, 'control.cjs')
    writeFileSync(script, `
const sdk = require(${JSON.stringify(cursorSdkEntry())})
;(async () => {
  const agent = await sdk.Agent.create({ apiKey: ${JSON.stringify(DUMMY_KEY)}, model: { id: "default" }, tools: [], local: { cwd: ${JSON.stringify(work)}, store: new sdk.JsonlLocalAgentStore(${JSON.stringify(join(person.root, 'store'))}), settingSources: ['all'], autoReview: false, enableAgentRetries: false } })
  const run = await agent.send({ text: 'PROMPT_LINE_7f3a' })
  await run.wait()
  agent.close()
  setTimeout(() => process.exit(0), 1500)
})().catch((error) => { console.error(error); process.exit(1) })
`)
    const log = await new Promise<string>((resolve) => {
      const child = spawn(process.execPath, [script], { env: { ...process.env, ...person.env, CURSOR_BACKEND_URL: stub.url, CURSOR_API_KEY: '' }, stdio: ['ignore', 'pipe', 'pipe'] })
      let output = ''
      child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString() })
      child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString() })
      child.on('close', () => resolve(output))
    })
    const ran = readdirSync(markers)
    expect(ran, log.slice(-1500)).toEqual(expect.arrayContaining(['hook-sessionStart-USER', 'hook-beforeSubmitPrompt-USER', 'mcp-USER', 'hook-sessionStart-CWD', 'mcp-CWD']))
    expect(stub.count('GetEffectiveUserPlugins')).toBeGreaterThan(0)
    expect(log).toMatch(/LocalCursorRulesService load completed meta=\{[^}]*ruleCount: [1-9]/)
  }, 90_000)
})

describe('cursor:sdk sends a failed request once (real SDK at a stub)', () => {
  const cases: Array<[RunFailure, string]> = [
    ['http503', 'unavailable'],
    ['http429', 'rate_limited'],
    ['stream_unavailable', 'unavailable'],
    ['stream_resource_exhausted', 'rate_limited']
  ]
  it.each(cases)('%s: one run and one message on the wire', async (failure, kind) => {
    const person = cursorPerson()
    cleanups.push(person.remove)
    const stub = await cursorStub(failure)
    cleanups.push(() => stub.close())
    const runtime = cursorRuntime({ person, hostScript, stub })
    cleanups.push(() => runtime.stop())
    const { sent } = sendCursorOnce(runtime)
    const error = await sent.then(() => undefined, (failure: unknown) => failure)
    expect(classifyOneShotFailure(error)).toBe(kind)
    expect(stub.count('/RunSSE')).toBe(1)
    expect(stub.count('/BidiAppend')).toBe(1)
    expect(placesLeft(person.profile)).toEqual([])
  }, 90_000)
})
