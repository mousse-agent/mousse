import { join } from 'node:path'
import { requiredId } from '../util'

export function profileBrowserRoot(browserRoot: string, profileId: string): string {
  return join(browserRoot, 'user-data', requiredId(profileId))
}

export function ephemeralUserDataDir(browserRoot: string, profileId: string, sessionId: string): string {
  return join(profileBrowserRoot(browserRoot, profileId), 'ephemeral', requiredId(sessionId))
}

export function workspaceUserDataDir(browserRoot: string, profileId: string, workspaceId: string): string {
  return join(profileBrowserRoot(browserRoot, profileId), 'workspaces', requiredId(workspaceId))
}

export function workspaceLockPath(browserRoot: string, profileId: string, workspaceId: string): string {
  return join(browserRoot, 'locks', 'workspace', requiredId(profileId), `${requiredId(workspaceId)}.lock`)
}

export function journalPath(browserRoot: string, profileId: string, sessionId: string): string {
  return join(browserRoot, 'journals', requiredId(profileId), `${requiredId(sessionId)}.jsonl`)
}

export function processRecordPath(userDataDir: string): string {
  return join(userDataDir, 'mousse-owned-process.json')
}

export function artifactDir(artifactRoot: string, profileId: string, sessionId: string): string {
  return join(artifactRoot, requiredId(profileId), requiredId(sessionId))
}
