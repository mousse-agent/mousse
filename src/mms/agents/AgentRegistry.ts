import { EventEmitter } from 'events'
import { v4 as uuidv4 } from 'uuid'
import type { Agent, AgentStatus } from '../../shared/types'

export class AgentRegistry extends EventEmitter {
  private agents = new Map<string, Agent>()
  private persistFn?: () => void

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
    if (!agent) return undefined
    agent.status = status
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
