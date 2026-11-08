import { useMemo, useRef, useState } from 'react'
import { Search } from '../../lib/icons'
import { Modal } from '../ui/Modal'

export interface JumpRow {
  path: string
  additions: number
  deletions: number
  viewed: boolean
  comments: number
  included: boolean | null
}

type JumpFilter = 'all' | 'unviewed' | 'commented' | 'included'

interface FileJumpProps {
  open: boolean
  rows: readonly JumpRow[]
  /** Included is a filter only where the commit can take part of the changes. */
  showIncluded: boolean
  onPick: (path: string) => void
  onClose: () => void
}

/** `F` or the file count: type to filter, line totals per file, filters Unviewed · Commented · Included. */
export function FileJump({ open, rows, showIncluded, onPick, onClose }: FileJumpProps) {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<JumpFilter>('all')
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return rows.filter((row) => {
      if (needle && !row.path.toLowerCase().includes(needle)) return false
      if (filter === 'unviewed') return !row.viewed
      if (filter === 'commented') return row.comments > 0
      if (filter === 'included') return row.included === true
      return true
    })
  }, [rows, query, filter])
  const filters: Array<[JumpFilter, string]> = [['unviewed', 'Unviewed'], ['commented', 'Commented'], ...(showIncluded ? [['included', 'Included'] as [JumpFilter, string]] : [])]

  const pick = (path: string | undefined) => {
    if (!path) return
    onPick(path)
    setQuery('')
    onClose()
  }

  return (
    <Modal open={open} title="Jump to a file" hideTitle onClose={onClose} className="changes-jump">
      <label className="changes-jump-search">
        <Search size={14} aria-hidden="true" />
        <input
          ref={inputRef}
          value={query}
          placeholder="Jump to a file"
          aria-label="Jump to a file"
          spellCheck={false}
          onChange={(event) => {
            setQuery(event.target.value)
            setActive(0)
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault()
              if (shown.length === 0) return
              setActive((index) => (index + (event.key === 'ArrowDown' ? 1 : -1) + shown.length) % shown.length)
            } else if (event.key === 'Enter') {
              event.preventDefault()
              pick(shown[active]?.path)
            }
          }}
        />
      </label>
      <div className="changes-jump-filters" role="group" aria-label="Show">
        {filters.map(([id, label]) => (
          <button
            key={id}
            type="button"
            className="changes-jump-filter"
            aria-pressed={filter === id}
            onClick={() => {
              setFilter((current) => (current === id ? 'all' : id))
              setActive(0)
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="changes-jump-list" role="listbox" aria-label="Files">
        {shown.length === 0 ? (
          <p className="changes-jump-empty">No matching files</p>
        ) : (
          shown.map((row, index) => (
            <button
              key={row.path}
              type="button"
              role="option"
              aria-selected={index === active}
              className="changes-jump-row"
              data-active={index === active || undefined}
              title={row.path}
              onMouseMove={() => setActive(index)}
              onClick={() => pick(row.path)}
            >
              <span className="changes-jump-path">{row.path}</span>
              <span className="changes-stat">
                {row.additions > 0 && <span className="turn-edits-add">+{row.additions}</span>}
                {row.deletions > 0 && <span className="turn-edits-del">−{row.deletions}</span>}
              </span>
            </button>
          ))
        )}
      </div>
    </Modal>
  )
}
