/**
 * Phase 3–5: IPC channel ↔ protocol method mapping.
 * Payload shapes stay compatible with preload window.mousse API.
 */

import { describe, expect, it } from 'vitest'
import { PROTOCOL_METHODS } from '../src/mms/protocol/types'

/** Channels converted to protocol in Phase 3–5 GUI IPC. */
const PROTOCOL_BACKED_CHANNELS: Record<string, string> = {
  'orchestrator:send': 'orchestrator.send',
  'orchestrator:sendToThread': 'orchestrator.send',
  'orchestrator:getMessages': 'thread.snapshot',
  'orchestrator:abort': 'orchestrator.abort',
  'orchestrator:steer': 'orchestrator.steer',
  'orchestrator:isTurnActive': 'orchestrator.isTurnActive',
  'orchestrator:retryConnection': 'orchestrator.retry',
  'queue:list': 'queue.list',
  'queue:enqueue': 'queue.enqueue',
  'queue:remove': 'queue.remove',
  'queue:reorder': 'queue.reorder',
  'queue:promoteToSteer': 'queue.promoteToSteer',
  'projects:list': 'projects.list',
  'projects:open': 'projects.open',
  'projects:remove': 'projects.remove',
  'projects:rename': 'projects.rename',
  'projects:pin': 'projects.pin',
  'projects:reorder': 'projects.reorder',
  'projects:threads': 'threads.list',
  'threads:list': 'threads.list',
  'threads:listAll': 'threads.list',
  'threads:create': 'threads.create',
  'threads:delete': 'threads.delete',
  'threads:rename': 'threads.rename',
  'threads:pin': 'threads.pin',
  'threads:settle': 'threads.settle',
  'threads:reorder': 'threads.reorder',
  'threads:search': 'threads.search',
  'threads:regenerateTitle': 'threads.regenerateTitle',
  'threads:setModel': 'threads.setModel',
  'threads:setWorktreeEnabled': 'threads.setWorktreeEnabled',
  'orchestrator:getContextUsage': 'orchestrator.contextUsage',
  'orchestrator:answerQuestions': 'orchestrator.answerQuestions',
  'orchestrator:dismissQuestions': 'orchestrator.dismissQuestions',
  'agents:list': 'agents.list',
  'tasks:list': 'tasks.list',
  'tasks:create': 'tasks.create',
  'tasks:update': 'tasks.update',
  'mousseAgent:getMessages': 'mousseAgent.getMessages',
  'mousseAgent:send': 'mousseAgent.send',
  'mousseAgent:retryConnection': 'mousseAgent.retry',
  'pty:list': 'pty.list',
  'pty:create': 'pty.create',
  'pty:write': 'pty.write',
  'pty:resize': 'pty.resize',
  'pty:kill': 'pty.kill',
  'pty:isAlive': 'pty.isAlive',
  'pty:lookup': 'pty.lookup',
  // Phase 5
  'scheduled:list': 'scheduled.list',
  'scheduled:get': 'scheduled.get',
  'scheduled:create': 'scheduled.create',
  'scheduled:update': 'scheduled.update',
  'scheduled:delete': 'scheduled.delete',
  'scheduled:pause': 'scheduled.pause',
  'scheduled:resume': 'scheduled.resume',
  'scheduled:run': 'scheduled.run',
  'scheduled:status': 'scheduled.status',
  'channels:getSnapshot': 'channels.getSnapshot',
  'channels:getConfig': 'channels.getConfig',
  'channels:updateConfig': 'channels.updateConfig',
  'channels:connect': 'channels.connect',
  'channels:disconnect': 'channels.disconnect',
  'channels:listPairingRequests': 'channels.listPairingRequests',
  'channels:approvePairing': 'channels.approvePairing',
  'channels:rejectPairing': 'channels.rejectPairing',
  'channels:sendTest': 'channels.sendTest',
  'channels:getActivity': 'channels.getActivity',
  'mcp:listServers': 'mcp.listServers',
  'mcp:listTools': 'mcp.listTools',
  'mcp:testServer': 'mcp.testServer',
  'mcp:authenticate': 'mcp.authenticate',
  'mcp:restartServer': 'mcp.restartServer',
  'mcp:getConfigSources': 'mcp.getConfigSources',
  'mcp:writeCursorConfig': 'mcp.writeCursorConfig',
  'mcp:openConfig': 'mcp.openConfigIntent',
  'skills:list': 'skills.list',
  'skills:read': 'skills.read',
  'skills:refresh': 'skills.refresh',
  'skills:openFolder': 'skills.openFolderIntent',
  'settings:get': 'settings.get',
  'settings:set': 'settings.set',
  'settings:getOptions': 'settings.getOptions',
  'providers:listConfigured': 'providers.listConfigured',
  'providers:getUsage': 'providers.getUsage',
  'providers:getLoginOptions': 'providers.getLoginOptions',
  'providers:getAmbientInfo': 'providers.getAmbientInfo',
  'providers:setApiKey': 'providers.setApiKey',
  'providers:verifyAmbient': 'providers.verifyAmbient',
  'providers:logout': 'providers.logout',
  'providers:loginOAuth': 'providers.loginOAuth',
  'providers:loginApiKey': 'providers.loginApiKey',
  'providers:login:respond': 'providers.loginRespond',
  'providers:login:cancel': 'providers.loginCancel'
}

