/**
 * The single-request core (docs/plans/one-shots-every-provider.md §1–3, §5): admission from cached state, the label
 * computed from a route's facts, the runner's identity check and bounds, its failure table, the sealed environment and
 * the post-ready sweep of places. Tables at the modules that decide; the end-to-end route is `acpOneShotRoute.test.ts`.
 */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { admit, isPlan, routeLabel, type AdmissionEntry, type OneShotBinding, type OneShotPlan } from '../../src/mms/harness/oneShot/admission'
import { RESERVED_ROOTS, sealedEnv } from '../../src/mms/harness/oneShot/launch'
import type { OneShotOp, OneShotRouteDecision, OneShotTransport, RouteFacts } from '../../src/mms/harness/oneShot/route'
import { GENERIC_ACP_FACTS, PI_DIRECT_FACTS, PI_LOCAL_FACTS } from '../../src/mms/harness/oneShot/routes'
import { candidateDeadlineMs, classifyOneShotFailure, executableKey, ONE_SHOT_INACTIVITY_MS, ONE_SHOT_INSTRUCTION, ONE_SHOT_STREAM_CAP, oneShotWasSent, runPlan } from '../../src/mms/harness/oneShot/runner'
import { ANTIGRAVITY_LEFTOVER_RULES, sweepLegacyAntigravityOneShots } from '../../src/mms/harness/acp/presets/antigravity/oneShotGuards'
import { PLACE_SWEEP_DELAY_MS, PLACE_SWEEP_INTERVAL_MS, schedulePlaceSweep } from '../../src/mms/harness/oneShot/sweep'
import { usageLimitError } from '../../src/mms/orchestrator/providerErrors'
import { harnessAppError } from '../../src/shared/harness/types'

