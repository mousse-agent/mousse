import { EventEmitter } from 'events'
import { v4 as uuidv4 } from 'uuid'
import { normalizeAgentStatus, type Agent, type AgentStatus } from '../../shared/types'
import { AgentLifecycleService } from './AgentLifecycleService'

export class AgentRegistry extends EventEmitter {
  private agents = new Map<string, Agent>()
  private persistFn?: () => void
  private lifecycle = new AgentLifecycleService()

  setPersistCallback(fn: () => void): void {
    this.persistFn = fn
  }

  private persist(): void {
    this.persistFn?.()
  }

  load(agents: Agent[]): void {
    this.agents.clear()
    for (const agent of agents) {
      this.agents.set(agent.id, {
        ...agent,
        status: normalizeAgentStatus(agent.status),
        executionMode: agent.executionMode ?? (agent.ptyId ? 'interactive' : 'headless')
      })
    }
  }

  create(data: Omit<Agent, 'id' | 'createdAt'>, id = uuidv4()): Agent {
    if (this.agents.has(id)) {
      throw new Error(`Agent "${id}" already exists`)
    }
    const agent: Agent = {
      ...data,
      id,
      createdAt: new Date().toISOString()
    }
    this.agents.set(agent.id, agent)
    this.emit('updated', this.list())
    this.persist()
    return agent
  }

  get(id: string): Agent | undefined {
    return this.agents.get(id)
  }

  list(): Agent[] {
    return Array.from(this.agents.values())
  }

  updateStatus(id: string, status: AgentStatus): Agent | undefined {
    const agent = this.agents.get(id)
    if (!agent || !this.lifecycle.canTransition(agent.status, status)) return undefined
    agent.status = status
    this.emit('updated', this.list())
    this.persist()
    return agent
  }

  /** Explicit transition API for process owners; invalid late transitions are rejected. */
  transitionStatus(id: string, status: AgentStatus): Agent | undefined {
    return this.updateStatus(id, status)
  }

  updateExitMetadata(
    id: string,
    exit: { code: number | null; signal: string | null; at: string }
  ): Agent | undefined {
    const agent = this.agents.get(id)
    if (!agent) return undefined
    agent.exitCode = exit.code
    agent.exitSignal = exit.signal
    agent.exitedAt = exit.at
    this.emit('updated', this.list())
    this.persist()
    return agent
  }

  updatePtyId(id: string, ptyId: string): Agent | undefined {
    const agent = this.agents.get(id)
    if (!agent) return undefined
    agent.ptyId = ptyId
    this.emit('updated', this.list())
    this.persist()
    return agent
  }

  remove(id: string): void {
    this.agents.delete(id)
    this.emit('updated', this.list())
    this.persist()
  }

  clear(): void {
    this.agents.clear()
    this.emit('updated', this.list())
  }
}
