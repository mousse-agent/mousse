import { parsePatchFiles } from '@pierre/diffs'
import { describe, expect, it } from 'vitest'
import {
  ACTIVITY_DIFF_CAP_BYTES,
  ACTIVITY_GENERIC_CAP_BYTES,
  ACTIVITY_OUTPUT_CAP_BYTES,
  activityFromToolCall,
  appendTail,
  applyToolResult,
  buildUnifiedDiff,
  byteLength,
  capHead,
  capRecord,
  capTail,
  commandLabel,
  diffAsPatch,
  diffLineCounts,
  diffSides,
  mergeActivityPatch,
  normalizeToolName,
  unifiedDiff,
  type AgentActivityItem
} from '../src/shared/agentActivity'

const startedAt = '2026-01-01T00:00:00.000Z'

const from = (toolName: string, input?: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  activityFromToolCall({ toolName, input, startedAt, ...extra })

describe('activityFromToolCall', () => {
  it('maps every pi tool name to its kind', () => {
    expect(from('bash', { command: 'npm test', cwd: '/repo' })).toMatchObject({
      kind: 'command',
      command: 'npm test',
      cwd: '/repo',
      status: 'running',
      toolName: 'bash'
    })
    expect(from('Bash', { command: 'ls' })).toMatchObject({ kind: 'command', command: 'ls' })
    expect(from('grep', { pattern: 'foo', path: 'src' })).toMatchObject({ kind: 'search', scope: 'code', query: 'foo', path: 'src' })
    expect(from('find', { pattern: '*.ts' })).toMatchObject({ kind: 'search', scope: 'files', query: '*.ts' })
    expect(from('ls', { path: 'src' })).toMatchObject({ kind: 'search', scope: 'files', query: 'src', path: 'src' })
    expect(from('Glob', { pattern: 'src/**' })).toMatchObject({ kind: 'search', scope: 'files', query: 'src/**' })
    expect(from('web_search', { query: 'vitest fake timers' })).toMatchObject({ kind: 'web_search', query: 'vitest fake timers' })
    expect(from('TodoWrite', { todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'in_progress' }, { content: 'c' }] })).toMatchObject({
      kind: 'todo',
      items: [
        { content: 'a', status: 'completed' },
        { content: 'b', status: 'in_progress' },
        { content: 'c', status: 'pending' }
      ]
    })
    expect(from('present_plan', { title: 'Plan', markdown: '# Plan\n- a' })).toMatchObject({ kind: 'plan', text: '# Plan\n- a' })
    expect(from('ExitPlanMode', { plan: 'Do it' })).toMatchObject({ kind: 'plan', text: 'Do it' })
    expect(from('Agent', { subagent_type: 'Explore', description: 'Look around', run_in_background: true })).toMatchObject({
      kind: 'subagent',
      agentType: 'Explore',
      description: 'Look around',
      background: true
    })
  })

  it('builds a real diff for an edit and counts what changed', () => {
    const item = from('edit', { path: 'src/a.ts', edits: [{ oldText: 'one\ntwo', newText: 'one\nthree\nfour' }] })
    expect(item).toMatchObject({ kind: 'file_change' })
    const change = (item as Extract<AgentActivityItem, { kind: 'file_change' }>).changes[0]!
    expect(change).toMatchObject({ path: 'src/a.ts', change: 'update', added: 2, removed: 1 })
    expect(change.diff).toContain('-two')
    expect(change.diff).toContain('+three')
    const legacy = from('Edit', { file_path: 'b.ts', old_string: 'x', new_string: 'y' })
    expect((legacy as Extract<AgentActivityItem, { kind: 'file_change' }>).changes[0]).toMatchObject({ path: 'b.ts', added: 1, removed: 1 })
  })

  it('never fabricates a diff for a write', () => {
    const item = from('write', { path: 'src/new.ts', content: 'a\nb\nc\n' }) as Extract<AgentActivityItem, { kind: 'file_change' }>
    expect(item.kind).toBe('file_change')
    expect(item.changes).toEqual([{ path: 'src/new.ts', change: 'update', diffUnavailable: true, linesWritten: 3 }])
  })

  it('keeps only the bounded record of a Mousse delegation call', () => {
    const item = from('delegate_task', { title: 'Research', prompt: 'SECRET PROMPT TEXT', subagent: 'scout' })
    expect(item).toMatchObject({ kind: 'generic', input: { title: 'Research', subagent: 'scout' } })
    expect(JSON.stringify(item)).not.toContain('SECRET PROMPT TEXT')
    expect(JSON.stringify(from('mcp__mousse__delegate_task', { prompt: 'SECRET PROMPT TEXT' }))).not.toContain('SECRET PROMPT TEXT')
  })

  it('falls back to a generic item with capped input and output', () => {
    const big = 'x'.repeat(ACTIVITY_GENERIC_CAP_BYTES * 3)
    const item = activityFromToolCall({ toolName: 'my_tool', input: { blob: big }, response: big, startedAt }) as Extract<AgentActivityItem, { kind: 'generic' }>
    expect(item.kind).toBe('generic')
    expect(byteLength(JSON.stringify(item))).toBeLessThan(ACTIVITY_GENERIC_CAP_BYTES * 2 + 1024)
    expect(item.input).toMatchObject({ truncated: true })
    expect(byteLength(item.output ?? '')).toBeLessThanOrEqual(ACTIVITY_GENERIC_CAP_BYTES)
    expect(from('read', { path: 'a.ts' })).toMatchObject({ kind: 'generic', input: { path: 'a.ts' } })
    expect(from('mcp__github__list_issues', {})).toMatchObject({ kind: 'generic', server: 'github' })
  })

  it('is generic when the arguments lack what a kind needs', () => {
    expect(from('bash')).toMatchObject({ kind: 'generic' })
    expect(from('Edit', { path: 'a.ts' })).toMatchObject({ kind: 'generic' })
    expect(from('Grep', {})).toMatchObject({ kind: 'generic' })
  })

  it('puts a result on the item: command output, a search, or the error of a failed edit', () => {
    const command = activityFromToolCall({ toolName: 'bash', input: { command: 'ls' }, response: 'a\nb\n', status: 'done', startedAt })
    expect(command).toMatchObject({ kind: 'command', output: 'a\nb\n', outputBytes: 4, status: 'done' })
    const edit = applyToolResult(from('edit', { path: 'a.ts', edits: [{ oldText: 'a', newText: 'b' }] }), { response: 'no such text', failed: true })
    expect((edit as Extract<AgentActivityItem, { kind: 'file_change' }>).changes[0]!.error).toBe('no such text')
    const failed = activityFromToolCall({ toolName: 'bash', input: { command: 'false' }, response: 'boom', failed: true, startedAt })
    expect(failed.status).toBe('failed')
  })
})

