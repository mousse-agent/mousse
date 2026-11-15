import { splitDataFrames } from '../../../shared/bots/personal/dataFrames'
import type { BotJournalInput } from '../seams'

/** Both request writers use the same frame keys. Conflict inserts never restore a forgotten row. */
export function requestJournalRows<T extends BotJournalInput>(row: T): T[] {
  const split = splitDataFrames(row.text)
  return [
    { ...row, text: split.text },
    ...split.frames.map((frame, n) => ({
      ...row, kind: 'tool_result' as const, who: 'tool' as const, external: true,
      sourceKey: `frame:${row.activationId ?? row.sourceKey}:${n}`,
      text: frame.text, json: { source: frame.source }
    }))
  ]
}
