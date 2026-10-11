import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  IntegrationPlatformClient,
  IntegrationPlatformSnapshot
} from '../../../shared/integrationPlatform'
import type { McpServerConfig } from '../../../shared/integrations'
import type { McpServerTestResult } from '../../../shared/integrations/results'
import { asError, isManagedSource, snapshotItems } from './integrationUi'

export interface McpConnectionCheck {
  phase: 'checking' | 'complete' | 'signing-in'
  result?: McpServerTestResult
}

/** Results belong to this mounted profile/project and this connection revision. */
export function useMcpConnectionChecks(
  client: IntegrationPlatformClient,
  profileId: string,
  projectId: string | undefined,
  snapshot: IntegrationPlatformSnapshot | null
) {
  const [checks, setChecks] = useState<Record<string, McpConnectionCheck>>({})
  const alive = useRef(true)
  const checked = useRef(new Map<string, string>())
  const attempts = useRef(new Map<string, number>())
  const signingIn = useRef(new Set<string>())
  const identity = { profileId, projectId }
  useEffect(() => {
    alive.current = true
    const pending = signingIn.current
    return () => {
      alive.current = false
      for (const installationId of pending)
        void client.cancelMcpAuth({ profileId, projectId, installationId }).catch(() => {})
    }
  }, [client, profileId, projectId])

  const check = useCallback(
    async (server: McpServerConfig, force = false) => {
      const id = server.installationId ?? server.id
      const key = JSON.stringify([
        server.configRevision,
        server.enabled,
        server.transport,
        server.url,
        server.command,
        server.args,
        server.cwd,
        server.authMode
      ])
      if (
        !alive.current ||
        signingIn.current.has(id) ||
        (!force && checked.current.get(id) === key)
      )
        return
      checked.current.set(id, key)
      const attempt = (attempts.current.get(id) ?? 0) + 1
      attempts.current.set(id, attempt)
      setChecks((current) => ({ ...current, [id]: { phase: 'checking' } }))
      let result: McpServerTestResult
      try {
        result = await client.testMcp({ profileId, projectId, installationId: id })
      } catch (cause) {
        result = { success: false, error: asError(cause) }
      }
      if (alive.current && attempts.current.get(id) === attempt)
        setChecks((current) => ({ ...current, [id]: { phase: 'complete', result } }))
    },
    [client, profileId, projectId]
  )

  useEffect(() => {
    if (!snapshot) return
    let disposed = false
    const allServers = snapshotItems(snapshot).servers
    const enabledIds = new Set(
      allServers
        .filter((server) => server.enabled !== false)
        .map((server) => server.installationId ?? server.id)
    )
    for (const id of checked.current.keys())
      if (!enabledIds.has(id)) {
        checked.current.delete(id)
        attempts.current.set(id, (attempts.current.get(id) ?? 0) + 1)
        if (signingIn.current.delete(id))
          void client.cancelMcpAuth({ profileId, projectId, installationId: id }).catch(() => {})
      }
    const servers = allServers.filter(
      (server) => server.enabled !== false && isManagedSource(server.source, server.managed)
    )
    // Bound local process starts and remote probes; refreshes reuse unchanged results.
    let next = 0
    const worker = async () => {
      while (!disposed && next < servers.length) await check(servers[next++])
    }
    void worker()
    void worker()
    return () => {
      disposed = true
    }
  }, [snapshot, check, client, profileId, projectId])

  const authenticate = async (server: McpServerConfig) => {
    const installationId = server.installationId ?? server.id
    if (signingIn.current.has(installationId)) return
    signingIn.current.add(installationId)
    const attempt = (attempts.current.get(installationId) ?? 0) + 1
    attempts.current.set(installationId, attempt)
    setChecks((current) => ({ ...current, [installationId]: { phase: 'signing-in' } }))
    let currentServer = server
    try {
      // Explicit sign-in selects OAuth without replacing stored headers/client secrets.
      if (server.authMode !== 'oauth') {
        const record = await client.readMcp({ ...identity, installationId })
        if (!alive.current || attempts.current.get(installationId) !== attempt) return
        const updated = await client.updateMcp({
          ...identity,
          installationId,
          expectedRevision: record.revision,
          authMode: 'oauth'
        })
        currentServer = updated.server
      }
      if (!alive.current || attempts.current.get(installationId) !== attempt) return
      const result = await client.beginMcpAuth({ ...identity, installationId })
      if (!alive.current || attempts.current.get(installationId) !== attempt) return
      signingIn.current.delete(installationId)
      if (result.success) await check(currentServer, true)
      else
        setChecks((current) => ({
          ...current,
          [installationId]: {
            phase: 'complete',
            result: {
              success: false,
              errorCategory: 'auth-required',
              error: result.error ?? 'Sign-in was not completed.'
            }
          }
        }))
    } catch (cause) {
      if (alive.current && attempts.current.get(installationId) === attempt)
        setChecks((current) => ({
          ...current,
          [installationId]: {
            phase: 'complete',
            result: { success: false, errorCategory: 'auth-required', error: asError(cause) }
          }
        }))
    } finally {
      if (attempts.current.get(installationId) === attempt) signingIn.current.delete(installationId)
    }
  }
  const cancel = async (server: McpServerConfig) => {
    const installationId = server.installationId ?? server.id
    // A failed cancellation retains the pending indicator and cancellation control.
    try {
      await client.cancelMcpAuth({ ...identity, installationId })
    } catch (cause) {
      if (alive.current)
        setChecks((current) => ({
          ...current,
          [installationId]: {
            phase: 'signing-in',
            result: { success: false, error: asError(cause) }
          }
        }))
      return
    }
    attempts.current.set(installationId, (attempts.current.get(installationId) ?? 0) + 1)
    signingIn.current.delete(installationId)
    if (alive.current)
      setChecks((current) => ({
        ...current,
        [installationId]: {
          phase: 'complete',
          result: { success: false, errorCategory: 'auth-required', error: 'Sign-in cancelled.' }
        }
      }))
  }
  return { checks, authenticate, cancel, reset: () => checked.current.clear() }
}
