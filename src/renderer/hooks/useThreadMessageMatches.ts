import { useEffect, useMemo, useState } from 'react'
import { MESSAGE_SEARCH_MIN_LENGTH } from '../commands/paletteItems'
import { THREAD_SEARCH_DEBOUNCE_MS } from '../lib/threadSearchSkipped'

/** Threads one sidebar search may name: every thread of a large profile. */
const MATCH_LIMIT = 5000
const NONE: ReadonlySet<string> = new Set()

/**
 * The threads with a message that holds `query` (what people typed and the agents' replies), for the sidebar's
 * "Search threads…" field (`ThreadFilterContext.messageMatches`): this computer's, and those of the user's other
 * computers. Asked after typing pauses, as two searches: this computer's answers at once, the other computers' when they
 * do, so a slow computer never holds this one's matches. Each answer stays until its next one arrives, so rows do not
 * blink while a search runs. A failed search finds none, and the field still matches titles, projects and bots.
 */
export function useThreadMessageMatches(query: string): ReadonlySet<string> {
  const text = query.trim()
  const [local, setLocal] = useState<ReadonlySet<string>>(NONE)
  const [others, setOthers] = useState<ReadonlySet<string>>(NONE)
  useEffect(() => {
    if (text.length < MESSAGE_SEARCH_MIN_LENGTH) {
      setLocal(NONE)
      setOthers(NONE)
      return
    }
    let current = true
    const ask = (set: (matches: ReadonlySet<string>) => void, options: { perThread: true; others?: true }) =>
      window.mousse.threads.search(text, MATCH_LIMIT, options).then(
        (answer) => {
          if (current) set(new Set(answer.results.filter((hit) => hit.matchType === 'message').map((hit) => hit.threadId)))
        },
        () => {
          if (current) set(NONE)
        }
      )
    const timer = setTimeout(() => {
      void ask(setLocal, { perThread: true })
      void ask(setOthers, { perThread: true, others: true })
    }, THREAD_SEARCH_DEBOUNCE_MS)
    return () => {
      current = false
      clearTimeout(timer)
    }
  }, [text])
  return useMemo(() => (!others.size ? local : !local.size ? others : new Set([...local, ...others])), [local, others])
}
