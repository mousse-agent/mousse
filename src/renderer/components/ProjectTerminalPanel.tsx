import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { PROJECT_SHELL_AGENT_ID } from '../../shared/types'
import { isQualifiedId } from '../../shared/threadRef'
import { useFilesRoot } from '../hooks/useActiveProjectPath'
import { xtermFont, getXtermTheme, followXtermAppearance } from '../lib/xtermTheme'
import { threadForSend } from '../lib/executeQuickAction'
import { composerWorkspaceFor, isNewEmptyThread } from '../lib/newThread'
import { useAppStore } from '../stores/appStore'
import {
  clearStalePtyBinding,
  resolveTerminalShellAction,
  terminalNoticeFor,
  type TerminalNotice
} from '../utils/terminalSession'
import { DelayedLoader } from './ui/DelayedLoader'

/**
 * True when the tab's thread is the shown new chat on this computer: its composer pick (project, worktree) is applied
 * before its terminal starts.
 */
function opensWithComposerPick(threadId: string): boolean {
  const state = useAppStore.getState()
  if (state.activeThreadId !== threadId) return false
  const thread = state.threads.find((entry) => entry.id === threadId)
  if (!isNewEmptyThread(threadId, thread, state.messages.length)) return false
  return !composerWorkspaceFor(state.composerWorkspaceDrafts[threadId], thread, state.worktreeByDefault).node
}

interface TerminalInstance {
  tabId: string
  ptyId: string
  terminal: Terminal
  fitAddon: FitAddon
  /** The terminal's thread, which a terminal on another computer is reached by. */
  threadId?: string
}

