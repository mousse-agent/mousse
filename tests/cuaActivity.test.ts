/**
 * What a transcript keeps of a computer use call (`src/shared/cuaActivity.ts`): which calls count, in every runtime's
 * spelling and through a bot's `use_tool`; what of their arguments and results survives; and the words a row shows.
 * The end-to-end path (provider events → saved row → rendered row) is `tests/run/cuaTranscriptPrivacy.test.ts`.
 */
import { describe, expect, it } from 'vitest'
import {
  classifyCuaCall,
  cuaCallWords,
  cuaFailureLabel,
  guardedTitle,
  sanitizeCuaInput,
  sanitizeCuaOutput,
  useToolTargetOf
} from '../src/shared/cuaActivity'

const SECRET = 'hunter2-SECRET-7f3a'

describe('which calls are computer use calls', () => {
  // Every name a runtime gives a Mousse tool (`mousseServerToolOf`), and a bare name (Pi, Cursor without a server).
  it.each([
    ['mcp__mousse__computer_use', 'computer_use'],
    ['mcp_mousse_computer_use', 'computer_use'],
    // OpenCode: `<server>_<tool>`, the server being this thread's `mousse_<12 hex>`.
    ['mousse_0123456789ab_computer_use', 'computer_use'],
    ['mousse_0123456789ab_computer_use_request', 'computer_use_request'],
    ['mousse__computer_tools', 'computer_tools'],
    ['mousse.computer_use', 'computer_use'],
    ['mousse/computer_use_request', 'computer_use_request'],
    ['mousse: computer_use', 'computer_use'],
    ['computer_use_request (mousse MCP Server)', 'computer_use_request'],
    ['computer_use', 'computer_use'],
    ['  computer_tools  ', 'computer_tools']
  ])('%s', (name, tool) => {
    expect(classifyCuaCall(name)).toEqual({ kind: 'cua', tool })
  })

  it.each([
    ['a relayed tool of the same name', 'mcp__mousse-relay__computer_use'],
    ['a relayed tool of the same name on OpenCode', 'mousse_0123456789ab_relay_computer_use'],
    ['another server', 'mcp__other__computer_use'],
    ['a sentence', 'Computer use'],
    ['an ordinary Mousse tool', 'mcp__mousse__thread_list']
  ])('not %s', (_label, name) => {
    expect(classifyCuaCall(name)).toEqual({ kind: 'other' })
  })

  // `useToolCall`'s rules: `tool` trimmed and without `mcp__mousse__`; any other Mousse spelling read too.
  it.each([
    ['a bare name', { tool: 'computer_use', arguments: {} }, { kind: 'use_tool_cua', tool: 'computer_use' }],
    ['the MCP name, padded', { tool: '  mcp__mousse__computer_use ', arguments: { tool: 'click' } }, { kind: 'use_tool_cua', tool: 'computer_use' }],
    ["Antigravity's name", { tool: 'mcp_mousse_computer_tools' }, { kind: 'use_tool_cua', tool: 'computer_tools' }],
    ['arguments null (read as none)', { tool: 'computer_use_request', arguments: null }, { kind: 'use_tool_cua', tool: 'computer_use_request' }],
    ['another tool', { tool: 'thread_list', arguments: {} }, { kind: 'use_tool_other', inner: 'thread_list' }],
    ['tool missing', { arguments: { tool: 'computer_use' } }, { kind: 'use_tool_pending' }],
    ['tool not a string', { tool: 7, arguments: {} }, { kind: 'use_tool_pending' }],
    ['tool empty', { tool: '   ', arguments: {} }, { kind: 'use_tool_pending' }],
    ['arguments a string', { tool: 'thread_list', arguments: 'x' }, { kind: 'use_tool_pending' }],
    ['arguments a list', { tool: 'thread_list', arguments: [] }, { kind: 'use_tool_pending' }],
    ['no arguments at all', undefined, { kind: 'use_tool_pending' }],
    ['arguments cut to fit when saved', { truncated: true, preview: '{"tool":"computer_use"' }, { kind: 'use_tool_pending' }]
  ])("a bot's use_tool: %s", (_label, input, expected) => {
    expect(classifyCuaCall('mcp__mousse__use_tool', { input })).toEqual(expected)
  })

  it('a use_tool target the runtime read stands in for arguments it has not sent, and either naming computer use is enough', () => {
    expect(classifyCuaCall('use_tool', { useToolTarget: 'mcp__mousse__computer_use' })).toEqual({ kind: 'use_tool_cua', tool: 'computer_use' })
    expect(classifyCuaCall('use_tool', { useToolTarget: 'thread_list', input: { tool: 'computer_use' } })).toEqual({ kind: 'use_tool_cua', tool: 'computer_use' })
    expect(useToolTargetOf({ tool: ' mousse.computer_use ' })).toBe('computer_use')
  })
})