const homes: string[] = []
afterEach(() => {
  vi.useRealTimers()
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

const IDENTITY = { instanceId: 'x', runtime: 'acp|1|home', executable: executableKey({ path: '/bin/agent', size: 10, mtimeMs: 1 })!, facts: '5' }

function entry(patch: Partial<AdmissionEntry> & { decision?: OneShotRouteDecision | undefined; hidden?: boolean; local?: boolean } = {}): AdmissionEntry {
  const { decision: given, hidden = false, local = false, ...rest } = patch
  const decision = 'decision' in patch ? given : { route: { id: 'acp:generic' as const, facts: GENERIC_ACP_FACTS } }
  return {
    instanceId: 'x', label: 'Agent', enabled: true, retired: false, stopped: false, signedOut: false, locked: false, checked: true,
    route: () => decision,
    model: () => ({ hidden, local }),
    identity: () => ({ ...IDENTITY }),
    ...rest
  }
}
const view = (value: AdmissionEntry | undefined) => ({ entry: () => value })
const MODEL: OneShotBinding = { kind: 'model', instanceId: 'x', model: 'm' }
const LOCAL = (resident: boolean): OneShotBinding => ({ kind: 'local_thread', instanceId: 'x', model: 'm', resident })

describe('admit', () => {
  // Inputs: the entry (gone, retired, off, stopped, bot-only, signed out, unchecked), its route (none, refused,
  // in-process, launched), the model (hidden, a local server's), the binding (a model, a local thread warm or cold)
  // and the operation (a thread's, a bot's).
  const rows: Array<[string, OneShotOp, OneShotBinding, AdmissionEntry | undefined, string | 'plan']> = [
    ['an entry that is gone', 'thread_title', MODEL, undefined, 'unknown_entry'],
    ['a retired entry', 'thread_title', MODEL, entry({ retired: true }), 'retired'],
    ['a turned-off entry', 'thread_title', MODEL, entry({ enabled: false }), 'disabled'],
    ['an entry stopped while requests ran', 'thread_title', MODEL, entry({ stopped: true }), 'stopped'],
    ['a bot-only entry, for a thread', 'thread_title', MODEL, entry({ locked: true }), 'locked'],
    ['a bot-only entry, for a bot\u2019s name', 'bot_name', MODEL, entry({ locked: true }), 'plan'],
    ['a bot-only entry, for a bot\u2019s digest', 'bot_digest', MODEL, entry({ locked: true }), 'plan'],
    ['a signed-out entry', 'thread_title', MODEL, entry({ signedOut: true }), 'signed_out'],
    ['a driver with no route', 'thread_title', MODEL, entry({ decision: undefined }), 'no_route'],
    ['a refused route', 'thread_title', MODEL, entry({ decision: { refused: 'Not proven for 9.9.9.' } }), 'refused'],
    ['a launched route before its check', 'thread_title', MODEL, entry({ checked: false }), 'unchecked'],
    ['an in-process route before any check', 'thread_title', MODEL, entry({ checked: false, decision: { route: { id: 'pi:direct', facts: PI_DIRECT_FACTS } } }), 'plan'],
    ['a hidden model', 'thread_title', MODEL, entry({ hidden: true }), 'model_hidden'],
    ['a local server\u2019s model for another thread', 'thread_title', MODEL, entry({ decision: { route: { id: 'pi:direct', facts: PI_LOCAL_FACTS } } }), 'local_only'],
    ['a local server\u2019s model listed local on a route for any thread', 'branch_name', MODEL, entry({ local: true, decision: { route: { id: 'pi:direct', facts: PI_DIRECT_FACTS } } }), 'local_only'],
    ['its own local thread, model in memory', 'thread_title', LOCAL(true), entry({ decision: { route: { id: 'pi:direct', facts: PI_LOCAL_FACTS } } }), 'plan'],
    ['its own local thread, model not loaded', 'thread_title', LOCAL(false), entry({ decision: { route: { id: 'pi:direct', facts: PI_LOCAL_FACTS } } }), 'local_unloaded'],
    ['a local thread whose entry is gone', 'thread_title', LOCAL(true), undefined, 'unknown_entry'],
    ['a local thread whose entry is no longer local', 'thread_title', LOCAL(true), entry(), 'not_local'],
    ['a generic ACP agent, checked', 'thread_title', MODEL, entry(), 'plan']
  ]
  it.each(rows)('%s', (_name, op, binding, value, expected) => {
    const result = admit(op, binding, view(value))
    if (expected === 'plan') expect(isPlan(result)).toBe(true)
    else expect(result).toMatchObject({ notAdmitted: expected, reason: expect.any(String) })
  })

  it('a refused route keeps its own reason', () => {
    expect(admit('thread_title', MODEL, view(entry({ decision: { refused: 'Not proven for 9.9.9.' } })))).toMatchObject({ reason: 'Not proven for 9.9.9.' })
  })

  it('a plan is immutable and carries the identity admission read', () => {
    const plan = admit('thread_title', { ...MODEL, effort: 'low' }, view(entry())) as OneShotPlan
    expect(plan).toMatchObject({ op: 'thread_title', instanceId: 'x', model: 'm', effort: 'low', label: 'best_effort', route: { id: 'acp:generic' }, identity: IDENTITY })
    expect(Object.isFrozen(plan) && Object.isFrozen(plan.route) && Object.isFrozen(plan.route.facts) && Object.isFrozen(plan.identity)).toBe(true)
  })
})

describe('the label is computed from the facts', () => {
  const held: RouteFacts = { ...PI_DIRECT_FACTS }
  it.each<[string, RouteFacts, string]>([
    ['none offered, one attempt, verified', held, 'held'],
    ['tools detected on report', { ...held, tools: 'detected_on_report' }, 'best_effort'],
    ['tools refused before they run', { ...held, tools: 'refused_before_run' }, 'best_effort'],
    ['attempts unenforced', { ...held, attempts: 'unenforced' }, 'best_effort'],
    ['only the environment redirected', { ...held, isolation: 'env_only' }, 'best_effort'],
    ['a launch kind alone does not lower it', { ...held, launch: 'sealed_child' }, 'held'],
    ['generic ACP', GENERIC_ACP_FACTS, 'best_effort']
  ])('%s', (_name, facts, label) => {
    expect(routeLabel({ facts })).toBe(label)
  })
})

describe('the runner', () => {
  const plan = (facts: RouteFacts = GENERIC_ACP_FACTS) => admit('thread_title', MODEL, view(entry({ decision: { route: { id: 'acp:generic', facts } } }))) as OneShotPlan
  function transport(script: (events: Parameters<OneShotTransport['send']>[1], signal: AbortSignal) => Promise<string>) {
    const sent: Array<Parameters<OneShotTransport['send']>[0]> = []
    const signals: AbortSignal[] = []
    return { sent, signals, transport: { send: vi.fn(async (wire, events, signal: AbortSignal) => { sent.push(wire); signals.push(signal); return script(events, signal) }) } satisfies OneShotTransport }
  }
  const run = (t: OneShotTransport, patch: Partial<Parameters<typeof runPlan>[0]> = {}) =>
    runPlan({ plan: plan(), transport: t, live: () => ({ ...IDENTITY }), label: 'Agent', system: 'You name chats.', prompt: 'fix the login bug', maxChars: 80, ...patch })
  const untilAborted = (signal: AbortSignal) => new Promise<string>((_, reject) => {
    if (signal.aborted) reject(new Error('stopped'))
    else signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true })
  })

  it('sends once, opening with the no-tools line on a route that can be offered tools, and cuts the answer to maxChars', async () => {
    const t = transport(async () => 'OAuth callback loop')
    expect(await run(t.transport, { maxChars: 5 })).toBe('OAuth')
    expect(t.transport.send).toHaveBeenCalledTimes(1)
    expect(t.sent[0]).toMatchObject({ model: 'm', instruction: ONE_SHOT_INSTRUCTION, system: 'You name chats.', prompt: 'fix the login bug' })
    const none = transport(async () => 'A title')
    await run(none.transport, { plan: plan(PI_DIRECT_FACTS) })
    expect(none.sent[0]!.instruction).toBeUndefined()
  })

  it.each([
    ['the runtime was rebuilt', { runtime: 'acp|2|home' }],
    ['the executable changed since its check', { executable: executableKey({ path: '/bin/agent', size: 11, mtimeMs: 2 }) }],
    ['the sign-in changed', { credential: 'another' }],
    ['the facts were read again', { facts: '6' }]
  ])('refuses before sending when %s', async (_name, change) => {
    const t = transport(async () => 'A title')
    await expect(run(t.transport, { live: () => ({ ...IDENTITY, ...change }) })).rejects.toMatchObject({ code: 'binding_stale' })
    await expect(run(t.transport, { live: () => undefined })).rejects.toMatchObject({ code: 'binding_stale' })
    expect(t.transport.send).not.toHaveBeenCalled()
  })

  it('checks again at the boundary: a program that resolves to another file, or a sign-in that changed during preparation, stops the request unsent', async () => {
    const program = { path: '/bin/agent', size: 10, mtimeMs: 1 }
    const launched = vi.fn()
    const launch = (resolved: { path: string; size: number; mtimeMs: number }) => transport(async (events) => { events.launching(resolved.path); launched(); events.sending(); return 'A title' })
    const files = new Map([[program.path, program], ['/opt/other-agent', { path: '/opt/other-agent', size: 10, mtimeMs: 1 }]])
    const fingerprint = (path: string) => files.get(path)
    expect(await run(launch(program).transport, { fingerprint })).toBe('A title')
    const other = await run(launch(files.get('/opt/other-agent')!).transport, { fingerprint }).catch((caught: unknown) => caught)
    expect(other).toMatchObject({ code: 'binding_stale' })
    expect(oneShotWasSent(other)).toBe(false)
    expect(launched).toHaveBeenCalledTimes(1)
    // The sign-in changes while the transport reads its credential: the request never leaves.
    let generation = 0
    const reading = transport(async (events) => { generation++; events.sending(); return 'A title' })
    const signedAgain = await run(reading.transport, { live: () => ({ ...IDENTITY, ...(generation ? { credential: 'api_key|2|' } : {}) }) }).catch((caught: unknown) => caught)
    expect(signedAgain).toMatchObject({ code: 'binding_stale' })
    expect(oneShotWasSent(signedAgain)).toBe(false)
  })

  it('a tool the provider reports ends the request as detected, and stops the transport', async () => {
    const t = transport(async (events, signal) => { events.tool('Run command'); return untilAborted(signal) })
    const error = await run(t.transport).catch((caught: unknown) => caught)
    expect(error).toMatchObject({ code: 'one_shot_tool_refused' })
    expect(classifyOneShotFailure(error)).toBe('tool_detected')
    expect(t.signals[0]!.aborted).toBe(true)
  })

  it('an answer streaming past the cap ends the request', async () => {
    const t = transport(async (events, signal) => { events.text('x'.repeat(ONE_SHOT_STREAM_CAP)); events.text('y'); return untilAborted(signal) })
    const error = await run(t.transport).catch((caught: unknown) => caught)
    expect(classifyOneShotFailure(error)).toBe('too_long')
    expect(t.signals[0]!.aborted).toBe(true)
  })

  it('an answer with no text fails as empty', async () => {
    const error = await run(transport(async () => '  \n').transport).catch((caught: unknown) => caught)
    expect(classifyOneShotFailure(error)).toBe('empty')
  })

  it('ends past its deadline, and past the inactivity bound, which each sign of life restarts', async () => {
    vi.useFakeTimers()
    const late = transport(async (_events, signal) => untilAborted(signal))
    const ending = run(late.transport, { deadlineMs: 15_000 }).catch((caught: unknown) => caught)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(await ending).toMatchObject({ code: 'timeout' })

    let events!: Parameters<OneShotTransport['send']>[1]
    const quiet = transport(async (given, signal) => { events = given; return untilAborted(signal) })
    const pending = run(quiet.transport, { deadlineMs: 10 * ONE_SHOT_INACTIVITY_MS }).catch((caught: unknown) => caught)
    await vi.advanceTimersByTimeAsync(ONE_SHOT_INACTIVITY_MS - 1)
    events.activity()
    await vi.advanceTimersByTimeAsync(ONE_SHOT_INACTIVITY_MS - 1)
    expect(quiet.signals[0]!.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await pending).toMatchObject({ code: 'timeout', message: expect.stringContaining('sent nothing') })
  })

  it('settles at its deadline even while the transport is still tearing down, so the next candidate keeps its time', async () => {
    vi.useFakeTimers()
    // A transport that ignores the stop and never settles (a slow teardown).
    const stuck = transport(async () => new Promise<string>(() => undefined))
    const ending = run(stuck.transport, { deadlineMs: 15_000 }).catch((caught: unknown) => caught)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(await ending).toMatchObject({ code: 'timeout' })
    expect(stuck.signals[0]!.aborted).toBe(true)
  })

  it('a candidate gets the smaller of 15 s and what the pass has left minus 3 s', () => {
    expect([25_000, 18_000, 10_000, 3_000, 1_000].map(candidateDeadlineMs)).toEqual([15_000, 15_000, 7_000, 0, 0])
  })
})

