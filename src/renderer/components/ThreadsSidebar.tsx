import { useEffect, useRef, useState } from 'react'

import { ChevronDown, ChevronRight, Clock, Edit, GitBranch, Loader2, MessageSquarePlus, Pin, Plus, Radio, Search } from 'lucide-react'

import { isDefaultThreadName, isThreadStarted } from '../../shared/threadTitle'
import { useAppStore } from '../stores/appStore'

import {
  ThreadsContextMenu,

  type ThreadsContextMenuTarget

} from './ThreadsContextMenu'

import { ThreadSearchDialog } from './ThreadSearchDialog'

import '../styles/threads-sidebar.css'



interface RenamingTarget {

  type: 'thread' | 'project'

  id: string

  name: string

}

interface DraggedSidebarItem {
  type: 'thread' | 'project'
  id: string
  projectId?: string
}



interface SidebarRenameInputProps {

  initialName: string

  className?: string

  onSubmit: (name: string) => void

  onCancel: () => void

}



function SidebarRenameInput({

  initialName,

  className = '',

  onSubmit,

  onCancel

}: SidebarRenameInputProps) {

  const [value, setValue] = useState(initialName)

  const inputRef = useRef<HTMLInputElement>(null)



  useEffect(() => {

    inputRef.current?.focus()

    inputRef.current?.select()

  }, [])



  const submit = () => {

    const trimmed = value.trim()

    if (trimmed) {

      onSubmit(trimmed)

    } else {

      onCancel()

    }

  }



  return (

    <input

      ref={inputRef}

      className={`threads-sidebar-rename-input ${className}`.trim()}

      value={value}

      onChange={(event) => setValue(event.target.value)}

      onKeyDown={(event) => {

        event.stopPropagation()

        if (event.key === 'Enter') {

          event.preventDefault()

          submit()

        }

        if (event.key === 'Escape') {

          event.preventDefault()

          onCancel()

        }

      }}

      onBlur={submit}

      onClick={(event) => event.stopPropagation()}

    />

  )

}