describe('what a row keeps of the arguments', () => {
  it('computer_use keeps where and which, never what is typed, pasted or run', () => {
    const kept = sanitizeCuaInput('computer_use', {
      tool: 'type_text',
      arguments: {
        x: 420, y: 180, button: 'left', app: 'Notes', keys: ['cmd', 'v'], durationMs: 50,
        text: SECRET, script: SECRET, clipboard: SECRET, password: SECRET, value: SECRET, content: SECRET, data: SECRET,
        width: Number.NaN, title: `  ${'w'.repeat(100)} `, element_token: SECRET
      }
    })
    expect(kept).toEqual({ tool: 'type_text', arguments: { x: 420, y: 180, durationMs: 50, button: 'left', app: 'Notes', keys: ['cmd', 'v'], title: 'w'.repeat(60) } })
  })

  it('run_steps keeps how many steps and their tools, nothing inside them; kept twice it stays the same', () => {
    const steps = [{ tool: 'click', args: { x: 1, y: 2 } }, { tool: 'type_text', args: { text: SECRET } }, { tool: 'run_script', args: { script: SECRET } }]
    const kept = sanitizeCuaInput('computer_use', { tool: 'run_steps', arguments: { steps, observe: { query: SECRET } } })
    expect(kept).toEqual({ tool: 'run_steps', arguments: { stepCount: 3, stepTools: ['click', 'type_text', 'run_script'] } })
    expect(sanitizeCuaInput('computer_use', kept)).toEqual(kept)
  })

  it('computer_tools keeps the tool it asks about, computer_use_request its reason', () => {
    expect(sanitizeCuaInput('computer_tools', { tool: 'click', extra: SECRET })).toEqual({ tool: 'click' })
    expect(sanitizeCuaInput('computer_use_request', { reason: 'Open Figma', note: SECRET })).toEqual({ reason: 'Open Figma' })
    expect((sanitizeCuaInput('computer_use_request', { reason: 'r'.repeat(500) }).reason as string).length).toBe(240)
  })
})

describe('what a row keeps of the result', () => {
  it.each([
    ['computer_use', `typed ${SECRET}`, false, 'Completed'],
    ['computer_use', 'Captured screenshot', false, 'Captured screenshot'],
    ['computer_use', 'Captured 3 images', false, 'Captured 3 images'],
    ['computer_use', `Captured screenshot ${SECRET}`, false, 'Completed'],
    ['computer_use', `clipboard was ${SECRET}`, true, 'Computer action failed'],
    ['computer_use', 'Computer use is off in Settings → Computer use.', true, 'Computer use is off'],
    ['computer_use', 'Cua Driver is not installed. Ask the user to install it in Settings → Computer use.', true, 'Driver not installed'],
    ['computer_use', `Error: the action timed out after typing ${SECRET}`, true, 'Action timed out'],
    ['computer_use', `{"refused":{"code":"not_granted","message":"${SECRET}"}}`, true, 'Computer action refused'],
    ['computer_tools', `- click: Clicks.\n- type_text: Types ${SECRET}.`, false, 'Listed 2 tools: click, type_text'],
    ['computer_tools', `click\nClicks at a point ${SECRET}\n\nInput schema: {}`, false, 'Described click'],
    ['computer_use_request', '[computer-use:ready] Computer use is set up on Studio Mac.', false, '[computer-use:ready] Computer use is set up on Studio Mac.'],
    ['computer_use_request', `no marker ${SECRET}`, false, undefined]
  ] as const)('%s: %j (failed: %s) keeps %j', (tool, output, failed, expected) => {
    expect(sanitizeCuaOutput(tool, output, failed)).toBe(expected)
    // Kept again (a saved row read by the window), it stays the same.
    if (expected) expect(sanitizeCuaOutput(tool, expected, failed)).toBe(expected)
  })

  it('a failure with no text, or one that is not text, is the fixed label', () => {
    expect(cuaFailureLabel(undefined)).toBe('Computer action failed')
    expect(sanitizeCuaOutput('computer_use', undefined, true)).toBe('Computer action failed')
  })

  it('a list of many tools stays within 300 characters', () => {
    const listing = Array.from({ length: 80 }, (_, index) => `- tool_number_${index}: Does a thing.`).join('\n')
    const kept = sanitizeCuaOutput('computer_tools', listing)!
    expect(kept.length).toBeLessThanOrEqual(300)
    expect(kept).toMatch(/^Listed 80 tools: tool_number_0, .*, …$/)
  })
})

describe('the words a row shows', () => {
  it.each([
    [{ tool: 'mouse_click', arguments: { x: 420, y: 180, app: 'Notes' } }, { action: 'Mouse click', detail: '(420, 180)' }],
    [{ tool: 'screenshot' }, { action: 'Screenshot' }],
    [{ tool: 'launch_app', arguments: { app: 'Figma' } }, { action: 'Launch app', detail: 'Figma' }],
    [{ tool: 'hotkey', arguments: { keys: ['cmd', 'c'] } }, { action: 'Hotkey', detail: 'cmd+c' }],
    [{ tool: 'run_steps', arguments: { stepCount: 1, stepTools: ['click'] } }, { action: 'Run steps', detail: '1 step' }],
    [{ tool: 'getWindowState' }, { action: 'Get window state' }],
    [{}, {}]
  ])('%j', (input, words) => {
    expect(cuaCallWords('computer_use', input)).toEqual(words)
  })

  it('the title Mousse writes in place of a runtime’s', () => {
    expect(guardedTitle({ kind: 'cua', tool: 'computer_use' }, { tool: 'click' })).toBe('Computer: click')
    expect(guardedTitle({ kind: 'cua', tool: 'computer_use' }, undefined)).toBe('Using the computer')
    expect(guardedTitle({ kind: 'use_tool_cua', tool: 'computer_use' }, { tool: 'computer_use', arguments: { tool: 'zoom' } })).toBe('Computer: zoom')
    expect(guardedTitle({ kind: 'use_tool_pending' })).toBe('Using tool')
  })
})