describe('the failure table', () => {
  it.each<[string, unknown, string]>([
    ['a stop', new DOMException('stopped', 'AbortError'), 'cancelled'],
    ['a provider cancel', harnessAppError({ code: 'cancelled', message: 'x' }), 'cancelled'],
    ['a refused tool request', harnessAppError({ code: 'one_shot_tool_refused', message: 'x' }), 'tool_refused'],
    ['a reported tool', harnessAppError({ code: 'one_shot_tool_refused', reason: 'tool_detected', message: 'x' }), 'tool_detected'],
    ['a quota', usageLimitError({ provider: 'claude', resetsAt: new Date(Date.now() + 60 * 60_000).toISOString(), estimated: false, limitKind: 'five_hour' }), 'rate_limited'],
    ['too many requests', harnessAppError({ code: 'rate_limited', message: 'x' }), 'rate_limited'],
    ['retries that ran out below Mousse', harnessAppError({ code: 'protocol', retriesExhausted: true, message: 'x' }), 'retry_detected'],
    ['signed out', harnessAppError({ code: 'signed_out', message: 'x' }), 'signed_out'],
    ['a timeout', harnessAppError({ code: 'timeout', message: 'x' }), 'timeout'],
    ['not admitted', harnessAppError({ code: 'unsupported', reason: 'not_admitted', message: 'x' }), 'not_admitted'],
    ['a stale binding', harnessAppError({ code: 'binding_stale', message: 'x' }), 'not_admitted'],
    ['an empty answer', harnessAppError({ code: 'protocol', reason: 'empty', message: 'x' }), 'empty'],
    ['an overlong answer', harnessAppError({ code: 'protocol', reason: 'too_long', message: 'x' }), 'too_long'],
    ['a model the entry no longer runs', harnessAppError({ code: 'model_unavailable', message: 'x' }), 'unavailable'],
    ['anything else', new Error('socket hang up'), 'unavailable']
  ])('%s', (_name, error, kind) => {
    expect(classifyOneShotFailure(error)).toBe(kind)
  })
})

