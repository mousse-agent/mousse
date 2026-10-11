import { useCallback, useEffect, useMemo, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { PROJECT_SHELL_AGENT_ID } from '../../shared/types'
import { useFilesRoot } from '../hooks/useActiveProjectPath'
import { XTERM_FONT, getXtermTheme, followXtermAppearance } from '../lib/xtermTheme'
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
  const setActiveProjectTerminalTab = useAppStore((s) => s.setActiveProjectTerminalTab)
  const updateProjectTerminalTab = useAppStore((s) => s.updateProjectTerminalTab)

  const containerRef = useRef<HTMLDivElement>(null)
  const instancesRef = useRef<Map<string, TerminalInstance>>(new Map())
  const spawningRef = useRef<Set<string>>(new Set())
  const activePtyRef = useRef<string | null>(null)
  const fitFrameRef = useRef<number | null>(null)

  const threadKey = activeThreadId ?? '__standalone__'
  const visibleTabs = useMemo(
    () => tabs.filter((tab) => tab.ownerThreadId === activeThreadId || tab.ownerThreadId === null),
    [activeThreadId, tabs]
  )
  const requestedActiveId = activeByThread[threadKey]
  const activeTab = visibleTabs.find((tab) => tab.id === requestedActiveId) ?? visibleTabs[0] ?? null
  const activeTabId = activeTab?.id ?? null
  const activePtyId = activeTab?.ptyId ?? null

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
        allowTransparency: true,
        cursorBlink: true,
        fontSize: 13,
        fontFamily: XTERM_FONT,
        theme: getXtermTheme()
      })

      followXtermAppearance(terminal)
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
      if (spawningRef.current.has(tabId)) return
      const tab = useAppStore.getState().projectTerminalTabs.find((entry) => entry.id === tabId)
      const cwd = tab?.cwd || terminalCwd
      if (!tab || !cwd) return
      spawningRef.current.add(tabId)

      if (tab.ptyId) {
        await window.mousse.pty.kill(tab.ptyId).catch(() => {})
        unmountTerminal(tab.ptyId)
        updateProjectTerminalTab(tabId, clearStalePtyBinding(tab))
      }

      try {
        const { ptyId } = await window.mousse.pty.create({
          agentId: `${PROJECT_SHELL_AGENT_ID}:${tabId}`,
          cwd
        })
        updateProjectTerminalTab(tabId, { ptyId, cwd, exited: false })
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
      if (mainView !== 'terminal') return
      if (spawningRef.current.has(tabId)) return

      const tab = useAppStore.getState().projectTerminalTabs.find((entry) => entry.id === tabId)
      if (!tab || (!tab.cwd && !terminalCwd)) return
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
      unmountTerminal(ptyId)
      void window.mousse.pty.kill(ptyId).catch(() => {})
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
