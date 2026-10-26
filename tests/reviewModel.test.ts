import { describe, expect, it } from 'vitest'
import type { ReviewFileEntry } from '../src/shared/review'
import type { ThreadAction } from '../src/shared/threadActions'
import { formatChatReferences } from '../src/shared/chatReferences'
import { surfaceTabItems } from '../src/renderer/lib/surfaces'
import {
  buildFileTree,
  formatBytes,
  placeholderFor,
  scopeFromOptionValue,
  scopeLabel,
  scopeOptionValue,
  totalCounts,
  turnChoices,
  viewChangeLabel,
  type TreeNode
} from '../src/renderer/components/review/reviewModel'

const entry = (path: string, extra: Partial<ReviewFileEntry> = {}): ReviewFileEntry => ({
  path,
  status: 'modified',
  additions: 1,
  deletions: 0,
  binary: false,
  countsExact: true,
  ...extra
})

const names = (nodes: TreeNode[]): string[] => nodes.map((node) => node.name)

describe('buildFileTree', () => {
  it('nests files under folders, folders first, each sorted by name', () => {
    const tree = buildFileTree([entry('z.ts'), entry('src/b.ts'), entry('src/a.ts'), entry('docs/guide.md'), entry('src/lib/x.ts')])
    expect(names(tree)).toEqual(['docs', 'src', 'z.ts'])
    const src = tree[1] as Extract<TreeNode, { kind: 'folder' }>
    expect(names(src.children)).toEqual(['lib', 'a.ts', 'b.ts'])
  })

  it('folds a chain of single-child folders into one row', () => {
    const tree = buildFileTree([entry('a/b/c/file.ts'), entry('a/b/c/other.ts')])
    expect(tree).toHaveLength(1)
    expect(tree[0]).toMatchObject({ kind: 'folder', name: 'a/b/c', path: 'a/b/c' })
  })

  it('does not fold a folder that also holds a file or a second folder', () => {
    const tree = buildFileTree([entry('a/top.ts'), entry('a/b/c.ts'), entry('d/e/f.ts'), entry('d/g/h.ts')])
    const a = tree[0] as Extract<TreeNode, { kind: 'folder' }>
    expect(a.name).toBe('a')
    expect(names(a.children)).toEqual(['b', 'top.ts'])
    const d = tree[1] as Extract<TreeNode, { kind: 'folder' }>
    expect(names(d.children)).toEqual(['e', 'g'])
  })

  it('keeps the entry on its file node so renames and counts reach the row', () => {
    const renamed = entry('new/name.ts', { status: 'renamed', oldPath: 'old/name.ts' })
    const tree = buildFileTree([renamed])
    const folder = tree[0] as Extract<TreeNode, { kind: 'folder' }>
    expect(folder.children[0]).toMatchObject({ kind: 'file', path: 'new/name.ts', entry: renamed })
  })

  it('builds a 2,000-file list in one pass', () => {
    const files = Array.from({ length: 2000 }, (_, index) => entry(`pkg${index % 40}/mod${index % 7}/file${index}.ts`))
    const started = performance.now()
    const tree = buildFileTree(files)
    expect(performance.now() - started).toBeLessThan(500)
    const count = (nodes: TreeNode[]): number => nodes.reduce((sum, node) => sum + (node.kind === 'file' ? 1 : count(node.children)), 0)
    expect(count(tree)).toBe(2000)
    expect(tree).toHaveLength(40)
  })
})

describe('placeholderFor', () => {
  it('explains binary, oversized and absent sides, and shows nothing for text', () => {
    expect(placeholderFor({ binary: true, size: 10 }, 'modified')).toBe('Binary file')
    expect(placeholderFor({ tooLarge: true, size: 2.4 * 1024 * 1024, reason: 'bytes' }, 'modified')).toBe('Too large to show (2.4 MB)')
    expect(placeholderFor({ tooLarge: true, size: 400_000, lines: 200_000, reason: 'lines' }, 'modified')).toBe('Too large to show (200,000 lines)')
    expect(placeholderFor(null, 'deleted')).toBe('File deleted')
    expect(placeholderFor(null, 'added')).toBe('File added')
    expect(placeholderFor(null, 'untracked')).toBe('File added')
    expect(placeholderFor({ content: 'x', size: 1 }, 'modified')).toBeNull()
  })

  it('formats sizes', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1024 * 1024)).toBe('1 MB')
    expect(formatBytes(1_572_864)).toBe('1.5 MB')
    expect(formatBytes(20 * 1024 * 1024)).toBe('20 MB')
  })
})

function action(overrides: Partial<ThreadAction> & { turnId: string }): ThreadAction {
  return {
    id: `action-${overrides.turnId}`,
    conversationBranchId: 'main',
    presentationMessageStart: 0,
    presentationMessageEnd: 0,
    nativeContextBoundary: { messageIndex: 0, compactionGeneration: 0, fidelity: 'exact' },
    startSha: 'a'.repeat(40),
    endSha: 'b'.repeat(40),
    commits: [],
    childIntegrations: [],
    changedPaths: [{ path: 'a.ts' }],
    externalEffects: [],
    reversible: true,
    state: 'completed',
    createdAt: '2026-10-26T10:00:00.000Z',
    ...overrides
  } as ThreadAction
}