describe('the sealed environment', () => {
  it('keeps only the allowlist, then the entry and the preset, and points every root into the place last', () => {
    const root = mkdtempSync(join(tmpdir(), 'mousse-sealed-'))
    homes.push(root)
    const env = sealedEnv({
      base: { Path: '/usr/bin', HTTPS_PROXY: 'http://proxy', LANG: 'en_US.UTF-8', GITHUB_TOKEN: 'ghp_x', HOME: '/home/me', APPDATA: 'C:\\Users\\me\\AppData\\Roaming' },
      entry: { AGENT_API_KEY: 'k', home: '/elsewhere', Xdg_Config_Home: '/elsewhere/.config' },
      preset: { AGENT_TELEMETRY: '0', TMP: '/tmp/outside' },
      root
    })
    expect(env).toMatchObject({ Path: '/usr/bin', HTTPS_PROXY: 'http://proxy', LANG: 'en_US.UTF-8', AGENT_API_KEY: 'k', AGENT_TELEMETRY: '0' })
    expect(env.GITHUB_TOKEN).toBeUndefined()
    for (const name of RESERVED_ROOTS) {
      const spellings = Object.keys(env).filter((key) => key.toUpperCase() === name)
      expect(spellings, name).toEqual([name])
      expect(relative(root, env[name]!).startsWith('..'), name).toBe(false)
      expect(existsSync(env[name]!), name).toBe(true)
    }
  })
})

