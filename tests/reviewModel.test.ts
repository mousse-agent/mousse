import { describe, expect, it } from 'vitest'
import type { ReviewFileEntry } from '../src/shared/review'
import type { ThreadAction } from '../src/shared/threadActions'
import { formatChatReferences } from '../src/shared/chatReferences'
import { surfaceTabItems } from '../src/renderer/lib/surfaces'
import {
  formatBytes,
  placeholderFor,
  turnChoices
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

describe('Changes surface tab', () => {
  it('shows one Changes tab for the git surface', () => {
    const items = surfaceTabItems({ opened: ['files', 'git'], terminals: [], browsers: [], documents: [] })
    expect(items.map((item) => [item.key, item.view, item.label])).toEqual([
      ['files', 'files', 'Files'],
      ['git', 'git', 'Changes']
    ])
  })
})
