import { describe, expect, it, vi } from 'vitest'
import type { ModelUsage, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import {
  ClaudeMetricsCollector,
  ClaudeNativeEditCounter
} from '../src/mms/providers/claudeSubscription/metrics'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const model = (input = 10, output = 5, cost = 0.1): ModelUsage => ({
  inputTokens: input,
  outputTokens: output,
  cacheReadInputTokens: 20,
  cacheCreationInputTokens: 3,
  webSearchRequests: 0,
  costUSD: cost,
  contextWindow: 200_000,
  maxOutputTokens: 32000
})
const result = (models: Record<string, ModelUsage>, uuid = 'r1', session = 'session', cost = 0.1) =>
  ({
    type: 'result',
    uuid,
    session_id: session,
    modelUsage: models,
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 2,
      cache_creation_input_tokens: 1
    },
    total_cost_usd: cost
  }) as SDKMessage
const assistant = (id = 'a1', parent: string | null = null, output = 4) =>
  ({
    type: 'assistant',
    uuid: id,
    session_id: 'session',
    parent_tool_use_id: parent,
    message: {
      id,
      model: 'claude-opus-4-7',
      usage: {
        input_tokens: 12,
        output_tokens: output,
        cache_read_input_tokens: 50,
        cache_creation_input_tokens: 7
      }
    }
  }) as SDKMessage

describe('Claude measured metrics', () => {
  it('subtracts persisted cumulative multi-model tokens and estimated costs on resume', () => {
    const collector = new ClaudeMetricsCollector('session', {
      sessionId: 'session',
      modelUsage: { main: model(100, 30, 1), sub: model(20, 5, 0.2) },
      totalCost: 1.2
    })
    collector.observe(
      result({ main: model(110, 40, 1.1), sub: model(30, 10, 0.3) }, 'new', 'session', 1.4)
    )
    expect(collector.report().usage).toMatchObject({
      input: 20,
      output: 15,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 35,
      cost: { total: expect.closeTo(0.2) }
    })
  })
  it('deduplicates results and carries cumulative baselines across steered queries', () => {
    const collector = new ClaudeMetricsCollector()
    const first = result({ main: model() })
    collector.observe(first)
    collector.observe(first)
    collector.beginQuery('session')
    collector.observe(result({ main: model(15, 8, 0.15) }, 'r2', 'session', 0.15))
    expect(collector.report().usage).toMatchObject({
      input: 15,
      output: 8,
      cacheRead: 20,
      cacheWrite: 3,
      cost: { total: 0.15 }
    })
    const resumed = new ClaudeMetricsCollector('session', collector.snapshot())
    resumed.observe(result({ main: model(20, 10, 0.2) }, 'r3', 'session', 0.2))
    expect(resumed.report().usage).toMatchObject({
      input: 5,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      cost: { total: expect.closeTo(0.05) }
    })
  })
  it('does not charge prior whole session when resumed baseline is unknown', () => {
    const collector = new ClaudeMetricsCollector('session')
    collector.observe(result({ main: model(100000, 5000, 30) }, 'old-resume', 'session', 30))
    expect(collector.report()).toMatchObject({
      usageScope: 'main-turn',
      usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, cost: { total: 0 } }
    })
    collector.beginQuery('session')
    collector.observe(result({ main: model(100010, 5005, 30.1) }, 'next', 'session', 30.1))
    expect(collector.report().usage!.input).toBe(20)
  })
  it('recognizes a cleared ledger and starts a fresh query without old subtraction', () => {
    const collector = new ClaudeMetricsCollector('session', {
      sessionId: 'session',
      modelUsage: { main: model(1000, 100, 3) },
      totalCost: 3
    })
    collector.observe(result({ main: model() }, 'reset'))
    expect(collector.report().usage!.input).toBe(10)
    collector.beginQuery()
    collector.observe(result({ main: model() }, 'fresh', 'fresh-session'))
    expect(collector.report().usage!.input).toBe(20)
  })
  it('uses latest main assistant occupancy, real matching capacity and excludes nested agents', () => {
    const collector = new ClaudeMetricsCollector()
    collector.observe(assistant())
    collector.observe(assistant('nested', 'parent', 999))
    collector.observe(result({ 'claude-opus-4-7': model() }))
    expect(collector.report()).toMatchObject({
      realModelName: 'claude-opus-4-7',
      context: {
        input: 12,
        cacheRead: 50,
        cacheWrite: 7,
        contextWindow: 200000,
        modelName: 'claude-opus-4-7'
      }
    })
    expect(collector.report().usage!.output).toBe(5)
  })
  it('reports only measured assistant usage if a turn aborts before a result, deduplicating blocks', () => {
    const collector = new ClaudeMetricsCollector()
    collector.observe(assistant('same', null, 2))
    collector.observe(assistant('same', null, 4))
    collector.observe(assistant('nested', 'parent', 999))
    expect(collector.report()).toMatchObject({
      usageScope: 'assistant',
      usage: { input: 12, output: 4, cacheRead: 50, cacheWrite: 7 }
    })
    expect(collector.report().context?.contextWindow).toBeUndefined()
  })
  it('credits already measured partial assistant usage before the next cumulative steer result', () => {
    const collector = new ClaudeMetricsCollector('session', { sessionId: 'session', modelUsage: { 'claude-opus-4-7': model(100, 20, 1) }, totalCost: 1 })
    collector.observe(assistant('partial', null, 4))
    collector.beginQuery('session')
    collector.observe(result({ 'claude-opus-4-7': { ...model(117, 27, 1.2), cacheReadInputTokens: 73, cacheCreationInputTokens: 11 } }, 'after-steer', 'session', 1.2))
    expect(collector.report().usage).toMatchObject({ input: 17, output: 7, cacheRead: 53, cacheWrite: 8, cost: { total: expect.closeTo(0.2) } })
  })
  it('persists partial accounting credits for restart and consumes them exactly once', () => {
    const baseline = { sessionId: 'session', modelUsage: { 'claude-opus-4-7': model(100, 20, 1) }, totalCost: 1 }
    const first = new ClaudeMetricsCollector('session', baseline)
    first.observe(assistant('partial', null, 4))
    expect(first.report().usage!.input).toBe(12)
    const restarted = new ClaudeMetricsCollector('session', first.snapshot())
    restarted.observe(result({ 'claude-opus-4-7': { ...model(117, 27, 1.2), cacheReadInputTokens: 73, cacheCreationInputTokens: 11 } }, 'after-restart', 'session', 1.2))
    expect(restarted.report().usage).toMatchObject({ input: 5, output: 3, cacheRead: 3, cacheWrite: 1, cost: { total: expect.closeTo(0.2) } })
    restarted.beginQuery('session')
    restarted.observe(result({ 'claude-opus-4-7': { ...model(118, 28, 1.3), cacheReadInputTokens: 73, cacheCreationInputTokens: 11 } }, 'next-restart', 'session', 1.3))
    expect(restarted.report().usage).toMatchObject({ input: 6, output: 4 })
  })
  it('preserves measured assistant usage when the error result is zeroed', () => {
    const collector = new ClaudeMetricsCollector()
    collector.observe(assistant())
    collector.observe({ ...result({}), is_error: true, usage: { input_tokens: 0, output_tokens: 0 } } as SDKMessage)
    expect(collector.report()).toMatchObject({ usageScope: 'assistant', usage: { input: 12, output: 4 } })
  })
  it('does not fabricate usage, speed or capacity when SDK reported none', () => {
    expect(new ClaudeMetricsCollector().report()).toMatchObject({ usage: null })
    expect(new ClaudeMetricsCollector().report().totalTokensUsed).toBeUndefined()
  })
})