/** What a daemon killed before its request's process started leaves: a reserved record and an empty place, an hour old. */
function leftover(profile: string): { dir: string } {
  const id = randomUUID()
  const dir = join(profile, 'one-shot', id)
  const ledger = join(profile, 'one-shot-ledger', `${id}.json`)
  mkdirSync(dir, { recursive: true })
  mkdirSync(join(profile, 'one-shot-ledger'), { recursive: true })
  const hourAgo = Date.now() - 60 * 60_000
  writeFileSync(ledger, JSON.stringify({ v: 1, id, state: 'reserved', route: 'acp:generic', instanceId: 'acp:x', createdAt: hourAgo, updatedAt: hourAgo }))
  utimesSync(ledger, new Date(hourAgo), new Date(hourAgo))
  utimesSync(dir, new Date(hourAgo), new Date(hourAgo))
  return { dir }
}

describe('the post-ready sweep', () => {
  it('removes what an ended request left a minute after ready, with no naming request, and not before', async () => {
    const profile = mkdtempSync(join(tmpdir(), 'mousse-sweep-'))
    homes.push(profile)
    // A daemon killed before the request's process started: its record and its folder, an hour old.
    const place = leftover(profile)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let done!: () => void
    const swept = new Promise<void>((resolve) => { done = resolve })
    schedulePlaceSweep(profile, { stopped: () => false, done: () => done() })
    await vi.advanceTimersByTimeAsync(PLACE_SWEEP_DELAY_MS - 1)
    expect(existsSync(place.dir)).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    vi.useRealTimers()
    await swept
    expect(readdirSync(join(profile, 'one-shot'))).toEqual([])
    expect(readdirSync(join(profile, 'one-shot-ledger'))).toEqual([])
  })

  it('runs again while the daemon runs: what an ended request leaves later is removed at the next sweep', async () => {
    const profile = mkdtempSync(join(tmpdir(), 'mousse-sweep-'))
    homes.push(profile)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const reports: unknown[] = []
    let swept!: () => void
    let sweep = new Promise<void>((resolve) => { swept = resolve })
    const cancel = schedulePlaceSweep(profile, { stopped: () => false, done: (report) => { reports.push(report); swept() } })
    await vi.advanceTimersByTimeAsync(PLACE_SWEEP_DELAY_MS)
    await sweep
    // Left after the first sweep, by a request that ended badly an hour into a long-running daemon.
    const place = leftover(profile)
    sweep = new Promise<void>((resolve) => { swept = resolve })
    await vi.advanceTimersByTimeAsync(PLACE_SWEEP_INTERVAL_MS)
    await sweep
    cancel()
    expect(reports).toHaveLength(2)
    expect(existsSync(place.dir)).toBe(false)
  })

  it("cleans what Antigravity's older versions left in its own folders in the same pass, with no naming request", async () => {
    const profile = mkdtempSync(join(tmpdir(), 'mousse-sweep-'))
    homes.push(profile)
    // A single request of an older version, in the first entry's state folder, left by a daemon that ended mid-request.
    const old = join(profile, 'providers', 'antigravity', 'one-shot', '00000000-0000-4000-8000-00000000000a')
    mkdirSync(old, { recursive: true })
    const hourAgo = (Date.now() - 60 * 60_000) / 1000
    utimesSync(old, hourAgo, hourAgo)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let swept!: () => void
    const sweep = new Promise<void>((resolve) => { swept = resolve })
    // As the daemon schedules it (`MmsProfileServices`).
    const cancel = schedulePlaceSweep(profile, { stopped: () => false, rules: ANTIGRAVITY_LEFTOVER_RULES, also: () => sweepLegacyAntigravityOneShots(profile), done: () => swept() })
    await vi.advanceTimersByTimeAsync(PLACE_SWEEP_DELAY_MS)
    await sweep
    cancel()
    expect(existsSync(old)).toBe(false)
  })

  it('does not run once the daemon is stopping, or once cancelled', async () => {
    const profile = mkdtempSync(join(tmpdir(), 'mousse-sweep-'))
    homes.push(profile)
    const place = leftover(profile)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const done = vi.fn()
    schedulePlaceSweep(profile, { stopped: () => true, done })
    const cancel = schedulePlaceSweep(profile, { stopped: () => false, done })
    cancel()
    await vi.advanceTimersByTimeAsync(PLACE_SWEEP_DELAY_MS)
    expect(done).not.toHaveBeenCalled()
    expect(existsSync(place.dir)).toBe(true)
  })
})