export function ProjectTerminalPanel() {
  const { root: terminalCwd } = useFilesRoot()
  const activeThreadId = useAppStore((s) => s.activeThreadId)
  const mainView = useAppStore((s) => s.mainView)
  // The other computers' terminals are listed only while someone can see the list.
  const mainAreaOpen = useAppStore((s) => s.mainAreaOpen)
  const tabs = useAppStore((s) => s.projectTerminalTabs)
  const activeByThread = useAppStore((s) => s.activeProjectTerminalTabByThread)
  const addProjectTerminalTab = useAppStore((s) => s.addProjectTerminalTab)
  const setActiveProjectTerminalTab = useAppStore((s) => s.setActiveProjectTerminalTab)
  const updateProjectTerminalTab = useAppStore((s) => s.updateProjectTerminalTab)

  const containerRef = useRef<HTMLDivElement>(null)
  const instancesRef = useRef<Map<string, TerminalInstance>>(new Map())
  const spawningRef = useRef<Set<string>>(new Set())
  const activePtyRef = useRef<string | null>(null)
  const fitFrameRef = useRef<number | null>(null)
  // Why a tab has no shell, by tab. A tab that failed to start waits for Retry instead of trying again on every change.
  const [notices, setNotices] = useState<Record<string, TerminalNotice>>({})
  const failedRef = useRef<Set<string>>(new Set())
  const setTabNotice = useCallback((tabId: string, next: TerminalNotice | null) => {
    if (next) failedRef.current.add(tabId)
    else failedRef.current.delete(tabId)
    setNotices(({ [tabId]: _old, ...rest }) => (next ? { ...rest, [tabId]: next } : rest))
  }, [])
  // Terminals another of the user's computers has open on this thread (this computer's own thread only).
  const [holders, setHolders] = useState<Array<{ ptyId: string; name: string }>>([])
  // Stops in flight or failed, by terminal. A holder leaves the list only when its Stop succeeds.
  const [holderStops, setHolderStops] = useState<Record<string, { busy: boolean; error?: string }>>({})

  useEffect(() => {
    if (mainView !== 'terminal' || !mainAreaOpen || !activeThreadId || isQualifiedId(activeThreadId)) {
      setHolders([])
      return
    }
    let cancelled = false
    const load = async (): Promise<void> => {
      try {
        const list = await window.mousse.pty.list()
        if (!cancelled)
          setHolders(list.flatMap((entry) => (entry.heldBy ? [{ ptyId: entry.ptyId, name: entry.heldBy.name }] : [])))
      } catch {
        /* the list is a courtesy: a failed read shows nothing */
      }
    }
    void load()
    const timer = setInterval(() => void load(), 5000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [mainView, mainAreaOpen, activeThreadId])

  // What was said about one thread's terminal is not said about another's.
  useEffect(() => {
    failedRef.current.clear()
    setNotices({})
    setHolderStops({})
  }, [activeThreadId])

  const stopHolder = useCallback((ptyId: string) => {
    setHolderStops((stops) => ({ ...stops, [ptyId]: { busy: true } }))
    window.mousse.pty.kill(ptyId, activeThreadId ?? undefined).then(() => {
      setHolders((held) => held.filter((entry) => entry.ptyId !== ptyId))
      setHolderStops(({ [ptyId]: _done, ...rest }) => rest)
    }, (error: unknown) => {
      setHolderStops((stops) => ({ ...stops, [ptyId]: { busy: false, error: error instanceof Error ? error.message : String(error) } }))
    })
  }, [activeThreadId])

  const threadKey = activeThreadId ?? '__standalone__'
  const visibleTabs = useMemo(
    () => tabs.filter((tab) => tab.ownerThreadId === activeThreadId || tab.ownerThreadId === null),
    [activeThreadId, tabs]
  )
  const requestedActiveId = activeByThread[threadKey]
  const activeTab = visibleTabs.find((tab) => tab.id === requestedActiveId) ?? visibleTabs[0] ?? null
  const activeTabId = activeTab?.id ?? null
  const activePtyId = activeTab?.ptyId ?? null
  const notice = activeTabId ? notices[activeTabId] ?? null : null

  const unmountTerminal = useCallback((ptyId: string) => {
    const inst = instancesRef.current.get(ptyId)
    if (!inst) return

    inst.terminal.dispose()
    instancesRef.current.delete(ptyId)

    const wrapper = containerRef.current?.querySelector(`[data-pty-id="${ptyId}"]`)
    wrapper?.remove()
  }, [])

  const fitTerminal = useCallback((ptyId: string, focus = true) => {
    const inst = instancesRef.current.get(ptyId)
    if (!inst) return

    if (fitFrameRef.current !== null) {
      cancelAnimationFrame(fitFrameRef.current)
    }

    fitFrameRef.current = requestAnimationFrame(() => {
      fitFrameRef.current = null
      inst.fitAddon.fit()
      const dims = inst.fitAddon.proposeDimensions()
      if (dims) {
        // The terminal may already have exited; a failed resize needs no report.
        void window.mousse.pty.resize(ptyId, dims.cols, dims.rows, inst.threadId).catch(() => {})
      }
      if (focus) {
        inst.terminal.focus()
      }
    })
  }, [])

  const focusTerminal = useCallback((ptyId: string) => {
    fitTerminal(ptyId, true)
  }, [fitTerminal])

  const mountTerminal = useCallback(
    (tabId: string, ptyId: string) => {
      if (!containerRef.current || instancesRef.current.has(ptyId)) return

      const terminal = new Terminal({
        allowTransparency: true,
        cursorBlink: true,
        fontSize: 13,
        fontFamily: xtermFont(),
        theme: getXtermTheme()
      })

      const fitAddon = new FitAddon()
      terminal.loadAddon(fitAddon)

      const wrapper = document.createElement('div')
      wrapper.className = 'xterm-wrapper'
      // A terminal reattached after the panel remounts (a reload, a profile switch) may already be the active one:
      // the effect that shows the active terminal has run by then, so it is shown here or it stays blank.
      const shown = activePtyRef.current === ptyId
      wrapper.style.display = shown ? 'block' : 'none'
      wrapper.dataset.ptyId = ptyId
      wrapper.dataset.tabId = tabId
      containerRef.current.appendChild(wrapper)

      terminal.open(wrapper)
      fitAddon.fit()
      // Only the shown terminal refits; a hidden one has no size and refits when it is shown.
      followXtermAppearance(terminal, () => {
        if (wrapper.style.display !== 'none') fitTerminal(ptyId, false)
      })

      const threadId =
        useAppStore.getState().projectTerminalTabs.find((entry) => entry.id === tabId)?.ownerThreadId ?? undefined
      terminal.onData((data) => {
        // Typing into a terminal that has exited fails on every key; that is expected, not an error.
        void window.mousse.pty.write(ptyId, data, threadId).catch(() => {})
      })

      instancesRef.current.set(ptyId, {
        tabId,
        ptyId,
        terminal,
        fitAddon,
        threadId
      })
      if (shown) fitTerminal(ptyId, false)
    },
    [fitTerminal]
  )

  const spawnShellForTab = useCallback(
    async (tabId: string) => {
      if (spawningRef.current.has(tabId)) return
      let tab = useAppStore.getState().projectTerminalTabs.find((entry) => entry.id === tabId)
      let cwd = tab?.cwd || terminalCwd || undefined
      if (!tab || !cwd) return
      spawningRef.current.add(tabId)

      try {
        if (tab.ptyId) {
          await window.mousse.pty.kill(tab.ptyId, tab.ownerThreadId ?? undefined).catch(() => {})
          unmountTerminal(tab.ptyId)
          updateProjectTerminalTab(tabId, clearStalePtyBinding(tab))
        }

        // A new chat runs where the composer says (a project, a worktree) only once that pick is applied, as the first
        // send does; until then it is a thread with no folder. Apply it first, so the terminal starts in that folder.
        if (tab.ownerThreadId && !isQualifiedId(tab.ownerThreadId) && opensWithComposerPick(tab.ownerThreadId)) {
          const state = useAppStore.getState()
          const from = tab.ownerThreadId
          const moveTab = (threadId: string): void => {
            useAppStore.getState().updateProjectTerminalTab(tabId, { ownerThreadId: threadId })
            useAppStore.getState().setActiveProjectTerminalTab(threadId, tabId)
          }
          const threadId = await threadForSend(state.profileId, moveTab)
          if (!threadId) return
          if (threadId !== from) moveTab(threadId)
          tab = useAppStore.getState().projectTerminalTabs.find((entry) => entry.id === tabId)
          if (!tab) return
          // The folder read for the draft is not the new thread's: the service picks the thread's own.
          cwd = undefined
        }

        const { ptyId } = await window.mousse.pty.create({
          agentId: `${PROJECT_SHELL_AGENT_ID}:${tabId}`,
          ...(cwd ? { cwd } : {}),
          // The tab's own thread, not whichever thread the window shows now; a tab kept in every thread has none.
          threadId: tab.ownerThreadId
        })
        setTabNotice(tabId, null)
        updateProjectTerminalTab(tabId, { ptyId, ...(cwd ? { cwd } : {}), exited: false })
        mountTerminal(tabId, ptyId)
        const state = useAppStore.getState()
        const key = state.activeThreadId ?? '__standalone__'
        if (state.activeProjectTerminalTabByThread[key] === tabId) {
          focusTerminal(ptyId)
        }
      } catch (error) {
        // The tab says why it has no shell (the thread is busy, the computer is offline) and waits for Retry.
        setTabNotice(tabId, terminalNoticeFor(error))
      } finally {
        spawningRef.current.delete(tabId)
      }
    },
    [terminalCwd, unmountTerminal, updateProjectTerminalTab, mountTerminal, focusTerminal, setTabNotice]
  )

  /**
   * When opening/switching to a tab, detect stale PTY ids (main process restarted or
   * session died without an exit event reaching this renderer) and recreate safely.
   * Genuine exits keep the overlay — no infinite auto-respawn.
   */
  const reconcileTabSession = useCallback(
    async (tabId: string) => {
      if (mainView !== 'terminal') return
      if (spawningRef.current.has(tabId) || failedRef.current.has(tabId)) return

      const tab = useAppStore.getState().projectTerminalTabs.find((entry) => entry.id === tabId)
      if (!tab || (!tab.cwd && !terminalCwd)) return
      if (tab.ownerThreadId !== activeThreadId && tab.ownerThreadId !== null) return

      let isAlive = false
      if (tab.ptyId) {
        try {
          isAlive = await window.mousse.pty.isAlive(tab.ptyId, tab.ownerThreadId ?? undefined)
        } catch {
          isAlive = false
        }
      }

      const action = resolveTerminalShellAction({
        ptyId: tab.ptyId,
        exited: tab.exited,
        isAlive
      })

      if (action === 'none' || action === 'show_exited') {
        if (action === 'none' && tab.ptyId && !instancesRef.current.has(tab.ptyId)) {
          mountTerminal(tab.id, tab.ptyId)
        }
        return
      }

      if (action === 'recreate' && tab.ptyId) {
        unmountTerminal(tab.ptyId)
        updateProjectTerminalTab(tabId, clearStalePtyBinding(tab))
      }

      await spawnShellForTab(tabId)
    },
    [
      terminalCwd,
      mainView,
      activeThreadId,
      mountTerminal,
      unmountTerminal,
      updateProjectTerminalTab,
      spawnShellForTab
    ]
  )

  const handleAddTab = useCallback(() => {
    if (!terminalCwd) return
    const tabId = addProjectTerminalTab(activeThreadId)
    void spawnShellForTab(tabId)
  }, [addProjectTerminalTab, activeThreadId, terminalCwd, spawnShellForTab])

  useEffect(() => {
    const unsub = window.mousse.pty.onData(({ ptyId, data }) => {
      instancesRef.current.get(ptyId)?.terminal.write(data)
    })
    return unsub
  }, [])

  useEffect(() => {
    const live = new Set(tabs.flatMap((tab) => (tab.ptyId ? [tab.ptyId] : [])))
    for (const ptyId of instancesRef.current.keys()) {
      if (live.has(ptyId)) continue
      const threadId = instancesRef.current.get(ptyId)?.threadId
      unmountTerminal(ptyId)
      void window.mousse.pty.kill(ptyId, threadId).catch(() => {})
    }
  }, [tabs, unmountTerminal])

  useEffect(() => {
    const unsub = window.mousse.pty.onExit(({ ptyId, agentId }) => {
      if (!agentId.startsWith(PROJECT_SHELL_AGENT_ID)) return
      const inst = instancesRef.current.get(ptyId)
      if (!inst) return
      updateProjectTerminalTab(inst.tabId, { ptyId: null, exited: true })
      unmountTerminal(ptyId)
    })
    return unsub
  }, [updateProjectTerminalTab, unmountTerminal])

  useEffect(() => {
    if (activeTab && requestedActiveId !== activeTab.id) {
      setActiveProjectTerminalTab(activeThreadId, activeTab.id)
    }
  }, [activeTab?.id, activeThreadId, requestedActiveId, setActiveProjectTerminalTab])

  useEffect(() => {
    if (mainView !== 'terminal' || !terminalCwd) return
    for (const tab of tabs) {
      if (tab.ownerThreadId === activeThreadId || tab.ownerThreadId === null) {
        void reconcileTabSession(tab.id)
      }
    }
  }, [tabs, terminalCwd, mainView, activeThreadId, reconcileTabSession])

  useEffect(() => {
    if (activePtyRef.current === activePtyId) return
    activePtyRef.current = activePtyId

    const container = containerRef.current
    if (!container) return

    for (const wrapper of container.querySelectorAll('.xterm-wrapper')) {
      const el = wrapper as HTMLElement
      el.style.display = el.dataset.ptyId === activePtyId ? 'block' : 'none'
    }

    if (activePtyId) {
      focusTerminal(activePtyId)
    }
  }, [activePtyId, focusTerminal])

  useEffect(() => {
    if (mainView !== 'terminal') return
    if (activeTabId) {
      void reconcileTabSession(activeTabId)
    }
    if (activePtyId) {
      focusTerminal(activePtyId)
    }
  }, [mainView, activeTabId, activePtyId, focusTerminal, reconcileTabSession])

  useEffect(() => {
    if (mainView !== 'terminal' || !activePtyId) return

    const handleResize = () => fitTerminal(activePtyId, false)
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [mainView, activePtyId, fitTerminal])

  useEffect(() => {
    return () => {
      if (fitFrameRef.current !== null) {
        cancelAnimationFrame(fitFrameRef.current)
      }
    }
  }, [])

  return (
    <div className="terminal-panel project-terminal-panel">
      {holders.map((holder) => {
        const stop = holderStops[holder.ptyId]
        return (
          <div key={holder.ptyId} className="terminal-remote-holder" role="status">
            <span>{holder.name} has a terminal open on this thread.</span>
            {stop?.error && <span className="terminal-remote-holder-error" role="alert" title={stop.error}>Couldn’t stop it</span>}
            <button
              type="button"
              className="btn"
              disabled={stop?.busy}
              onClick={() => stopHolder(holder.ptyId)}
            >
              {stop?.error ? 'Retry' : 'Stop'}
            </button>
          </div>
        )
      })}
      <div
        className={`terminal-container${visibleTabs.length === 0 ? ' terminal-container-empty' : ''}`}
        ref={containerRef}
      >
        {!terminalCwd && (
          <div className="terminal-empty">
            <DelayedLoader label="Loading terminal" />
          </div>
        )}
        {activeTab?.exited && terminalCwd && (
          <div className="terminal-exited-overlay">
            <span>Shell exited</span>
            <button
              type="button"
              className="btn"
              onClick={() => void spawnShellForTab(activeTab.id)}
            >
              Restart shell
            </button>
          </div>
        )}
        {notice && activeTab && (
          <div className="terminal-empty" role="status">
            <p>{notice.message}</p>
            {notice.hint && <p>{notice.hint}</p>}
            <button
              type="button"
              className="btn"
              onClick={() => {
                setTabNotice(activeTab.id, null)
                void spawnShellForTab(activeTab.id)
              }}
            >
              Retry
            </button>
          </div>
        )}
        {terminalCwd && visibleTabs.length === 0 && !notice && (
          <div className="terminal-empty">
            <p>No terminals open</p>
            <button type="button" className="btn btn-primary" onClick={handleAddTab}>
              New terminal
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
