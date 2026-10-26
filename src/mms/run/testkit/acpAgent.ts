import { agent, type AgentApp } from '@agentclientprotocol/sdk'
import { acpClientApp, type AcpConnection, type AcpConnectionFactory, type AcpLaunchRequest } from '../../harness/acp/connection'

/**
 * An ACP agent in the same process, for tests of the ACP core and the generic driver: each
 * connection gets a fresh agent app that `build` fills with handlers, wired to Mousse's real client
 * side (`acpClientApp`) without a process. Killing the fake process closes the connection.
 */
export interface InProcessAgentConnection {
  request: AcpLaunchRequest
  app: AgentApp
  connection: AcpConnection
  killed: boolean
}

export function inProcessAgent(build: (app: AgentApp, request: AcpLaunchRequest) => void): { connect: AcpConnectionFactory; connections: InProcessAgentConnection[] } {
  const connections: InProcessAgentConnection[] = []
  const connect: AcpConnectionFactory = (request) => {
    const app = agent({ name: 'fake-agent' })
    build(app, request)
    const entry = { request, app, killed: false } as InProcessAgentConnection
    let exitCode: number | null = null
    const active: AcpConnection = {
      child: {
        pid: 4242,
        get exitCode() { return exitCode },
        signalCode: null,
        kill: () => {
          if (exitCode !== null) return true
          exitCode = 0
          entry.killed = true
          active.connection.close()
          request.onExit?.()
          return true
        }
      },
      connection: undefined as unknown as AcpConnection['connection']
    }
    active.connection = acpClientApp(request.handlers, active).connect(app)
    entry.connection = active
    connections.push(entry)
    return active
  }
  return { connect, connections }
}