describe('Claude native file edit accounting', () => {
  it('counts successful Write/Edit/MultiEdit once and ignores failure, shell and oversized files', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'claude-edit-count-'))
    const counts = vi.fn()
    const counter = new ClaudeNativeEditCounter(cwd, counts)
    try {
      writeFileSync(join(cwd, 'file'), 'old\nline')
      await counter.start('edit', 'Edit', { file_path: 'file' })
      writeFileSync(join(cwd, 'file'), 'new\nline')
      await counter.success('edit')
      await counter.success('edit')
      await counter.start('failed', 'Write', { file_path: 'file' })
      writeFileSync(join(cwd, 'file'), 'ignored')
      counter.failure('failed')
      await counter.success('failed')
      await counter.start('shell', 'Bash', { command: 'write file', file_path: 'file' })
      writeFileSync(join(cwd, 'file'), 'shell')
      await counter.success('shell')
      await counter.start('new', 'Write', { file_path: 'new' })
      writeFileSync(join(cwd, 'new'), 'one\ntwo')
      await counter.success('new')
      await counter.start('multi', 'MultiEdit', { file_path: 'new' })
      writeFileSync(join(cwd, 'new'), 'changed\ntwo')
      await counter.success('multi')
      writeFileSync(join(cwd, 'huge'), Buffer.alloc(2 * 1024 * 1024 + 1, 65))
      await counter.start('huge', 'Edit', { file_path: 'huge' })
      writeFileSync(join(cwd, 'huge'), 'tiny')
      await counter.success('huge')
      expect(counts.mock.calls.map(([lines]) => lines)).toEqual([1, 2, 1])
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})
