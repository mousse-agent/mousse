import type { AgentRuntimeKind } from '../../../shared/agents/types'
import type { AgentLibraryItem } from './client'

export type AgentLibrarySort = 'name' | 'updated' | 'lastRun'

export interface AgentLibraryQuery {
  search: string
  tag: string
  runtime: AgentRuntimeKind | 'all'
  model: string
  favoritesOnly: boolean
  sort: AgentLibrarySort
}

export const EMPTY_LIBRARY_QUERY: AgentLibraryQuery = {
  search: '',
  tag: '',
  runtime: 'all',
  model: '',
  favoritesOnly: false,
  sort: 'updated'
}

export function uniqueLibraryTags(items: AgentLibraryItem[]): string[] {
  return [...new Set(items.flatMap((item) => item.tags))].sort((a, b) => a.localeCompare(b))
}

export function uniqueLibraryModels(items: AgentLibraryItem[]): Array<{ id: string; label: string }> {
  const map = new Map<string, string>()
  for (const item of items) {
    const id = item.model ? `${item.model.providerId}/${item.model.modelId}` : item.modelLabel
    if (!id) continue
    map.set(id, item.modelLabel ?? id)
  }
  return [...map.entries()].map(([id, label]) => ({ id, label })).sort((a, b) => a.label.localeCompare(b.label))
}

export function publicationState(item: AgentLibraryItem): 'draft' | 'published' | 'unpublished-changes' {
  if (!item.publishedRevision) return 'draft'
  if (item.publishedRevision !== item.semanticHash) return 'unpublished-changes'
  return 'published'
}

export function filterAgentLibrary(items: AgentLibraryItem[], query: AgentLibraryQuery): AgentLibraryItem[] {
  const search = query.search.trim().toLowerCase()
  const filtered = items.filter((item) => {
    if (item.archived) return false
    if (query.favoritesOnly && !item.favorite) return false
    if (query.runtime !== 'all' && item.runtimeKind !== query.runtime) return false
    if (query.tag && !item.tags.includes(query.tag)) return false
    if (query.model) {
      const id = item.model ? `${item.model.providerId}/${item.model.modelId}` : item.modelLabel ?? ''
      if (id !== query.model) return false
    }
    if (!search) return true
    const haystack = [item.name, item.purpose, item.slug, item.tags.join(' '), item.modelLabel ?? '']
      .join(' ')
      .toLowerCase()
    return haystack.includes(search)
  })

  const sorted = [...filtered]
  sorted.sort((a, b) => {
    if (query.sort === 'name') return a.name.localeCompare(b.name)
    if (query.sort === 'lastRun') {
      const aTime = a.lastRunAt ?? a.updatedAt
      const bTime = b.lastRunAt ?? b.updatedAt
      return bTime.localeCompare(aTime)
    }
    return b.updatedAt.localeCompare(a.updatedAt)
  })
  return sorted
}