describe('capTail', () => {
  it('returns short text whole', () => {
    expect(capTail('hello', 100)).toEqual({ text: 'hello', truncated: false, bytes: 5 })
  })

  it('cuts at a line start and reports the full size', () => {
    const text = ['aaaa', 'bbbb', 'cccc', 'dddd'].join('\n')
    const result = capTail(text, 12)
    expect(result.truncated).toBe(true)
    expect(result.bytes).toBe(text.length)
    expect(result.text).toBe('cccc\ndddd')
  })

  it('keeps a tail that already starts at a line', () => {
    expect(capTail('aaaa\nbbbb\ncccc\n', 10).text).toBe('bbbb\ncccc\n')
  })

  it('cuts after a CRLF, never between its characters', () => {
    const text = 'aaaa\r\nbbbb\r\ncccc'
    // The 10 last bytes start inside "\r\n" of the first line break.
    const result = capTail(text, 'bbbb\r\ncccc'.length + 1)
    expect(result.truncated).toBe(true)
    expect(result.text).toBe('bbbb\r\ncccc')
    expect(result.text.startsWith('\n')).toBe(false)
    expect(capTail(text, 'cccc'.length + 2).text).toBe('cccc')
  })

  it('strips ANSI sequences and NUL bytes before measuring', () => {
    const result = capTail('\u001b[31mred\u001b[0m\u0000 text\u001b]0;title\u0007', 100)
    expect(result.text).toBe('red text')
    expect(result.bytes).toBe(8)
  })

  it('does not split a multi-byte character', () => {
    const result = capTail('€€€€€', 7)
    expect(result.truncated).toBe(true)
    expect(result.text).toBe('€€')
  })

  it('stays within the output cap', () => {
    const line = `${'x'.repeat(99)}\n`
    const result = capTail(line.repeat(2000), ACTIVITY_OUTPUT_CAP_BYTES)
    expect(byteLength(result.text)).toBeLessThanOrEqual(ACTIVITY_OUTPUT_CAP_BYTES)
    expect(result.text.startsWith('x')).toBe(true)
    expect(result.bytes).toBe(line.length * 2000)
  })
})

