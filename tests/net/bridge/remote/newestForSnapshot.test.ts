/**
 * The newest part of a loaded transcript another computer's snapshot carries is what budgeting the whole transcript
 * and then taking its newest page gives, though only the newest messages are budgeted and measured; a transcript of
 * 200 messages or fewer gives exactly what a snapshot gave before the count cap.
 */
import { describe, expect, it } from 'vitest'
import { newestForSnapshot, withImageBudget } from '../../../../src/mms/bridge/remote/MmsBackend'
import { newestMessages, newestPage } from '../../../../src/mms/protocol/transcriptPaging'
import { ROUTED_SNAPSHOT_MESSAGE_BYTES, ROUTED_SNAPSHOT_MESSAGES_MAX } from '../../../../src/shared/bridge/routed'
import type { ChatMessage } from '../../../../src/shared/types'

const KIB = 1024
const limits = { maxBytes: ROUTED_SNAPSHOT_MESSAGE_BYTES, limit: ROUTED_SNAPSHOT_MESSAGES_MAX }

function transcript(count: number, options: { contentBytes?: number; imageChars?: number } = {}): ChatMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `m-${index}`,
    role: index % 2 ? 'assistant' : 'user',
    content: `${index}:`.padEnd(options.contentBytes ?? 16, 'x'),
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
    ...(options.imageChars ? { images: [{ name: `i-${index}.png`, mimeType: 'image/png', data: 'A'.repeat(options.imageChars) }] } : {})
  })) as ChatMessage[]
}

/** Two copies of one id, one of them the oldest message kept: the cursor names which copy. */
function repeatedAtTheBoundary(): ChatMessage[] {
  const all = transcript(250)
  all[0] = { ...all[0]!, id: 'dup' }
  all[50] = { ...all[50]!, id: 'dup' }
  return all
}

const rows: Array<{ name: string; messages: () => ChatMessage[]; kept: number }> = [
  { name: 'no messages', messages: () => [], kept: 0 },
  { name: 'one message', messages: () => transcript(1), kept: 1 },
  { name: '200 messages whose images pass the image budget', messages: () => transcript(200, { imageChars: 60 * KIB }), kept: 200 },
  { name: '201 messages', messages: () => transcript(201), kept: 200 },
  { name: '450 messages with images', messages: () => transcript(450, { imageChars: 60 * KIB }), kept: 200 },
  { name: '300 messages the byte budget cuts before the count does', messages: () => transcript(300, { contentBytes: 128 * KIB }), kept: 127 },
  { name: 'an id repeated at the oldest message kept', messages: repeatedAtTheBoundary, kept: 200 }
]

describe('the newest part of a loaded transcript for another computer', () => {
  it.each(rows)('$name', ({ messages, kept }) => {
    const all = messages()
    const result = newestForSnapshot(all, limits)
    expect(result.messages).toHaveLength(kept)
    // The slow path: every message budgeted for images, then the newest page.
    expect(result).toEqual(newestPage(withImageBudget(all), limits.limit, limits.maxBytes))
    // What a snapshot carried before the count cap, for a transcript the cap does not reach.
    if (all.length <= ROUTED_SNAPSHOT_MESSAGES_MAX) expect(result).toEqual(newestMessages(withImageBudget(all), limits.maxBytes))
    expect(result.earlier?.count ?? 0).toBe(all.length - kept)
  })
})
