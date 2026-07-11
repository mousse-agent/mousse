import { useCallback, useEffect, useRef } from 'react'
import { Plus, TerminalSquare, X } from 'lucide-react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { PROJECT_SHELL_AGENT_ID } from '../../shared/types'
import { useFilesRoot } from '../hooks/useActiveProjectPath'
import { XTERM_FONT, getXtermTheme } from '../lib/xtermTheme'
import { useAppStore } from '../stores/appStore'

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
  const activeTabId = useAppStore((s) => s.activeProjectTerminalTabId)
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
  const activeThreadIdRef = useRef<string | null>(null)
  const seededRef = useRef(false)
  const fitFrameRef = useRef<number | null>(null)

  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null
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
        updateProjectTerminalTab(tabId, { ptyId: null, exited: false })
      }

      try {
        const { ptyId } = await window.mousse.pty.create({
          agentId: `${PROJECT_SHELL_AGENT_ID}:${tabId}`,
          cwd: terminalCwd
        })
        updateProjectTerminalTab(tabId, { ptyId, exited: false })
        mountTerminal(tabId, ptyId)
        if (useAppStore.getState().activeProjectTerminalTabId === tabId) {
          focusTerminal(ptyId)
        }
      } finally {
        spawningRef.current.delete(tabId)
      }
    },
    [terminalCwd, unmountTerminal, updateProjectTerminalTab, mountTerminal, focusTerminal]
  )

  const handleAddTab = useCallback(() => {
    if (!terminalCwd) return
    const tabId = addProjectTerminalTab()
    void spawnShellForTab(tabId)
  }, [addProjectTerminalTab, terminalCwd, spawnShellForTab])

  const handleCloseTab = useCallback(
    async (tabId: string) => {
      const tab = tabs.find((entry) => entry.id === tabId)
      if (tab?.ptyId) {
        await window.mousse.pty.kill(tab.ptyId).catch(() => {})
        unmountTerminal(tab.ptyId)
      }
      closeProjectTerminalTab(tabId)
    },
    [tabs, unmountTerminal, closeProjectTerminalTab]
  )

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
    if (tabs.length > 0) {
      seededRef.current = true
      return
    }
    if (!seededRef.current) {
      seededRef.current = true
      const tabId = addProjectTerminalTab()
      void spawnShellForTab(tabId)
    }
  }, [mainView, terminalCwd, tabs.length, addProjectTerminalTab, spawnShellForTab])

  useEffect(() => {
    const prevThreadId = activeThreadIdRef.current
    activeThreadIdRef.current = activeThreadId
    if (prevThreadId === null) return
    if (prevThreadId === activeThreadId) return

    const currentTabs = useAppStore.getState().projectTerminalTabs
    for (const tab of currentTabs) {
      if (tab.ptyId) {
        void window.mousse.pty.kill(tab.ptyId).catch(() => {})
        unmountTerminal(tab.ptyId)
      }
    }
    clearProjectTerminalTabs()
    seededRef.current = false
    terminalCwdRef.current = undefined
  }, [activeThreadId, unmountTerminal, clearProjectTerminalTabs])

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
    seededRef.current = false
  }, [terminalCwd, unmountTerminal, clearProjectTerminalTabs])

  useEffect(() => {
    for (const tab of tabs) {
      if (tab.ptyId && !instancesRef.current.has(tab.ptyId)) {
        mountTerminal(tab.id, tab.ptyId)
      } else if (!tab.ptyId && !tab.exited && terminalCwd && mainView === 'terminal') {
        void spawnShellForTab(tab.id)
      }
    }
  }, [tabs, terminalCwd, mainView, mountTerminal, spawnShellForTab])

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
    if (mainView !== 'terminal' || !activePtyId) return
    focusTerminal(activePtyId)
  }, [mainView, activePtyId, focusTerminal])

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
      <div className="terminal-tabs">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={`terminal-tab${tab.id === activeTabId ? ' active' : ''}`}
            role="tab"
            aria-selected={tab.id === activeTabId}
          >
            <button
              type="button"
              className="terminal-tab-select"
              onClick={() => setActiveProjectTerminalTab(tab.id)}
              title={tab.title}
            >
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
      <div
        className={`terminal-container${tabs.length === 0 ? ' terminal-container-empty' : ''}`}
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
        {terminalCwd && tabs.length === 0 && (
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
