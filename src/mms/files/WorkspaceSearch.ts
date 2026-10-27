import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
import { rankFuzzyPaths } from '../../shared/fuzzyPath'
import type { FileSearchResult } from '../../shared/types'
import { resolveWithinRoot } from './pathGuard'
import type { WorkspaceIndexSnapshot } from './WorkspaceIndex'

export interface SearchWorkspacePathsOptions {
  limit: number
  kinds?: Array<'file' | 'directory'>
  /** Wall-clock budget for ranking; a stopped search reports `complete: false`. */
  budgetMs?: number
}

/**
 * Ranks the snapshot's files and folders with one scorer. Ties list files
 * before folders. A query ending in `/` asks for folders: they come first, and
 * the slash is dropped when matching folder names (which are stored without one).
 */
export async function searchWorkspacePaths(
  snapshot: WorkspaceIndexSnapshot,
  query: string,
  options: SearchWorkspacePathsOptions
): Promise<{ results: FileSearchResult[]; complete: boolean }> {
  const { limit, budgetMs = 150 } = options
  const kinds = options.kinds ?? ['file', 'directory']
  const deadline = Date.now() + budgetMs
  const normalized = query.trim().replace(/\\/g, '/')
  const foldersFirst = normalized.endsWith('/')
  const rankOptions = { limit, deadline, yield: () => yieldToEventLoop() }

  const candidates: FileSearchResult[] = []
  let complete = true

  if (kinds.includes('file')) {
    const ranked = await rankFuzzyPaths(normalized, { paths: snapshot.files, lower: snapshot.lowerFiles }, rankOptions)
    complete &&= ranked.complete
    for (const hit of ranked.results) {
      candidates.push({ path: snapshot.files[hit.index], kind: 'file', score: hit.score, positions: hit.positions })
    }
  }
  if (kinds.includes('directory')) {
    const folderQuery = foldersFirst && normalized.length > 1 ? normalized.slice(0, -1) : normalized
    const ranked = await rankFuzzyPaths(folderQuery, { paths: snapshot.folders, lower: snapshot.lowerFolders }, rankOptions)
    complete &&= ranked.complete
    for (const hit of ranked.results) {
      candidates.push({ path: snapshot.folders[hit.index], kind: 'directory', score: hit.score, positions: hit.positions })
    }
  }

  const kindOrder = (kind: FileSearchResult['kind']): number => (kind === 'directory' ? (foldersFirst ? 0 : 1) : foldersFirst ? 1 : 0)
  candidates.sort((a, b) => {
    if (foldersFirst && a.kind !== b.kind) return kindOrder(a.kind) - kindOrder(b.kind)
    return b.score - a.score || kindOrder(a.kind) - kindOrder(b.kind)
  })

  const results: FileSearchResult[] = []
  for (const candidate of candidates) {
    if (results.length >= limit) break
    // Every returned path is contained, whatever the index holds.
    try {
      resolveWithinRoot(snapshot.root, candidate.path)
    } catch {
      continue
    }
    results.push(candidate)
  }
  return { results, complete }
}
