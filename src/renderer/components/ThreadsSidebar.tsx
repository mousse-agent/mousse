import { useEffect, useId, useMemo, useRef, useState } from 'react'

import type { CSSProperties, KeyboardEvent } from 'react'

import { Archive, Edit, Folder, FolderOpen, FolderPlus, FolderKanban, GitBranch, Laptop, Loader2, MessagesSquare, MessageSquarePlus, Pin, Search } from 'lucide-react'

import { findUnstartedThread, isDefaultThreadName, isThreadStarted } from '../../shared/threadTitle'
import { sortSidebarThreads } from '../../shared/threadSidebarSort'
import { setReferenceDragData } from '../../shared/chatReferences'
import { useAppStore } from '../stores/appStore'
import { confirmNavigation } from '../services/navigationGuards'
import { useChatsStore } from '../stores/chatsStore'
import { ChatsSidebar } from './chats/ChatsSidebar'

import {
  ThreadsContextMenu,

  type ThreadsContextMenuTarget

} from './ThreadsContextMenu'

import { ThreadHoverCard } from './ThreadHoverCard'
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

const PROJECT_THREAD_PREVIEW_LIMIT = 5

function ScrollingThreadTitle({ name }: { name: string }) {
  const containerRef = useRef<HTMLSpanElement>(null)
  const textRef = useRef<HTMLSpanElement>(null)

  const measure = () => {
    const container = containerRef.current
    const text = textRef.current
    if (!container || !text) return

    const overflow = Math.max(0, text.scrollWidth - container.clientWidth)
    container.dataset.overflow = overflow > 0 ? 'true' : 'false'
    container.style.setProperty('--thread-title-overflow', `${overflow}px`)
    container.style.setProperty('--thread-title-duration', `${overflow / 50}s`)
  }

  useEffect(() => {
    const container = containerRef.current
    const text = textRef.current
    if (!container || !text) return

    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(container)
    observer.observe(text)
    return () => observer.disconnect()
  }, [name])

  return (
    <span
      ref={containerRef}
      className="threads-sidebar-thread-name"
      data-overflow="false"
      onMouseEnter={measure}
    >
      <span ref={textRef} className="threads-sidebar-thread-name-text">{name}</span>
    </span>
  )
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

  const appInfo = useAppStore((s) => s.appInfo)
  const tabsId = useId()
  const projects = useAppStore((s) => s.projects)

  const threads = useAppStore((s) => s.threads)

  const activeThreadId = useAppStore((s) => s.activeThreadId)

  const threadActivity = useAppStore((s) => s.threadActivity)

  const switchToThread = useAppStore((s) => s.switchToThread)

  const upsertThread = useAppStore((s) => s.upsertThread)

  const [searchOpen, setSearchOpen] = useState(false)

  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set())

  const [expandedProjectThreadLists, setExpandedProjectThreadLists] = useState<Set<string>>(new Set())

  const [settledExpanded, setSettledExpanded] = useState(false)

  const sidebarView = useAppStore((s) => s.sidebarMode)
  const setSidebarView = async (view: 'projects' | 'chats') => {
    if (view !== sidebarView && !await confirmNavigation()) return
    useAppStore.getState().setSidebarMode(view)
  }

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
  const [isDragging, setIsDragging] = useState(false)

  const threadsSidebarWidth = useAppStore((s) => s.threadsSidebarWidth)



  // Empty drafts are composer state, not conversations. They become visible
  // only when the first message is committed.
  const availableThreads = useMemo(
    () => sortSidebarThreads(threads.filter((thread) => !thread.settledAt && isThreadStarted(thread))),
    [threads]
  )
  const settledThreads = useMemo(
    () => sortSidebarThreads(threads.filter((thread) => Boolean(thread.settledAt) && isThreadStarted(thread))),
    [threads]
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

    // Keep the project relationship available synchronously. The daemon also
    // broadcasts the full list, but that event can arrive after the user sends
    // the first message from the newly selected composer.
    upsertThread(thread)

    setExpandedProjects((prev) => new Set(prev).add(project.id))

    await selectThread(thread.id)

  }



  const createThread = async () => {
    const thread = findUnstartedThread(threads) ?? await window.mousse.threads.create()
    upsertThread(thread)
    await selectThread(thread.id)
  }

  const createProjectThread = async (projectId: string) => {
    const thread = findUnstartedThread(threads, projectId) ??
      await window.mousse.threads.create(undefined, projectId)

    // Do not depend on the asynchronous threads:updated broadcast to attach
    // this composer to its project before the first send promotes the draft.
    upsertThread(thread)

    setExpandedProjects((prev) => new Set(prev).add(projectId))

    await selectThread(thread.id)

  }

  const openSearch = () => {
    if (sidebarView === 'chats') useChatsStore.setState({ searchOpen: true })
    else setSearchOpen(true)
  }

  const onTabKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const nextView = event.key === 'Home' ? 'projects' : event.key === 'End' ? 'chats' : sidebarView === 'projects' ? 'chats' : 'projects'
    setSidebarView(nextView)
    const buttons = event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')
    buttons[nextView === 'projects' ? 0 : 1]?.focus()
  }

  const startDrag = (event: React.DragEvent, item: DraggedSidebarItem) => {
    if (renaming) {
      event.preventDefault()
      return
    }
    draggedItem.current = item
    setIsDragging(true)
    event.dataTransfer.effectAllowed = 'copyMove'
    event.dataTransfer.setData('text/plain', item.id)
    if (item.type === 'project') {
      const project = projects.find((entry) => entry.id === item.id)
      if (project) setReferenceDragData(event.dataTransfer, {
        kind: 'project', title: project.name, projectId: project.id
      })
    } else {
      const thread = threads.find((entry) => entry.id === item.id)
      if (thread) setReferenceDragData(event.dataTransfer, {
        kind: 'thread', title: thread.name, threadId: thread.id,
        projectId: thread.projectId
      })
    }
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

  const endDrag = () => {
    draggedItem.current = null
    setIsDragging(false)
  }



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

  const renderThreadRow = (thread: (typeof threads)[number], root = false, view: 'projects' | 'chats' = 'projects') => {

    const isSettled = Boolean(thread.settledAt)
    const isRenaming = renaming?.type === 'thread' && renaming.id === thread.id
    const isGeneratingTitle = pendingTitleIds.has(thread.id)
    const statusNode = renderThreadStatus(thread.id)
    const showTrailing = Boolean(statusNode || thread.worktreeEnabled)



    const hoverEnabled = !contextMenu && !isDragging && !isRenaming && !searchOpen && sidebarView === view

    return (

      <ThreadHoverCard
        key={thread.id}
        thread={thread}
        enabled={hoverEnabled}
      >
        {({ anchorRef, onMouseEnter, onMouseLeave }) => (
      <div

        ref={anchorRef}

        className="threads-sidebar-thread-container"

        onMouseEnter={onMouseEnter}

        onMouseLeave={onMouseLeave}

      >

      <button

        type="button"

        className={`threads-sidebar-thread${root ? ' threads-sidebar-thread-root' : ''}${

          activeThreadId === thread.id ? ' active' : ''

        }${thread.pinnedAt ? ' pinned' : ''}${isSettled ? ' settled' : ''}`}

        aria-current={activeThreadId === thread.id ? 'page' : undefined}

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

        {activeThreadId === thread.id && <span className="threads-sidebar-selected-dot" aria-hidden="true" />}

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

          <ScrollingThreadTitle name={thread.name} />

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

      {!isRenaming && (
        <span className="threads-sidebar-thread-actions">
          <button
            type="button"
            className={`threads-sidebar-thread-action${thread.pinnedAt ? ' active' : ''}`}
            aria-label={thread.pinnedAt ? `Unpin ${thread.name}` : `Pin ${thread.name}`}
            title={thread.pinnedAt ? 'Unpin' : 'Pin'}
            onClick={(event) => {
              event.stopPropagation()
              void window.mousse.threads.pin(thread.id, !thread.pinnedAt)
            }}
          >
            <Pin size={13} strokeWidth={2} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="threads-sidebar-thread-action"
            aria-label={isSettled ? `Unarchive ${thread.name}` : `Archive ${thread.name}`}
            title={isSettled ? 'Unarchive' : 'Archive'}
            onClick={(event) => {
              event.stopPropagation()
              void window.mousse.threads.settle(thread.id, !isSettled)
            }}
          >
            <Archive size={13} strokeWidth={2} aria-hidden="true" />
          </button>
        </span>
      )}

      </div>
        )}
      </ThreadHoverCard>

    )

  }



  return (

    <aside className={`threads-sidebar${className ? ` ${className}` : ''}`} style={{ width: threadsSidebarWidth }}>

      <div className="threads-sidebar-tabs" role="tablist" aria-label="Thread organization" onKeyDown={onTabKeyDown}>
        <button type="button" role="tab" id={`${tabsId}-projects-tab`} tabIndex={sidebarView === 'projects' ? 0 : -1} aria-selected={sidebarView === 'projects'} aria-controls={`${tabsId}-projects-panel`}
          className={`threads-sidebar-tab${sidebarView === 'projects' ? ' active' : ''}`} onClick={() => setSidebarView('projects')}>
          <FolderKanban size={17} strokeWidth={1.8} aria-hidden="true" />Projects
        </button>
        <button type="button" role="tab" id={`${tabsId}-chats-tab`} tabIndex={sidebarView === 'chats' ? 0 : -1} aria-selected={sidebarView === 'chats'} aria-controls={`${tabsId}-chats-panel`}
          className={`threads-sidebar-tab${sidebarView === 'chats' ? ' active' : ''}`} onClick={() => setSidebarView('chats')}>
          <MessagesSquare size={17} strokeWidth={1.8} aria-hidden="true" />Chats
        </button>
      </div>

      <div className="threads-sidebar-toolbar">
        <button type="button" className="threads-sidebar-toolbar-button" onClick={openSearch} title="Search threads" aria-label="Search threads">
          <Search size={18} strokeWidth={1.8} aria-hidden="true" />
        </button>
        <button type="button" className="threads-sidebar-toolbar-button" onClick={() => { if (sidebarView === 'chats') useChatsStore.setState({ newChatOpen: true }); else void createThread() }} title="New chat" aria-label="New chat">
          <Edit size={18} strokeWidth={1.8} aria-hidden="true" />
        </button>
      </div>

      <div className="threads-sidebar-scroll">

      <div className="threads-sidebar-section threads-sidebar-section-projects" role="tabpanel" id={`${tabsId}-projects-panel`} aria-labelledby={`${tabsId}-projects-tab`} hidden={sidebarView !== 'projects'}>

        <div className="threads-sidebar-tree">

          {projects.length === 0 ? (

            <div className="threads-sidebar-empty">No projects</div>

          ) : (

            projects.map((project) => {

              const expanded = expandedProjects.has(project.id)

              const projectThreads = availableThreads.filter((thread) => thread.projectId === project.id)

              const showAllProjectThreads = expandedProjectThreadLists.has(project.id)

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

                    className={`threads-sidebar-project-row${expanded ? ' expanded' : ''}${project.pinnedAt ? ' pinned' : ''}`}

                  >

                    <button

                      type="button"

                      className="threads-sidebar-project-toggle"

                      aria-expanded={expanded}

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
                        <FolderOpen size={18} strokeWidth={1.8} className="threads-sidebar-project-icon" aria-hidden="true" />
                      ) : (
                        <Folder size={18} strokeWidth={1.8} className="threads-sidebar-project-icon" aria-hidden="true" />
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

                        <>
                          <div
                            className={`threads-sidebar-thread-list${showAllProjectThreads ? ' expanded' : ''}`}
                            style={{ '--project-thread-count': projectThreads.length } as CSSProperties}
                          >
                            {projectThreads.map((thread) => renderThreadRow(thread))}
                          </div>
                          {projectThreads.length > PROJECT_THREAD_PREVIEW_LIMIT && (
                            <button
                              type="button"
                              className="threads-sidebar-show-more"
                              onClick={() => {
                                setExpandedProjectThreadLists((prev) => {
                                  const next = new Set(prev)
                                  if (showAllProjectThreads) next.delete(project.id)
                                  else next.add(project.id)
                                  return next
                                })
                              }}
                            >
                              {showAllProjectThreads ? 'Show less' : 'Show more'}
                            </button>
                          )}
                        </>

                      )}

                    </div>

                  )}

                </div>

              )

            })

          )}

        </div>

        <button type="button" className="threads-sidebar-open-project" onClick={() => void openProject()}>
          <FolderPlus size={17} strokeWidth={1.8} aria-hidden="true" />Open project
        </button>

        <section className="threads-sidebar-recent" aria-label="Recent threads">
          <h2 className="threads-sidebar-recent-heading">RECENTS</h2>
          <div className="threads-sidebar-tree">
            {orphanThreads.length === 0 ? <div className="threads-sidebar-empty">No recent chats</div> : orphanThreads.map((thread) => renderThreadRow(thread, true))}
          </div>
        </section>
      </div>



      <div className="threads-sidebar-section threads-sidebar-section-threads" role="tabpanel" id={`${tabsId}-chats-panel`} aria-labelledby={`${tabsId}-chats-tab`} hidden={sidebarView !== 'chats'}>
        {sidebarView === 'chats' && <ChatsSidebar />}
      </div>

      <div

        className={`threads-sidebar-section threads-sidebar-section-settled${settledExpanded ? '' : ' collapsed'}`}

        hidden={sidebarView !== 'projects'}

      >

        <div className="threads-sidebar-heading">

          <button
            type="button"
            className="threads-sidebar-heading-toggle"
            onClick={() => setSettledExpanded((expanded) => !expanded)}
            aria-expanded={settledExpanded}
            aria-label={settledExpanded ? 'Collapse archived threads' : 'Expand archived threads'}
          >
            <Archive size={14} strokeWidth={2} className="threads-sidebar-settled-icon" aria-hidden="true" />
            <span>Archived</span>
            <span className="threads-sidebar-settled-count">{settledThreads.length}</span>
          </button>

        </div>

        {settledExpanded && (
        <div className="threads-sidebar-tree threads-sidebar-settled-list">
          {settledThreads.length === 0 ? (
            <div className="threads-sidebar-empty">No settled threads</div>
          ) : (
            settledThreads.map((thread) => renderThreadRow(thread, true, 'chats'))
          )}
        </div>
        )}

      </div>

      </div>

      <div className="threads-sidebar-device" aria-label="Current computer">
        <Laptop size={18} strokeWidth={1.8} aria-hidden="true" />
        <div className="threads-sidebar-device-text">
          <span className="threads-sidebar-device-name" title={appInfo?.deviceName}>{appInfo?.deviceName || 'This computer'}</span>
          <span className="threads-sidebar-device-detail">This device</span>
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