describe('capHead and appendTail', () => {
  it('keeps the start of a long text at a character boundary', () => {
    expect(capHead('abcdef', 3)).toEqual({ text: 'abc', truncated: true, bytes: 6 })
    expect(capHead('€€', 4).text).toBe('€')
    expect(capHead('abc', 10)).toEqual({ text: 'abc', truncated: false, bytes: 3 })
  })

  it('appends streamed output, keeping the tail and the total size', () => {
    let state = { text: '', bytes: 0, truncated: false }
    for (let index = 0; index < 4; index += 1) state = appendTail(state, `line ${index}\n`, 16)
    expect(state.bytes).toBe(28)
    expect(state.truncated).toBe(true)
    expect(state.text).toBe('line 2\nline 3\n')
  })

  it('caps a record by its JSON size', () => {
    expect(capRecord({ a: 1 })).toEqual({ a: 1 })
    expect(capRecord({ blob: 'y'.repeat(100) }, 50)).toMatchObject({ truncated: true })
    expect(capRecord(undefined)).toBeUndefined()
  })
})

describe('diffs', () => {
  it('counts added and removed lines, leaving the file headers out', () => {
    expect(diffLineCounts('--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n ctx\n-old\n+new\n+newer\n')).toEqual({ added: 2, removed: 1 })
    expect(diffLineCounts('')).toEqual({ added: 0, removed: 0 })
  })

  it('builds a one-hunk unified diff with context', () => {
    const oldText = 'a\nb\nc\nd\ne\nf\ng\nh\n'
    const newText = 'a\nb\nc\nd\nE\nf\ng\nh\n'
    const built = buildUnifiedDiff('f.txt', oldText, newText)
    expect(built).toMatchObject({ added: 1, removed: 1 })
    expect(built.diff).toBe(
      ['--- a/f.txt', '+++ b/f.txt', '@@ -2,7 +2,7 @@', ' b', ' c', ' d', '-e', '+E', ' f', ' g', ' h', ''].join('\n')
    )
    expect(unifiedDiff('f.txt', oldText, newText)).toBe(built.diff)
    expect(unifiedDiff('f.txt', 'same', 'same')).toBe('')
    expect(diffLineCounts(built.diff)).toEqual({ added: 1, removed: 1 })
  })

  it('writes an added file as additions only', () => {
    const built = buildUnifiedDiff('n.txt', '', 'x\ny\n')
    expect(built).toMatchObject({ added: 2, removed: 0 })
    expect(built.diff).toContain('@@ -0,0 +1,2 @@')
  })

  it('caps a diff at the diff cap and says so', () => {
    const big = Array.from({ length: 5000 }, (_, index) => `line ${index}`).join('\n')
    const item = from('Edit', { path: 'big.txt', old_string: '', new_string: big }) as Extract<AgentActivityItem, { kind: 'file_change' }>
    const change = item.changes[0]!
    expect(change.diffTruncated).toBe(true)
    expect(byteLength(change.diff ?? '')).toBeLessThanOrEqual(ACTIVITY_DIFF_CAP_BYTES)
    expect(change.added).toBe(5000)
  })

  it('splits a stored diff back into the two texts it describes', () => {
    const built = buildUnifiedDiff('f.txt', 'a\nb\nc\n', 'a\nB\nc\n')
    expect(diffSides(built.diff)).toEqual({ oldText: 'a\nb\nc', newText: 'a\nB\nc' })
    expect(diffSides('hello\nworld', 'add')).toEqual({ oldText: '', newText: 'hello\nworld' })
    expect(diffSides('gone', 'delete')).toEqual({ oldText: 'gone', newText: '' })
  })
})

describe('commandLabel', () => {
  it.each([
    ['npm test', 'npm test'],
    ["bash -lc 'npm run build && npm test'", 'npm run build && npm test'],
    ['/bin/bash -lc "git status"', 'git status'],
    ["sh -c 'ls -la'", 'ls -la'],
    ["zsh -c 'echo hi'", 'echo hi'],
    ['env FOO=1 BAR=2 node script.js', 'node script.js'],
    ['sudo -n apt-get update', 'apt-get update'],
    ['cmd /c dir C:\\temp', 'dir C:\\temp'],
    ['cmd.exe /d /s /c "npm install"', 'npm install'],
    ['powershell -NoProfile -Command "Get-ChildItem -Recurse"', 'Get-ChildItem -Recurse'],
    ['pwsh.exe -NoLogo -NoProfile -Command Get-Date', 'Get-Date'],
    ["sudo bash -lc 'make  install'", 'make install'],
    ['git commit -m "fix: x"', 'git commit -m "fix: x"']
  ])('%s -> %s', (command, label) => {
    expect(commandLabel(command)).toBe(label)
  })
})

