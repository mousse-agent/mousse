import { useEffect, useState } from 'react'
import { MESSAGE_SEARCH_MIN_LENGTH } from '../commands/paletteItems'
import { THREAD_SEARCH_DEBOUNCE_MS } from '../lib/threadSearchSkipped'

/** Threads one sidebar search may name: every thread of a large profile. */
const MATCH_LIMIT = 5000
const NONE: ReadonlySet<string> = new Set()

/**
 * The threads of this computer with a message that holds `query` (what people typed and the agents' replies), for the
 * sidebar's "Search threads…" field (`ThreadFilterContext.messageMatches`). Asked after typing pauses; the previous
 * answer stays until the next one arrives, so rows do not blink while a search runs. A failed search finds none, and
 * the field still matches titles, projects and bots.
 */
export function useThreadMessageMatches(query: string): ReadonlySet<string> {
  const text = query.trim()
  const [matches, setMatches] = useState<ReadonlySet<string>>(NONE)
  useEffect(() => {
    if (text.length < MESSAGE_SEARCH_MIN_LENGTH) {
      setMatches(NONE)
      return
    }
    let current = true
    const timer = setTimeout(() => {
      window.mousse.threads.search(text, MATCH_LIMIT, { perThread: true }).then(
        (answer) => {
          if (!current) return
          setMatches(new Set(answer.results.filter((hit) => hit.matchType === 'message').map((hit) => hit.threadId)))
        },
        () => {
          if (current) setMatches(NONE)
        }
      )
    }, THREAD_SEARCH_DEBOUNCE_MS)
    return () => {
      current = false
      clearTimeout(timer)
    }
  }, [text])
  return matches
}
