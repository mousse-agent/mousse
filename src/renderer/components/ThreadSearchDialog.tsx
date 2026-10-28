import { useCallback, useEffect, useRef, useState } from 'react'
import { Search, X } from '../lib/icons'
import type { ThreadSearchResult, ThreadSearchSkipped } from '../../shared/types'
import { useCommandOverlay } from '../commands/commandRegistry'
import { skippedLine, THREAD_SEARCH_DEBOUNCE_MS } from '../lib/threadSearchSkipped'
import { ThreadComputerBadge } from './ComputerBadge'
import '../styles/thread-search.css'

interface ThreadSearchDialogProps {
  open: boolean
  onClose: () => void
  onSelect: (threadId: string) => void
}

function groupLabel(matchType: ThreadSearchResult['matchType']): string {
  switch (matchType) {
    case 'thread':
      return 'Threads'
    case 'project':
      return 'Projects'
    case 'message':
      return 'Messages'
  }
}

export function ThreadSearchDialog({ open, onClose, onSelect }: ThreadSearchDialogProps) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<ThreadSearchResult[]>([])
  const [skipped, setSkipped] = useState<ThreadSearchSkipped[] | undefined>()
  const [loading, setLoading] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  useCommandOverlay('thread-search', open)

  useEffect(() => {
    if (!open) {
      setQuery('')
      setResults([])
      setSkipped(undefined)
      setLoading(false)
      setActiveIndex(0)
      return
    }
    inputRef.current?.focus()
  }, [open])

  useEffect(() => {
    if (!open) return

    const trimmed = query.trim()
    if (!trimmed) {
      setResults([])
      setSkipped(undefined)
      setActiveIndex(0)
      return
    }

    // A newer query replaces this one: its answer is dropped, and the daemon ends the calls it made to other computers.
    let current = true
    const timer = setTimeout(async () => {
      setLoading(true)
      try {
        const found = await window.mousse.threads.search(trimmed, 40)
        if (!current) return
        setResults(found.results)
        setSkipped(found.skipped)
        setActiveIndex(0)
      } finally {
        if (current) setLoading(false)
      }
    }, THREAD_SEARCH_DEBOUNCE_MS)

    return () => {
      current = false
      clearTimeout(timer)
    }
  }, [open, query])

  useEffect(() => {
    if (!open) return

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, onClose])

  const choose = useCallback(
    (result: ThreadSearchResult) => {
      onSelect(result.threadId)
      onClose()
    },
    [onClose, onSelect]
  )

  if (!open) return null

  const grouped = results.reduce<Record<string, ThreadSearchResult[]>>((acc, result) => {
    const key = groupLabel(result.matchType)
    acc[key] = acc[key] ?? []
    acc[key].push(result)
    return acc
  }, {})

  return (
    <div className="thread-search-overlay" onClick={onClose} role="presentation">
      <div
        className="thread-search-dialog"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Search threads"
      >
        <div className="thread-search-input-row">
          <Search size={16} strokeWidth={2} className="thread-search-icon" aria-hidden="true" />
          <input
            ref={inputRef}
            className="thread-search-input"
            value={query}
            placeholder="Search threads, projects, and messages…"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                setActiveIndex((index) => Math.min(index + 1, Math.max(results.length - 1, 0)))
              }
              if (event.key === 'ArrowUp') {
                event.preventDefault()
                setActiveIndex((index) => Math.max(index - 1, 0))
              }
              if (event.key === 'Enter' && results[activeIndex]) {
                event.preventDefault()
                choose(results[activeIndex])
              }
            }}
          />
          <button type="button" className="thread-search-close" onClick={onClose} aria-label="Close">
            <X size={16} strokeWidth={2} />
          </button>
        </div>

        <div className="thread-search-results">
          {loading && <div className="thread-search-empty">Searching…</div>}
          {!loading && query.trim() && results.length === 0 && (
            <div className="thread-search-empty">No results</div>
          )}
          {!loading &&
            Object.entries(grouped).map(([label, items]) => (
              <div key={label} className="thread-search-group">
                <div className="thread-search-group-label">{label}</div>
                {items.map((result) => {
                  const flatIndex = results.indexOf(result)
                  return (
                    <button
                      key={`${result.threadId}-${result.matchType}-${result.messageId ?? ''}-${result.snippet ?? ''}`}
                      type="button"
                      className={`thread-search-result${flatIndex === activeIndex ? ' active' : ''}`}
                      onMouseEnter={() => setActiveIndex(flatIndex)}
                      onClick={() => choose(result)}
                    >
                      <span className="thread-search-result-title">{result.threadName}</span>
                      {(result.projectName || result.node) && (
                        <span className="thread-search-result-meta thread-search-result-where">
                          {result.projectName && <span>{result.projectName}</span>}
                          {/* A result from another computer says which one it is on. */}
                          <ThreadComputerBadge thread={{ node: result.node }} withName className="thread-search-result-computer" />
                        </span>
                      )}
                      {result.snippet && (
                        <span className="thread-search-result-snippet">{result.snippet}</span>
                      )}
                    </button>
                  )
                })}
              </div>
            ))}
        </div>

        {skippedLine(skipped) && <div className="thread-search-empty">{skippedLine(skipped)}</div>}

        <div className="thread-search-footer">
          <span className="thread-search-hint">
            <kbd>↑</kbd>
            <kbd>↓</kbd> navigate
          </span>
          <span className="thread-search-hint">
            <kbd>↵</kbd> open
          </span>
          <span className="thread-search-hint">
            <kbd>esc</kbd> close
          </span>
        </div>
      </div>
    </div>
  )
}