describe('mergeActivityPatch', () => {
  const command = (): AgentActivityItem =>
    from('bash', { command: 'make' }) as unknown as AgentActivityItem & { id: string }
  const item = (): AgentActivityItem => ({ ...(command() as object), id: 'i', callId: 'c' }) as AgentActivityItem

  it('appends streamed output and keeps the full size', () => {
    const first = mergeActivityPatch(item(), { kind: 'command', output: 'one\n' }, 'append')
    const second = mergeActivityPatch(first, { kind: 'command', output: 'two\n' }, 'append')
    expect(second).toMatchObject({ kind: 'command', output: 'one\ntwo\n', outputBytes: 8 })
    // A completing patch replaces what streamed, so nothing is doubled.
    const done = mergeActivityPatch(second, { kind: 'command', output: 'one\ntwo\n' })
    expect(done).toMatchObject({ output: 'one\ntwo\n', outputBytes: 8 })
  })

  it('replaces the typed fields when the kind turns out to be another', () => {
    const generic = { ...(from('Agent') as object), id: 'g', callId: 'c' } as AgentActivityItem
    const bash = mergeActivityPatch({ ...generic, kind: 'generic' } as AgentActivityItem, { kind: 'command', command: 'ls' })
    expect(bash).toMatchObject({ kind: 'command', command: 'ls', id: 'g', callId: 'c' })
  })
})

describe('normalizeToolName', () => {
  it.each([
    ['read', 'Read'],
    ['read_file', 'Read'],
    ['edit', 'Edit'],
    ['NotebookEdit', 'Edit'],
    ['declare_files', 'Edit'],
    ['write', 'Write'],
    ['bash', 'Bash'],
    ['BashOutput', 'Bash'],
    ['KillShell', 'Bash'],
    ['grep', 'Grep'],
    ['glob', 'Glob'],
    ['find', 'Glob'],
    ['ls', 'Glob'],
    ['list_dir', 'Glob'],
    ['todo', 'TodoWrite'],
    ['TodoWrite', 'TodoWrite'],
    ['plan', 'PlanWrite'],
    ['present_plan', 'PlanWrite'],
    ['ExitPlanMode', 'ExitPlanMode'],
    ['exit_plan_mode', 'PlanWrite'],
    ['web_search', 'WebSearch'],
    ['WebFetch', 'WebFetch'],
    ['load_skill', 'Skill'],
    ['Agent', 'Agent'],
    ['task', 'Task'],
    ['question', 'Question'],
    ['create_quick_action', 'QuickAction'],
    ['thinking', 'Thinking'],
    ['cloning', 'cloning'],
    ['run_command', 'Run_command'],
    ['MyTool', 'MyTool'],
    ['custom_tool', 'Custom_tool']
  ])('%s -> %s', (raw, expected) => {
    expect(normalizeToolName(raw)).toBe(expected)
  })

  it('names a nameless call by its kind', () => {
    expect(normalizeToolName(undefined, 'mcp_tool_call')).toBe('Mcp')
    expect(normalizeToolName(undefined, 'mcp_tool_result')).toBe('Mcp')
    expect(normalizeToolName(undefined)).toBe('Generic')
  })
})

describe('diffAsPatch', () => {
  const hunks = (patch: string) => parsePatchFiles(patch).flatMap((entry) => entry.files).flatMap((file) => file.hunks)

  it('keeps a hunk that starts far into the file at its own line numbers', () => {
    const patch = diffAsPatch('src/a.ts', '@@ -97,3 +97,3 @@\n keep\n-old\n+new\n keep\n')!
    expect(patch.startsWith('--- a/src/a.ts\n+++ b/src/a.ts\n@@ -97,3 +97,3 @@')).toBe(true)
    expect(hunks(patch).map((hunk) => [hunk.deletionStart, hunk.additionStart])).toEqual([[97, 97]])
  })

  it('keeps separated hunks separate, with the gap between them', () => {
    const diff = '--- a/a.ts\n+++ b/a.ts\n@@ -2,3 +2,3 @@\n a\n-b\n+B\n c\n@@ -40,3 +40,3 @@\n x\n-y\n+Y\n z\n'
    const patch = diffAsPatch('a.ts', diff)!
    expect(patch).toBe(diff)
    const parsed = hunks(patch)
    expect(parsed.map((hunk) => hunk.additionStart)).toEqual([2, 40])
    expect(parsed[1]!.collapsedBefore).toBeGreaterThan(0)
  })

  it('round-trips what unifiedDiff writes', () => {
    const patch = diffAsPatch('a.ts', unifiedDiff('a.ts', 'a\nb\nc\n', 'a\nB\nc\n'))!
    expect(hunks(patch)).toHaveLength(1)
  })

  it('leaves a diff without real hunk headers to be drawn from its two sides', () => {
    expect(diffAsPatch('a.ts', 'hello\nworld')).toBeUndefined()
    expect(diffAsPatch('a.ts', '@@\n-old\n+new')).toBeUndefined()
    expect(diffAsPatch('a.ts', '@@ -1 +1 @@\n-a\n+b\n@@\n-c\n+d')).toBeUndefined()
  })
})