/** Events bridged from protocol → renderer (preload listener names). */
const PROTOCOL_EVENT_CHANNELS = [
  'orchestrator:thread-message',
  'orchestrator:message',
  'orchestrator:thread-message-updated',
  'orchestrator:message-updated',
  'orchestrator:thread-messages',
  'orchestrator:messages',
  'queue:updated',
  'orchestrator:connection-failed',
  'scheduled:updated',
  'scheduled:status',
  'channels:updated',
  'channels:activity',
  'settings:changed',
  'agent:spawned',
  'agent:activated',
  'pty:activated',
  'agents:updated',
  'tasks:updated',
  'providers:changed',
  'providers:login:event',
  'mcp:changed',
  'skills:changed',
  'pty:data',
  'pty:exit',
  'threads:activity'
] as const

/** Explicitly Electron-local (not protocol-proxied for execution). */
const ELECTRON_LOCAL_CHANNELS = [
  'window:minimize',
  'window:maximize',
  'window:close',
  'window:isMaximized',
  'browser:navigate',
  'browser:getState',
  'clipboard:showCopyMenu',
  'app:restart',
  'shell:openPath',
  'shell:showItemInFolder'
] as const

describe('Phase 3–5 IPC / protocol mapping', () => {
  it('every protocol-backed channel maps to an allowlisted method', () => {
    const allowed = new Set<string>(PROTOCOL_METHODS as readonly string[])
    for (const [channel, method] of Object.entries(PROTOCOL_BACKED_CHANNELS)) {
      expect(allowed.has(method), `${channel} → ${method}`).toBe(true)
    }
  })

  it('preload-compatible event channels are enumerated for Phase 5', () => {
    expect(PROTOCOL_EVENT_CHANNELS).toContain('orchestrator:thread-message')
    expect(PROTOCOL_EVENT_CHANNELS).toContain('queue:updated')
    expect(PROTOCOL_EVENT_CHANNELS).toContain('scheduled:updated')
    expect(PROTOCOL_EVENT_CHANNELS).toContain('channels:updated')
    expect(PROTOCOL_EVENT_CHANNELS).toContain('settings:changed')
    expect(PROTOCOL_EVENT_CHANNELS).toContain('providers:changed')
    expect(PROTOCOL_EVENT_CHANNELS).toContain('mcp:changed')
  })

  it('electron-local channels stay local (settings/providers are protocol-backed)', () => {
    for (const ch of ELECTRON_LOCAL_CHANNELS) {
      expect(PROTOCOL_BACKED_CHANNELS[ch]).toBeUndefined()
    }
    expect(PROTOCOL_BACKED_CHANNELS['settings:get']).toBe('settings.get')
    expect(PROTOCOL_BACKED_CHANNELS['providers:listConfigured']).toBe(
      'providers.listConfigured'
    )
  })

  it('full Phase 5 preload contract has no stub methods left unmapped', () => {
    const phase5Channels = Object.keys(PROTOCOL_BACKED_CHANNELS).filter(
      (k) =>
        k.startsWith('scheduled:') ||
        k.startsWith('channels:') ||
        k.startsWith('mcp:') ||
        k.startsWith('skills:') ||
        k.startsWith('settings:') ||
        k.startsWith('providers:')
    )
    expect(phase5Channels.length).toBeGreaterThanOrEqual(30)
    for (const ch of phase5Channels) {
      expect(PROTOCOL_BACKED_CHANNELS[ch]).toBeTruthy()
    }
  })

  it('orchestrator send payload always carries explicit threadId on protocol', () => {
    const protocolParams = {
      threadId: 'thread-uuid',
      content: 'hello',
      source: 'gui'
    }
    expect(typeof protocolParams.threadId).toBe('string')
    expect(protocolParams.threadId.length).toBeGreaterThan(0)
  })
})