describe('turnChoices', () => {
  it('skips conversation-only actions and turns that changed nothing', () => {
    const choices = turnChoices(
      [
        action({ turnId: 'run:1' }),
        action({ turnId: 'run:chat', scope: 'conversation' }),
        action({ turnId: 'run:empty', changedPaths: [], commits: [] }),
        action({ turnId: 'run:commit', changedPaths: [], commits: ['c'.repeat(40)], createdAt: '2026-10-26T11:00:00.000Z' })
      ],
      []
    )
    expect(choices.map((choice) => choice.turnId)).toEqual(['run:commit', 'run:1'])
  })

  it('labels a turn with the first words of the user message that started it', () => {
    const [choice] = turnChoices(
      [action({ turnId: 'run:1' })],
      [
        { role: 'user', turnId: 'run:0', content: 'Something else' },
        { role: 'user', turnId: 'run:1', content: 'Fix the login redirect when the session expires on mobile' }
      ]
    )
    expect(choice.label).toContain('Fix the login redirect')
    expect(choice.label).not.toContain('on mobile')
    expect(choice.label).not.toContain('Something else')
  })

  it('strips the references block from the label', () => {
    const content = `${formatChatReferences([{ id: 'file:1', kind: 'file', title: 'a.ts', path: '/repo/a.ts' }])}\nRename the helper`
    const [choice] = turnChoices([action({ turnId: 'run:1' })], [{ role: 'user', turnId: 'run:1', content }])
    expect(choice.label).toContain('Rename the helper')
    expect(choice.label).not.toContain('Mousse references')
  })

  it('tolerates messages without a turn id and falls back to a numbered label', () => {
    const choices = turnChoices(
      [action({ turnId: 'run:1' }), action({ turnId: 'run:2', createdAt: '2026-10-26T10:05:00.000Z' })],
      [{ role: 'user', content: 'legacy message with no turn' }]
    )
    expect(choices.map((choice) => choice.turnId)).toEqual(['run:2', 'run:1'])
    expect(choices[1].label).toContain('Turn 1')
  })

  it('lists newest first', () => {
    const choices = turnChoices(
      [
        action({ turnId: 'run:old', createdAt: '2026-10-26T09:00:00.000Z' }),
        action({ turnId: 'run:new', createdAt: '2026-10-26T12:00:00.000Z' })
      ],
      []
    )
    expect(choices.map((choice) => choice.turnId)).toEqual(['run:new', 'run:old'])
  })

  it('offers a running action with no recorded changes yet, marked in progress', () => {
    const [choice] = turnChoices([action({ turnId: 'run:live', state: 'running', changedPaths: [], commits: [] })], [])
    expect(choice).toMatchObject({ turnId: 'run:live', running: true, undone: false })
    expect(choice.label).toContain('(in progress)')
  })

  it.each(['undone', 'undoing', 'undo_conflict'] as const)('keeps a %s turn listed and marks it undone', (state) => {
    const [choice] = turnChoices([action({ turnId: 'run:u', state })], [])
    expect(choice).toMatchObject({ turnId: 'run:u', undone: true, running: false })
    expect(choice.label).toContain('(undone)')
  })
})

describe('scope helpers', () => {
  it('round-trips the picker value, keeping colons inside a turn id', () => {
    const turn = { kind: 'turn' as const, turnId: 'run:thread:abc%3Adef:ordinal:3' }
    expect(scopeOptionValue(turn)).toBe('turn:run:thread:abc%3Adef:ordinal:3')
    expect(scopeFromOptionValue(scopeOptionValue(turn))).toEqual(turn)
    expect(scopeFromOptionValue('thread')).toEqual({ kind: 'thread' })
    expect(scopeFromOptionValue('worktree')).toEqual({ kind: 'worktree' })
  })

  it('labels scopes', () => {
    const choices = [{ turnId: 'run:1', label: 'Fix it · 10:00', undone: false, running: false }]
    expect(scopeLabel({ kind: 'thread' }, choices)).toBe('Whole thread')
    expect(scopeLabel({ kind: 'worktree' }, choices)).toBe('Working tree')
    expect(scopeLabel({ kind: 'worktree', staged: true }, choices)).toBe('Staged changes')
    expect(scopeLabel({ kind: 'turn', turnId: 'run:1' }, choices)).toBe('Fix it · 10:00')
    expect(scopeLabel({ kind: 'turn', turnId: 'run:gone' }, choices)).toBe('Turn')
  })

  it('sums counts', () => {
    expect(totalCounts([entry('a', { additions: 3, deletions: 1 }), entry('b', { additions: 2, deletions: 4 })])).toEqual({ additions: 5, deletions: 5 })
  })
})

describe('viewChangeLabel', () => {
  const change = (original: [number, number], modified: [number, number]) => ({
    originalStartLineNumber: original[0],
    originalEndLineNumber: original[1],
    modifiedStartLineNumber: modified[0],
    modifiedEndLineNumber: modified[1]
  })

  it('counts added, removed and changed line ranges', () => {
    expect(viewChangeLabel([change([4, 0], [5, 7])])).toBe('3 changed lines in view')
    expect(viewChangeLabel([change([10, 11], [10, 0])])).toBe('2 changed lines in view')
    expect(viewChangeLabel([change([20, 21], [20, 22])])).toBe('3 changed lines in view')
    expect(viewChangeLabel([change([4, 0], [5, 7]), change([10, 11], [12, 12])])).toBe('5 changed lines in view')
  })

  it('handles one line, none, and a diff Monaco has not computed yet', () => {
    expect(viewChangeLabel([change([1, 1], [1, 1])])).toBe('1 changed line in view')
    expect(viewChangeLabel([])).toBe('No changed lines in view')
    expect(viewChangeLabel(null)).toBeNull()
  })
})

describe('Review surface tab', () => {
  it('shows a Review tab when the surface is open', () => {
    const items = surfaceTabItems({ opened: ['git', 'review'], terminals: [], browsers: [], documents: [] })
    expect(items.map((item) => [item.key, item.view, item.label])).toEqual([
      ['git', 'git', 'Diff'],
      ['review', 'review', 'Review']
    ])
  })
})
