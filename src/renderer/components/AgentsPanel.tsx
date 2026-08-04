import { useEffect, useRef, useCallback, useState } from 'react'
import { Bot, TerminalSquare, X } from 'lucide-react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { XTERM_FONT, getXtermTheme } from '../lib/xtermTheme'
import { confirmStopAgent } from '../lib/confirmStopAgent'
import { useAppStore } from '../stores/appStore'
import type { Agent } from '../../shared/types'
import { MousseAgentChat } from './MousseAgentChat'

interface TerminalInstance {
  ptyId: string
  agentId: string
  terminal: Terminal
  fitAddon: FitAddon
}

function isVisibleAgent(agent: Agent): boolean {
  return (
    agent.status !== 'completed' &&
    agent.status !== 'failed' &&
    agent.status !== 'cancelled' &&
    agent.status !== 'interrupted' &&
    (agent.executionMode === 'gui' || (agent.executionMode === 'interactive' && !!agent.ptyId))
  )
}

export function AgentsPanel() {
  const agents = useAppStore((s) => s.agents)
  const mainView = useAppStore((s) => s.mainView)
  const activePtyId = useAppStore((s) => s.activePtyId)
  const activeAgentId = useAppStore((s) => s.activeAgentId)
  const setActivePtyId = useAppStore((s) => s.setActivePtyId)
  const setActiveAgentId = useAppStore((s) => s.setActiveAgentId)

  const containerRef = useRef<HTMLDivElement>(null)
  const instancesRef = useRef<Map<string, TerminalInstance>>(new Map())
  const activeRef = useRef<string | null>(null)
  const fitFrameRef = useRef<number | null>(null)
  const [stoppingAgentIds, setStoppingAgentIds] = useState<Set<string>>(() => new Set())

  const visibleAgents = agents.filter(isVisibleAgent)
  const activeAgent = visibleAgents.find((agent) => agent.id === activeAgentId) ?? visibleAgents.at(-1)

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
        window.mousse.pty.resize(ptyId, dims.cols, dims.rows)
      }
      if (focus) {
        inst.terminal.focus()
      }
    })
  }, [])

  const focusTerminal = useCallback((ptyId: string) => {
    fitTerminal(ptyId, true)
  }, [fitTerminal])

  const mountTerminal = useCallback((agent: Agent) => {
    const ptyId = agent.ptyId
    if (agent.executionMode !== 'interactive' || !ptyId) return
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
    containerRef.current.appendChild(wrapper)

    terminal.open(wrapper)
    fitAddon.fit()

    terminal.onData((data) => {
      window.mousse.pty.write(ptyId, data)
    })

    instancesRef.current.set(ptyId, {
      ptyId,
      agentId: agent.id,
      terminal,
      fitAddon
    })
  }, [])

  useEffect(() => {
    const unsub = window.mousse.pty.onData(({ ptyId, data }) => {
      const inst = instancesRef.current.get(ptyId)
      inst?.terminal.write(data)
    })
    return unsub
  }, [])

  useEffect(() => {
    const unsubSpawned = window.mousse.agents.onSpawned((agent) => {
      setActiveAgentId(agent.id)
      if (agent.executionMode === 'interactive' && agent.ptyId) {
        mountTerminal(agent)
        setActivePtyId(agent.ptyId)
      }
    })
    const unsubActivated = window.mousse.agents.onActivated(({ agentId }) => {
      setActiveAgentId(agentId)
      const agent = agents.find((item) => item.id === agentId)
      if (agent?.ptyId) {
        setActivePtyId(agent.ptyId)
        focusTerminal(agent.ptyId)
      }
    })
    return () => {
      unsubSpawned()
      unsubActivated()
    }
  }, [agents, focusTerminal, mountTerminal, setActiveAgentId, setActivePtyId])

  useEffect(() => {
    const unsub = window.mousse.pty.onActivated(({ ptyId }) => {
      setActivePtyId(ptyId)
      focusTerminal(ptyId)
    })
    return unsub
  }, [focusTerminal, setActivePtyId])

  useEffect(() => {
    for (const agent of agents) {
      if (
        agent.executionMode === 'interactive' &&
        agent.ptyId &&
        !instancesRef.current.has(agent.ptyId)
      ) {
        mountTerminal(agent)
      }
    }
  }, [agents, mountTerminal])

  useEffect(() => {
    if (!activeAgentId && visibleAgents.length > 0) {
      setActiveAgentId(visibleAgents[visibleAgents.length - 1].id)
    }
  }, [activeAgentId, setActiveAgentId, visibleAgents])

  useEffect(() => {
    if (activeRef.current === activePtyId) return
    activeRef.current = activePtyId

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
    if (mainView !== 'agents' || !activePtyId || activeAgent?.executionMode !== 'interactive') return
    focusTerminal(activePtyId)
  }, [mainView, activePtyId, activeAgent?.executionMode, focusTerminal])

  useEffect(() => {
    const handleResize = () => {
      if (!activePtyId) return
      fitTerminal(activePtyId, false)
    }
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [activePtyId, fitTerminal])

  useEffect(() => {
    return () => {
      if (fitFrameRef.current !== null) {
        cancelAnimationFrame(fitFrameRef.current)
      }
    }
  }, [])

  const stopAgent = useCallback(async (agentId: string) => {
    setStoppingAgentIds((current) => new Set(current).add(agentId))
    try {
      await window.mousse.agents.stop(agentId)
    } finally {
      setStoppingAgentIds((current) => {
        const next = new Set(current)
        next.delete(agentId)
        return next
      })
    }
  }, [])

  const showEmpty = visibleAgents.length === 0
  const showGui = activeAgent?.executionMode === 'gui'
  const showTerminal = activeAgent?.executionMode === 'interactive' && !!activeAgent.ptyId

  return (
    <div className="terminal-panel agents-panel">
      <div className="terminal-tabs">
        {showEmpty ? (
          <span style={{ padding: '8px 16px', color: 'var(--text-secondary)', fontSize: 12 }}>
            No active agents
          </span>
        ) : (
          visibleAgents.map((agent) => (
            <button
              key={agent.id}
              className={`terminal-tab ${activeAgent?.id === agent.id ? 'active' : ''}`}
              onClick={() => {
                setActiveAgentId(agent.id)
                if (agent.ptyId) setActivePtyId(agent.ptyId)
              }}
              title={`${agent.cliType} — ${agent.id}`}
            >
              {agent.executionMode === 'gui' ? (
                <Bot size={13} strokeWidth={2} className="terminal-tab-icon" />
              ) : (
                <TerminalSquare size={13} strokeWidth={2} className="terminal-tab-icon" />
              )}
              <span className="cli-type">{agent.cliType}</span>
              {agent.id.slice(0, 8)}
              <span
                className="terminal-tab-close"
                role="button"
                aria-label={`Stop ${agent.cliType} agent`}
                title="Stop agent (worktree retained)"
                aria-disabled={stoppingAgentIds.has(agent.id)}
                onClick={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  if (!stoppingAgentIds.has(agent.id) && confirmStopAgent(agent)) {
                    void stopAgent(agent.id)
                  }
                }}
              >
                <X size={11} strokeWidth={2} />
              </span>
            </button>
          ))
        )}
      </div>
      <div
        className={`terminal-container agents-panel-body${showEmpty ? ' terminal-container-empty' : ''}`}
      >
        {showEmpty && (
          <div className="terminal-empty">
            <p>No agents yet</p>
            <p className="terminal-empty-hint">
              Use the orchestrator chat to spawn agents
            </p>
          </div>
        )}
        {visibleAgents
          .filter((agent) => agent.executionMode === 'gui')
          .map((agent) => (
            <MousseAgentChat
              key={agent.id}
              agentId={agent.id}
              active={showGui && activeAgent?.id === agent.id}
            />
          ))}
        <div
          className={`agents-terminal-host${showTerminal ? '' : ' hidden'}`}
          ref={containerRef}
        />
      </div>
    </div>
  )
}