export function ThreadsSidebar({ className = '' }: { className?: string }) {

  const projects = useAppStore((s) => s.projects)

  const threads = useAppStore((s) => s.threads)

  const activeThreadId = useAppStore((s) => s.activeThreadId)

  const threadActivity = useAppStore((s) => s.threadActivity)

  const setScheduledOpen = useAppStore((s) => s.setScheduledOpen)

  const setChannelsOpen = useAppStore((s) => s.setChannelsOpen)

  const switchToThread = useAppStore((s) => s.switchToThread)

  const [searchOpen, setSearchOpen] = useState(false)

  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set())

  const [settledExpanded, setSettledExpanded] = useState(false)

  const [threadsExpanded, setThreadsExpanded] = useState(true)

  const [projectsExpanded, setProjectsExpanded] = useState(true)

  const [contextMenu, setContextMenu] = useState<{

    x: number

    y: number

    target: ThreadsContextMenuTarget

  } | null>(null)

  const [renaming, setRenaming] = useState<RenamingTarget | null>(null)
  const [pendingTitleIds, setPendingTitleIds] = useState<Set<string>>(new Set())
  const pendingTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  const draggedItem = useRef<DraggedSidebarItem | null>(null)
  const suppressClick = useRef(false)

  const threadsSidebarWidth = useAppStore((s) => s.threadsSidebarWidth)



  // Keep the active draft visible so a newly opened chat appears immediately.
  const availableThreads = threads.filter(
    (thread) => !thread.settledAt && (isThreadStarted(thread) || thread.id === activeThreadId)
  )
  const settledThreads = threads.filter(
    (thread) => Boolean(thread.settledAt) && isThreadStarted(thread)
  )
  const orphanThreads = availableThreads.filter((thread) => !thread.projectId)

  useEffect(() => {
    if (!activeThreadId) return
    const activeThread = threads.find((thread) => thread.id === activeThreadId)
    const projectId = activeThread?.projectId
    if (!projectId) return
    setExpandedProjects((prev) => {
      if (prev.has(projectId)) return prev
      return new Set(prev).add(projectId)
    })
  }, [activeThreadId, threads])

  const toggleProject = (projectId: string) => {

    setExpandedProjects((prev) => {

      const next = new Set(prev)

      if (next.has(projectId)) {

        next.delete(projectId)

      } else {

        next.add(projectId)

      }

      return next

    })

  }



  const selectThread = async (threadId: string) => {
    if (threadId === activeThreadId) {
      // A completion can arrive while this thread is already selected. Let main
      // acknowledge it when the user clicks the green dot/thread again.
      if (threadActivity[threadId] === 'completed') {
        await window.mousse.threads.select(threadId)
      }
      return
    }
    // One store update: highlight + restore cached transcript (if any) while
    // the daemon snapshot loads. Main also broadcasts thread:selected early.
    switchToThread(threadId)
    await window.mousse.threads.select(threadId)
  }



  const openProject = async () => {

    const project = await window.mousse.projects.open()

    if (!project) return

    const thread = await window.mousse.threads.create(undefined, project.id)

    setExpandedProjects((prev) => new Set(prev).add(project.id))

    await selectThread(thread.id)

  }



  const createThread = async () => {
    const thread = await window.mousse.threads.create()
    await selectThread(thread.id)
  }

  const createProjectThread = async (projectId: string) => {

    const thread = await window.mousse.threads.create(undefined, projectId)

    setExpandedProjects((prev) => new Set(prev).add(projectId))

    await selectThread(thread.id)

  }

  const openScheduled = () => {
    setScheduledOpen(true)
  }

  const openChannels = () => {
    setChannelsOpen(true)
  }

  const openSearch = () => setSearchOpen(true)

  const startDrag = (event: React.DragEvent, item: DraggedSidebarItem) => {
    if (renaming) {
      event.preventDefault()
      return
    }
    draggedItem.current = item
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', item.id)
  }

  const canDropOn = (target: DraggedSidebarItem) => {
    const dragged = draggedItem.current
    return Boolean(
      dragged &&
        dragged.type === target.type &&
        dragged.id !== target.id &&
        (dragged.type === 'project' || dragged.projectId === target.projectId)
    )
  }

  const reorderBefore = async (target: DraggedSidebarItem) => {
    const dragged = draggedItem.current
    if (!dragged || !canDropOn(target)) return
    suppressClick.current = true
    window.setTimeout(() => { suppressClick.current = false }, 0)
    if (dragged.type === 'project') {
      const ids = projects.map((project) => project.id)
      ids.splice(ids.indexOf(dragged.id), 1)
      ids.splice(ids.indexOf(target.id), 0, dragged.id)
      await window.mousse.projects.reorder(ids)
      return
    }
    // Reorder must include every thread in the group (including hidden drafts).
    const group = threads.filter((thread) => thread.projectId === dragged.projectId)
    const ids = group.map((thread) => thread.id)
    ids.splice(ids.indexOf(dragged.id), 1)
    ids.splice(ids.indexOf(target.id), 0, dragged.id)
    await window.mousse.threads.reorder(dragged.projectId, ids)
  }

  const endDrag = () => { draggedItem.current = null }



  const openContextMenu = (

    event: React.MouseEvent,

    target: ThreadsContextMenuTarget

  ) => {

    if (window.getSelection()?.toString()) return

    event.preventDefault()

    event.stopPropagation()

    setContextMenu({ x: event.clientX, y: event.clientY, target })

  }



  const closeContextMenu = () => setContextMenu(null)



  const handlePin = async () => {

    if (!contextMenu) return

    const { target } = contextMenu

    closeContextMenu()



    if (target.type === 'thread') {

      await window.mousse.threads.pin(target.id, !target.pinned)

    } else {

      await window.mousse.projects.pin(target.id, !target.pinned)

    }

  }



  const handleSettle = async () => {
    if (!contextMenu || contextMenu.target.type !== 'thread') return
    const { target } = contextMenu
    closeContextMenu()
    await window.mousse.threads.settle(target.id, !target.settled)
  }

  const handleRegenerateTitle = async () => {
    if (!contextMenu || contextMenu.target.type !== 'thread') return
    const threadId = contextMenu.target.id
    closeContextMenu()
    setPendingTitleIds((prev) => new Set(prev).add(threadId))
    try {
      await window.mousse.threads.regenerateTitle(threadId)
    } finally {
      setPendingTitleIds((prev) => {
        const next = new Set(prev)
        next.delete(threadId)
        return next
      })
    }
  }

  const handleRename = () => {

    if (!contextMenu) return

    const { target } = contextMenu

    closeContextMenu()

    setRenaming({ type: target.type, id: target.id, name: target.name })

  }



  const handleRemove = async () => {

    if (!contextMenu) return

    const { target } = contextMenu

    closeContextMenu()



    if (target.type === 'thread') {

      await window.mousse.threads.delete(target.id)

    } else {

      await window.mousse.projects.remove(target.id)

    }

  }



  const submitRename = async (name: string) => {

    if (!renaming) return



    const { type, id } = renaming

    setRenaming(null)



    if (type === 'thread') {

      await window.mousse.threads.rename(id, name)

    } else {

      await window.mousse.projects.rename(id, name)

    }

  }



  const renderThreadStatus = (threadId: string) => {
    const state = threadActivity[threadId]
    if (!state || state === 'idle') return null

    if (state === 'processing') {
      return (
        <Loader2
          size={14}
          strokeWidth={2}
          className="threads-sidebar-status-spinner icon-spin"
          aria-hidden="true"
        />
      )
    }

    if (state === 'completed') {
      return (
        <span
          className="threads-sidebar-status-dot threads-sidebar-status-dot--completed"
          aria-label="Agent finished"
        />
      )
    }

    if (state === 'awaiting_input') {
      return (
        <span
          className="threads-sidebar-status-dot threads-sidebar-status-dot--question"
          aria-label="Agent has a question"
        />
      )
    }

    return null
  }

  useEffect(() => {
    if (pendingTitleIds.size === 0) return
    const stillPending = threads.filter((t) => pendingTitleIds.has(t.id) && !isDefaultThreadName(t.name))
    if (stillPending.length === 0) return
    setPendingTitleIds((prev) => {
      const next = new Set(prev)
      let changed = false
      for (const t of stillPending) {
        if (next.delete(t.id)) {
          changed = true
          const timer = pendingTimers.current.get(t.id)
          if (timer) {
            clearTimeout(timer)
            pendingTimers.current.delete(t.id)
          }
        }
      }
      return changed ? next : prev
    })
  }, [threads, pendingTitleIds])

  useEffect(() => {
    const now = Date.now()
    for (const thread of threads) {
      if (pendingTitleIds.has(thread.id)) continue
      if (!isDefaultThreadName(thread.name) || !thread.startedAt) continue
      const age = now - new Date(thread.startedAt).getTime()
      if (Number.isNaN(age) || age < 0 || age > 15000) continue
      if (pendingTimers.current.has(thread.id)) continue
      setPendingTitleIds((prev) => new Set(prev).add(thread.id))
      const remaining = Math.max(1000, 15000 - age)
      const timer = setTimeout(() => {
        setPendingTitleIds((prev) => {
          const next = new Set(prev)
          next.delete(thread.id)
          return next
        })
        pendingTimers.current.delete(thread.id)
      }, remaining)
      pendingTimers.current.set(thread.id, timer)
    }
    return () => {}
  }, [threads, pendingTitleIds])

  useEffect(() => {
    return () => {
      for (const timer of pendingTimers.current.values()) clearTimeout(timer)
      pendingTimers.current.clear()
    }
  }, [])

  const renderThreadRow = (thread: (typeof threads)[number], root = false) => {

    const isSettled = Boolean(thread.settledAt)
    const isRenaming = renaming?.type === 'thread' && renaming.id === thread.id
    const isGeneratingTitle = pendingTitleIds.has(thread.id)
    const statusNode = renderThreadStatus(thread.id)
    const showTrailing = Boolean(statusNode || thread.worktreeEnabled)
    // Background-only unread glow: a completion that arrived while viewing
    // another thread stays visible until this thread is visited (selected).
    // The active thread is already visited, so it keeps the plain dot only.
    const isUnreadCompletion =
      !isSettled && threadActivity[thread.id] === 'completed' && thread.id !== activeThreadId



    return (

      <button

        key={thread.id}

        type="button"

        className={`threads-sidebar-thread${root ? ' threads-sidebar-thread-root' : ''}${

          activeThreadId === thread.id ? ' active' : ''

        }${thread.pinnedAt ? ' pinned' : ''}${isSettled ? ' settled' : ''}${
          isUnreadCompletion ? ' has-unread-completion' : ''
        }`}

        draggable={!isRenaming && !isSettled}

        onDragStart={(event) => {
          event.stopPropagation()
          startDrag(event, { type: 'thread', id: thread.id, projectId: thread.projectId })
        }}

        onDragOver={(event) => {
          if (canDropOn({ type: 'thread', id: thread.id, projectId: thread.projectId })) event.preventDefault()
        }}

        onDrop={(event) => {
          event.stopPropagation()
          event.preventDefault()
          void reorderBefore({ type: 'thread', id: thread.id, projectId: thread.projectId })
        }}

        onDragEnd={endDrag}

        onClick={() => {

          if (!isRenaming && !isSettled && !suppressClick.current) selectThread(thread.id)

        }}

        onContextMenu={(event) =>

          openContextMenu(event, {

            type: 'thread',

            id: thread.id,

            name: thread.name,

            pinned: Boolean(thread.pinnedAt),

            settled: isSettled

          })

        }

      >

        {thread.pinnedAt && (

          <Pin size={12} strokeWidth={2} className="threads-sidebar-pin-icon" aria-hidden="true" />

        )}

        {isRenaming ? (

          <SidebarRenameInput

            initialName={renaming.name}

            onSubmit={submitRename}

            onCancel={() => setRenaming(null)}

          />

        ) : isGeneratingTitle ? (

          <span className="threads-sidebar-skeleton" aria-label="Generating title" />

        ) : (

          <span className="threads-sidebar-thread-name">{thread.name}</span>

        )}

        {showTrailing && (
          <span className="threads-sidebar-thread-trailing">
            {statusNode}
            {thread.worktreeEnabled && (
              <GitBranch
                size={12}
                strokeWidth={2}
                className="threads-sidebar-worktree-icon"
                aria-label="Worktree thread"
              />
            )}
          </span>
        )}

      </button>

    )

  }



  return (

    <aside className={`threads-sidebar${className ? ` ${className}` : ''}`} style={{ width: threadsSidebarWidth }}>

      <div className="threads-sidebar-actions">

        <button type="button" className="threads-sidebar-action" onClick={() => void createThread()}>

          <Edit size={14} strokeWidth={2} className="threads-sidebar-action-icon" aria-hidden="true" />

          <span>New chat</span>

        </button>

        <button type="button" className="threads-sidebar-action" onClick={openSearch}>

          <Search size={14} strokeWidth={2} className="threads-sidebar-action-icon" aria-hidden="true" />

          <span>Search</span>

        </button>

        <button type="button" className="threads-sidebar-action" onClick={openScheduled}>

          <Clock size={14} strokeWidth={2} className="threads-sidebar-action-icon" aria-hidden="true" />

          <span>Scheduled</span>

        </button>

        <button type="button" className="threads-sidebar-action" onClick={openChannels}>

          <Radio size={14} strokeWidth={2} className="threads-sidebar-action-icon" aria-hidden="true" />

          <span>Channels</span>

        </button>

      </div>

      <div className="threads-sidebar-scroll">

      <div

        className={`threads-sidebar-section threads-sidebar-section-projects${projectsExpanded ? '' : ' collapsed'}`}

      >

        <div className="threads-sidebar-heading">

          <button
            type="button"
            className="threads-sidebar-heading-toggle"
            onClick={() => setProjectsExpanded((expanded) => !expanded)}
            aria-expanded={projectsExpanded}
            aria-label={projectsExpanded ? 'Collapse Projects section' : 'Expand Projects section'}
          >
            {projectsExpanded ? (
              <ChevronDown size={14} strokeWidth={2} className="threads-sidebar-chevron" />
            ) : (
              <ChevronRight size={14} strokeWidth={2} className="threads-sidebar-chevron" />
            )}
            <span>Projects</span>
          </button>

          <button

            type="button"

            className="threads-sidebar-icon-btn"

            title="Open project"

            aria-label="Open project"

            onClick={openProject}

          >

            <Plus size={14} strokeWidth={2} />

          </button>

        </div>

        {projectsExpanded && (
        <div className="threads-sidebar-tree">

          {projects.length === 0 ? (

            <div className="threads-sidebar-empty">No projects</div>

          ) : (

            projects.map((project) => {

              const expanded = expandedProjects.has(project.id)

              const projectThreads = availableThreads.filter((thread) => thread.projectId === project.id)

              const isRenaming = renaming?.type === 'project' && renaming.id === project.id



              return (

                <div
                  key={project.id}
                  className="threads-sidebar-project"
                  draggable={!isRenaming}
                  onDragStart={(event) => startDrag(event, { type: 'project', id: project.id })}
                  onDragOver={(event) => {
                    if (canDropOn({ type: 'project', id: project.id })) event.preventDefault()
                  }}
                  onDrop={(event) => {
                    event.preventDefault()
                    void reorderBefore({ type: 'project', id: project.id })
                  }}
                  onDragEnd={endDrag}
                >

                  <div

                    className={`threads-sidebar-project-row${project.pinnedAt ? ' pinned' : ''}`}

                  >

                    <button

                      type="button"

                      className="threads-sidebar-project-toggle"

                      onClick={() => {

                        if (!isRenaming) toggleProject(project.id)

                      }}

                      onContextMenu={(event) =>

                        openContextMenu(event, {

                          type: 'project',

                          id: project.id,

                          name: project.name,

                          pinned: Boolean(project.pinnedAt)

                        })

                      }

                    >

                      {expanded ? (

                        <ChevronDown size={14} strokeWidth={2} className="threads-sidebar-chevron" />

                      ) : (

                        <ChevronRight size={14} strokeWidth={2} className="threads-sidebar-chevron" />

                      )}

                      {project.pinnedAt && (

                        <Pin

                          size={12}

                          strokeWidth={2}

                          className="threads-sidebar-pin-icon"

                          aria-hidden="true"

                        />

                      )}

                      {isRenaming ? (

                        <SidebarRenameInput

                          className="threads-sidebar-project-rename"

                          initialName={renaming.name}

                          onSubmit={submitRename}

                          onCancel={() => setRenaming(null)}

                        />

                      ) : (

                        <span className="threads-sidebar-project-name">{project.name}</span>

                      )}

                    </button>

                    <button

                      type="button"

                      className="threads-sidebar-icon-btn threads-sidebar-project-new-chat"

                      title="New chat in project"

                      aria-label="New chat in project"

                      onClick={() => {

                        void createProjectThread(project.id)

                      }}

                    >

                      <MessageSquarePlus size={14} strokeWidth={2} />

                    </button>

                  </div>

                  {expanded && (

                    <div className="threads-sidebar-children">

                      {projectThreads.length === 0 ? (

                        <div className="threads-sidebar-empty threads-sidebar-empty-nested">

                          No threads

                        </div>

                      ) : (

                        projectThreads.map((thread) => renderThreadRow(thread))

                      )}

                    </div>

                  )}

                </div>

              )

            })

          )}

        </div>
        )}

      </div>



      <div

        className={`threads-sidebar-section threads-sidebar-section-threads${threadsExpanded ? '' : ' collapsed'}`}

      >

        <div className="threads-sidebar-heading">

          <button
            type="button"
            className="threads-sidebar-heading-toggle"
            onClick={() => setThreadsExpanded((expanded) => !expanded)}
            aria-expanded={threadsExpanded}
            aria-label={threadsExpanded ? 'Collapse Threads section' : 'Expand Threads section'}
          >
            {threadsExpanded ? (
              <ChevronDown size={14} strokeWidth={2} className="threads-sidebar-chevron" />
            ) : (
              <ChevronRight size={14} strokeWidth={2} className="threads-sidebar-chevron" />
            )}
            <span>Threads</span>
          </button>

          <button

            type="button"

            className="threads-sidebar-icon-btn"

            title="New thread"

            aria-label="New thread"

            onClick={createThread}

          >

            <Plus size={14} strokeWidth={2} />

          </button>

        </div>

        {threadsExpanded && (
        <div className="threads-sidebar-tree">

          {orphanThreads.length === 0 ? (

            <div className="threads-sidebar-empty">No threads</div>

          ) : (

            orphanThreads.map((thread) => renderThreadRow(thread, true))

          )}

        </div>
        )}

      </div>

      <div

        className={`threads-sidebar-section threads-sidebar-section-settled${settledExpanded ? '' : ' collapsed'}`}

      >

        <div className="threads-sidebar-heading">

          <button
            type="button"
            className="threads-sidebar-heading-toggle"
            onClick={() => setSettledExpanded((expanded) => !expanded)}
            aria-expanded={settledExpanded}
            aria-label={settledExpanded ? 'Collapse Settled section' : 'Expand Settled section'}
          >
            {settledExpanded ? (
              <ChevronDown size={14} strokeWidth={2} className="threads-sidebar-chevron" />
            ) : (
              <ChevronRight size={14} strokeWidth={2} className="threads-sidebar-chevron" />
            )}
            <span>Settled</span>
            <span className="threads-sidebar-settled-count">{settledThreads.length}</span>
          </button>

        </div>

        {settledExpanded && (
        <div className="threads-sidebar-tree threads-sidebar-settled-list">
          {settledThreads.length === 0 ? (
            <div className="threads-sidebar-empty">No settled threads</div>
          ) : (
            settledThreads.map((thread) => renderThreadRow(thread, true))
          )}
        </div>
        )}

      </div>

      </div>



      {contextMenu && (

        <ThreadsContextMenu

          x={contextMenu.x}

          y={contextMenu.y}

          target={contextMenu.target}

          onClose={closeContextMenu}

          onPin={handlePin}

          onSettle={handleSettle}

          onRegenerateTitle={handleRegenerateTitle}

          onRename={handleRename}

          onRemove={handleRemove}

        />

      )}

      <ThreadSearchDialog
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        onSelect={(threadId) => {
          void selectThread(threadId)
        }}
      />

    </aside>

  )

}


