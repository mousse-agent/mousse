import { useCallback, useEffect, useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  File,
  Folder,
  FolderOpen,
  RefreshCw
} from 'lucide-react'
import type { FileEntry } from '../../shared/types'
import { setReferenceDragData } from '../../shared/chatReferences'
import { useAppStore } from '../stores/appStore'

interface FileTreeProps {
  filesRoot: string
  rootLabel: string
  threadId: string | null
  selectedPath: string | null
  onSelectFile: (path: string) => void
  refreshKey: number
}

interface TreeNodeProps {
  entry: FileEntry
  depth: number
  selectedPath: string | null
  onSelectFile: (path: string) => void
  expandedPaths: Set<string>
  toggleExpand: (path: string) => void
  loadChildren: (path: string) => Promise<FileEntry[]>
  filesRoot: string
  threadId: string | null
  projectId?: string
}

function TreeNode({
  entry,
  depth,
  selectedPath,
  onSelectFile,
  expandedPaths,
  toggleExpand,
  loadChildren,
  filesRoot,
  threadId,
  projectId
}: TreeNodeProps) {
  const [children, setChildren] = useState<FileEntry[] | null>(null)
  const [loading, setLoading] = useState(false)
  const isDir = entry.kind === 'directory'
  const expanded = isDir && expandedPaths.has(entry.path)

  useEffect(() => {
    if (!expanded || children !== null) return
    setLoading(true)
    void loadChildren(entry.path)
      .then(setChildren)
      .finally(() => setLoading(false))
  }, [expanded, children, entry.path, loadChildren])

  const handleClick = () => {
    if (isDir) {
      toggleExpand(entry.path)
    } else {
      onSelectFile(entry.path)
    }
  }

  return (
    <div className="file-tree-node">
      <button
        type="button"
        className={`file-tree-row${selectedPath === entry.path ? ' selected' : ''}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={handleClick}
        draggable={!isDir}
        onDragStart={(event) => {
          if (isDir) return
          const absolute = /^(?:[a-zA-Z]:[\\/]|\/)/.test(entry.path)
            ? entry.path
            : `${filesRoot.replace(/[\\/]$/, '')}/${entry.path.replace(/^[\\/]/, '')}`
          setReferenceDragData(event.dataTransfer, {
            kind: 'file', title: entry.name, path: absolute, threadId: threadId ?? undefined, projectId
          })
        }}
      >
        {isDir ? (
          expanded ? (
            <ChevronDown size={14} className="file-tree-chevron" />
          ) : (
            <ChevronRight size={14} className="file-tree-chevron" />
          )
        ) : (
          <span className="file-tree-chevron-spacer" />
        )}
        {isDir ? (
          expanded ? (
            <FolderOpen size={14} className="file-tree-icon" />
          ) : (
            <Folder size={14} className="file-tree-icon" />
          )
        ) : (
          <File size={14} className="file-tree-icon" />
        )}
        <span className="file-tree-name">{entry.name}</span>
      </button>
      {expanded && (
        <div className="file-tree-children">
          {loading && <div className="file-tree-loading">Loading…</div>}
          {children?.map((child) => (
            <TreeNode
              key={child.path}
              entry={child}
              depth={depth + 1}
              selectedPath={selectedPath}
              onSelectFile={onSelectFile}
              expandedPaths={expandedPaths}
              toggleExpand={toggleExpand}
              loadChildren={loadChildren}
              filesRoot={filesRoot}
              threadId={threadId}
              projectId={projectId}
            />
          ))}
        </div>
      )}
    </div>
  )
}

export function FileTree({
  filesRoot,
  rootLabel,
  threadId,
  selectedPath,
  onSelectFile,
  refreshKey
}: FileTreeProps) {
  const projectId = useAppStore((s) => s.threads.find((thread) => thread.id === threadId)?.projectId)
  const [rootEntries, setRootEntries] = useState<FileEntry[]>([])
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => new Set(['']))
  const [loading, setLoading] = useState(false)

  const loadChildren = useCallback(
    async (dirPath: string) => window.mousse.fs.listDir(dirPath, undefined, threadId),
    [threadId]
  )

  const refreshRoot = useCallback(async () => {
    if (!filesRoot) return
    setLoading(true)
    try {
      const entries = await window.mousse.fs.listDir('', undefined, threadId)
      setRootEntries(entries)
    } finally {
      setLoading(false)
    }
  }, [filesRoot, threadId])

  useEffect(() => {
    void refreshRoot()
  }, [refreshRoot, refreshKey])

  const toggleExpand = useCallback((path: string) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  if (!filesRoot) {
    return <div className="file-tree-loading">Loading…</div>
  }

  return (
    <div className="file-tree">
      <div className="file-tree-root-label" title={filesRoot}>
        {rootLabel}
      </div>
      {loading ? (
        <div className="file-tree-loading">Loading…</div>
      ) : (
        rootEntries.map((entry) => (
          <TreeNode
            key={entry.path}
            entry={entry}
            depth={0}
            selectedPath={selectedPath}
            onSelectFile={onSelectFile}
            expandedPaths={expandedPaths}
            toggleExpand={toggleExpand}
            loadChildren={loadChildren}
            filesRoot={filesRoot}
            threadId={threadId}
            projectId={projectId}
          />
        ))
      )}
    </div>
  )
}

export function FileTreeToolbar({ onRefresh }: { onRefresh: () => void }) {
  return (
    <button type="button" className="btn btn-ghost btn-sm" onClick={onRefresh} title="Refresh">
      <RefreshCw size={14} strokeWidth={2} />
    </button>
  )
}
