import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { Pin, Plus, TerminalSquare, X } from 'lucide-react'
import { PinOffRegular, PinRegular } from '@fluentui/react-icons'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { PROJECT_SHELL_AGENT_ID } from '../../shared/types'
import { useFilesRoot } from '../hooks/useActiveProjectPath'
import { XTERM_FONT, getXtermTheme } from '../lib/xtermTheme'
import { useAppStore } from '../stores/appStore'
import {
  clearStalePtyBinding,
  resolveTerminalShellAction
} from '../utils/terminalSession'

interface TerminalInstance {
  tabId: string
  ptyId: string
  terminal: Terminal
  fitAddon: FitAddon
}

export function ProjectTerminalPanel() {
  const { root: terminalCwd } = useFilesRoot()
  const activeThreadId = useAppStore((s) => s.activeThreadId)
  const mainView = useAppStore((s) => s.mainView)
  const tabs = useAppStore((s) => s.projectTerminalTabs)
  const activeByThread = useAppStore((s) => s.activeProjectTerminalTabByThread)
  const addProjectTerminalTab = useAppStore((s) => s.addProjectTerminalTab)
  const closeProjectTerminalTab = useAppStore((s) => s.closeProjectTerminalTab)
  const setActiveProjectTerminalTab = useAppStore((s) => s.setActiveProjectTerminalTab)
  const updateProjectTerminalTab = useAppStore((s) => s.updateProjectTerminalTab)
  const clearProjectTerminalTabs = useAppStore((s) => s.clearProjectTerminalTabs)

  const containerRef = useRef<HTMLDivElement>(null)
  const instancesRef = useRef<Map<string, TerminalInstance>>(new Map())
  const spawningRef = useRef<Set<string>>(new Set())
  const activePtyRef = useRef<string | null>(null)
  const terminalCwdRef = useRef<string | undefined>(undefined)
  const menuRef = useRef<HTMLDivElement>(null)
  const fitFrameRef = useRef<number | null>(null)

  const [menuTabId, setMenuTabId] = useState<string | null>(null)
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null)

  const threadKey = activeThreadId ?? '__standalone__'
  const visibleTabs = useMemo(
    () => tabs.filter((tab) => tab.ownerThreadId === activeThreadId || tab.ownerThreadId === null),
    [activeThreadId, tabs]
  )
  const requestedActiveId = activeByThread[threadKey]
  const activeTab = visibleTabs.find((tab) => tab.id === requestedActiveId) ?? visibleTabs[0] ?? null
  const activeTabId = activeTab?.id ?? null
  const activePtyId = activeTab?.ptyId ?? null
  const menuTab = menuTabId ? tabs.find((tab) => tab.id === menuTabId) ?? null : null

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
        void window.mousse.pty.resize(ptyId, dims.cols, dims.rows)
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
        cursorBlink: true,
        fontSize: 13,
        fontFamily: XTERM_FONT,
        theme: getXtermTheme()
      })

      const fitAddon = new FitAddon()
      terminal.loadAddon(fitAddon)

      const wrapper = document.createElement('div')
      wrapper.className = 'xterm-wrapper'
      wrapper.style.display = 'none'
      wrapper.dataset.ptyId = ptyId
      wrapper.dataset.tabId = tabId
      containerRef.current.appendChild(wrapper)

      terminal.open(wrapper)
      fitAddon.fit()

      terminal.onData((data) => {
        void window.mousse.pty.write(ptyId, data)
      })

      instancesRef.current.set(ptyId, {
        tabId,
        ptyId,
        terminal,
        fitAddon
      })
    },
    []
  )

  const spawnShellForTab = useCallback(
    async (tabId: string) => {
      if (!terminalCwd || spawningRef.current.has(tabId)) return
      spawningRef.current.add(tabId)

      const tab = useAppStore.getState().projectTerminalTabs.find((entry) => entry.id === tabId)
      if (tab?.ptyId) {
        await window.mousse.pty.kill(tab.ptyId).catch(() => {})
        unmountTerminal(tab.ptyId)
        updateProjectTerminalTab(tabId, clearStalePtyBinding(tab))
      }

      try {
        const { ptyId } = await window.mousse.pty.create({
          agentId: `${PROJECT_SHELL_AGENT_ID}:${tabId}`,
          cwd: terminalCwd
        })
        updateProjectTerminalTab(tabId, { ptyId, exited: false })
        mountTerminal(tabId, ptyId)
        const state = useAppStore.getState()
        const key = state.activeThreadId ?? '__standalone__'
        if (state.activeProjectTerminalTabByThread[key] === tabId) {
          focusTerminal(ptyId)
        }
      } finally {
        spawningRef.current.delete(tabId)
      }
    },
    [terminalCwd, unmountTerminal, updateProjectTerminalTab, mountTerminal, focusTerminal]
  )

  /**
   * When opening/switching to a tab, detect stale PTY ids (main process restarted or
   * session died without an exit event reaching this renderer) and recreate safely.
   * Genuine exits keep the overlay — no infinite auto-respawn.
   */
  const reconcileTabSession = useCallback(
    async (tabId: string) => {
      if (!terminalCwd || mainView !== 'terminal') return
      if (spawningRef.current.has(tabId)) return

      const tab = useAppStore.getState().projectTerminalTabs.find((entry) => entry.id === tabId)
      if (!tab) return
      if (tab.ownerThreadId !== activeThreadId && tab.ownerThreadId !== null) return

      let isAlive = false
      if (tab.ptyId) {
        try {
          isAlive = await window.mousse.pty.isAlive(tab.ptyId)
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

  const handleCloseTab = useCallback(
    async (tabId: string) => {
      const tab = tabs.find((entry) => entry.id === tabId)
      if (tab?.ptyId) {
        await window.mousse.pty.kill(tab.ptyId).catch(() => {})
        unmountTerminal(tab.ptyId)
      }
      closeProjectTerminalTab(tabId)
      if (menuTabId === tabId) {
        setMenuTabId(null)
        setMenuPos(null)
      }
    },
    [tabs, unmountTerminal, closeProjectTerminalTab, menuTabId]
  )

  const handleTogglePin = useCallback(
    (tabId: string) => {
      const tab = tabs.find((entry) => entry.id === tabId)
      if (!tab) return
      updateProjectTerminalTab(tabId, {
        ownerThreadId: tab.ownerThreadId === null ? activeThreadId : null
      })
      setMenuTabId(null)
      setMenuPos(null)
    },
    [tabs, activeThreadId, updateProjectTerminalTab]
  )

  const openTabMenu = useCallback((tabId: string, event: ReactMouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
    setMenuTabId(tabId)
    setMenuPos({ x: event.clientX, y: event.clientY })
  }, [])

  useEffect(() => {
    const unsub = window.mousse.pty.onData(({ ptyId, data }) => {
      instancesRef.current.get(ptyId)?.terminal.write(data)
    })
    return unsub
  }, [])

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
    if (mainView !== 'terminal' || !terminalCwd) return
    if (visibleTabs.length > 0) return
    const tabId = addProjectTerminalTab(activeThreadId)
    void spawnShellForTab(tabId)
  }, [mainView, terminalCwd, visibleTabs.length, activeThreadId, addProjectTerminalTab, spawnShellForTab])

  useEffect(() => {
    if (activeTab && requestedActiveId !== activeTab.id) {
      setActiveProjectTerminalTab(activeThreadId, activeTab.id)
    }
  }, [activeTab?.id, activeThreadId, requestedActiveId, setActiveProjectTerminalTab])

  useEffect(() => {
    if (!terminalCwd) return

    const prevCwd = terminalCwdRef.current
    terminalCwdRef.current = terminalCwd
    if (prevCwd === undefined) return
    if (prevCwd === terminalCwd) return

    const currentTabs = useAppStore.getState().projectTerminalTabs
    for (const tab of currentTabs) {
      if (tab.ptyId) {
        void window.mousse.pty.kill(tab.ptyId).catch(() => {})
        unmountTerminal(tab.ptyId)
      }
    }
    clearProjectTerminalTabs()
  }, [terminalCwd, unmountTerminal, clearProjectTerminalTabs])

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
    if (!menuTabId) return
    const close = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) {
        setMenuTabId(null)
        setMenuPos(null)
      }
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMenuTabId(null)
        setMenuPos(null)
      }
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', onKey)
    }
  }, [menuTabId])

  useEffect(() => {
    return () => {
      if (fitFrameRef.current !== null) {
        cancelAnimationFrame(fitFrameRef.current)
      }
    }
  }, [])

  return (
    <div className="terminal-panel project-terminal-panel">
      <div className="terminal-tabs">
        {visibleTabs.map((tab) => (
          <div
            key={tab.id}
            className={`terminal-tab${tab.id === activeTabId ? ' active' : ''}`}
            role="tab"
            aria-selected={tab.id === activeTabId}
            onContextMenu={(event) => openTabMenu(tab.id, event)}
          >
            <button
              type="button"
              className="terminal-tab-select"
              onClick={() => setActiveProjectTerminalTab(activeThreadId, tab.id)}
              title={tab.title}
            >
              {tab.ownerThreadId === null && (
                <Pin size={10} className="terminal-tab-pin-icon" aria-hidden="true" />
              )}
              <TerminalSquare size={13} strokeWidth={2} className="terminal-tab-icon" />
              <span>{tab.title}</span>
            </button>
            <button
              type="button"
              className="terminal-tab-close"
              onClick={() => void handleCloseTab(tab.id)}
              aria-label={`Close ${tab.title}`}
              title="Close terminal"
            >
              <X size={12} strokeWidth={2} />
            </button>
          </div>
        ))}
        <button
          type="button"
          className="terminal-tab-add"
          onClick={handleAddTab}
          disabled={!terminalCwd}
          aria-label="New terminal"
          title="New terminal"
        >
          <Plus size={14} strokeWidth={2} />
        </button>
      </div>
      {menuTab && menuPos && (
        <div
          ref={menuRef}
          className="terminal-tab-menu"
          style={{ left: menuPos.x, top: menuPos.y }}
          role="menu"
        >
          <button type="button" role="menuitem" onClick={() => handleTogglePin(menuTab.id)}>
            <span>
              {menuTab.ownerThreadId === null ? 'Unpin from all threads' : 'Pin across threads'}
            </span>
            {menuTab.ownerThreadId === null ? <PinOffRegular /> : <PinRegular />}
          </button>
        </div>
      )}
      <div
        className={`terminal-container${visibleTabs.length === 0 ? ' terminal-container-empty' : ''}`}
        ref={containerRef}
      >
        {!terminalCwd && (
          <div className="terminal-empty">
            <p>Loading terminal…</p>
          </div>
        )}
        {activeTab?.exited && terminalCwd && (
          <div className="terminal-exited-overlay">
            <p>Shell exited</p>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void spawnShellForTab(activeTab.id)}
            >
              Restart shell
            </button>
          </div>
        )}
        {terminalCwd && visibleTabs.length === 0 && (
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
