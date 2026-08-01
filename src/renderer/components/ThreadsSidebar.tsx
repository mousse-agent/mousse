import { useCallback, useEffect, useRef, useState } from 'react'

import { ChevronDown, ChevronRight, Clock, Edit, Loader2, MessageSquarePlus, Pin, Plus, Radio, Search } from 'lucide-react'

import { isThreadStarted } from '../../shared/threadTitle'
import { useAppStore } from '../stores/appStore'

import {
  ThreadsContextMenu,

  type ThreadsContextMenuTarget

} from './ThreadsContextMenu'

import { ThreadSearchDialog } from './ThreadSearchDialog'

import '../styles/threads-sidebar.css'



const MIN_SECTION_RATIO = 0.15

const MAX_SECTION_RATIO = 0.85



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



export function ThreadsSidebar() {

  const projects = useAppStore((s) => s.projects)

  const threads = useAppStore((s) => s.threads)

  const activeThreadId = useAppStore((s) => s.activeThreadId)

  const threadActivity = useAppStore((s) => s.threadActivity)

  const setScheduledOpen = useAppStore((s) => s.setScheduledOpen)

  const setChannelsOpen = useAppStore((s) => s.setChannelsOpen)

  const [searchOpen, setSearchOpen] = useState(false)

  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set())

  const [settledExpanded, setSettledExpanded] = useState(false)

  const [projectsRatio, setProjectsRatio] = useState(0.5)

  const [contextMenu, setContextMenu] = useState<{

    x: number

    y: number

    target: ThreadsContextMenuTarget

  } | null>(null)

  const [renaming, setRenaming] = useState<RenamingTarget | null>(null)

  const sidebarRef = useRef<HTMLElement>(null)

  const draggingDivider = useRef(false)
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
    await window.mousse.threads.select(thread.id)
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
    await window.mousse.threads.regenerateTitle(threadId)
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



  const onDividerMouseDown = useCallback(() => {

    draggingDivider.current = true

    document.body.style.cursor = 'row-resize'

    document.body.style.userSelect = 'none'

  }, [])



  useEffect(() => {

    const onMouseMove = (e: MouseEvent) => {

      if (!draggingDivider.current || !sidebarRef.current) return



      const rect = sidebarRef.current.getBoundingClientRect()

      const ratio = (e.clientY - rect.top) / rect.height

      setProjectsRatio(Math.min(MAX_SECTION_RATIO, Math.max(MIN_SECTION_RATIO, ratio)))

    }



    const onMouseUp = () => {

      if (!draggingDivider.current) return

      draggingDivider.current = false

      document.body.style.cursor = ''

      document.body.style.userSelect = ''

    }



    window.addEventListener('mousemove', onMouseMove)

    window.addEventListener('mouseup', onMouseUp)

    return () => {

      window.removeEventListener('mousemove', onMouseMove)

      window.removeEventListener('mouseup', onMouseUp)

    }

  }, [])



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

  const renderThreadRow = (thread: (typeof threads)[number], root = false) => {

    const isSettled = Boolean(thread.settledAt)
    const isRenaming = renaming?.type === 'thread' && renaming.id === thread.id



    return (

      <button

        key={thread.id}

        type="button"

        className={`threads-sidebar-thread${root ? ' threads-sidebar-thread-root' : ''}${

          activeThreadId === thread.id ? ' active' : ''

        }${thread.pinnedAt ? ' pinned' : ''}${isSettled ? ' settled' : ''}`}

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

        ) : (

          <span className="threads-sidebar-thread-name">{thread.name}</span>

        )}

        {renderThreadStatus(thread.id)}

      </button>

    )

  }



  return (

    <aside className="threads-sidebar" ref={sidebarRef} style={{ width: threadsSidebarWidth }}>

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

      <div

        className="threads-sidebar-section threads-sidebar-section-projects"

        style={{ flex: `${projectsRatio} 1 0` }}

      >

        <div className="threads-sidebar-heading">

          <span>Projects</span>

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

      </div>



      <div

        className="threads-sidebar-divider"

        onMouseDown={onDividerMouseDown}

        role="separator"

        aria-orientation="horizontal"

        aria-label="Resize Projects and Threads sections"

      />



      <div

        className="threads-sidebar-section threads-sidebar-section-threads"

        style={{ flex: `${1 - projectsRatio} 1 0` }}

      >

        <div className="threads-sidebar-heading">

          <span>Threads</span>

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

        <div className="threads-sidebar-tree">

          {orphanThreads.length === 0 ? (

            <div className="threads-sidebar-empty">No threads</div>

          ) : (

            orphanThreads.map((thread) => renderThreadRow(thread, true))

          )}

          <button
            type="button"
            className="threads-sidebar-settled-toggle"
            onClick={() => setSettledExpanded((expanded) => !expanded)}
            aria-expanded={settledExpanded}
          >
            {settledExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            <span>Settled</span>
            <span className="threads-sidebar-settled-count">{settledThreads.length}</span>
          </button>
          {settledExpanded && (
            <div className="threads-sidebar-settled-list">
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


