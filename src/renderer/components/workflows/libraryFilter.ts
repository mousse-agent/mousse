import type { WorkflowLibraryItem } from './client'

export type WorkflowLibrarySort = 'name' | 'updated' | 'lastRun'
export type WorkflowLibraryStatus = 'all' | 'draft' | 'published' | 'unpublished-changes' | 'unsupported'

export interface WorkflowLibraryQuery {
  search: string
  tag: string
  status: WorkflowLibraryStatus
  sort: WorkflowLibrarySort
}

export const EMPTY_WORKFLOW_LIBRARY_QUERY: WorkflowLibraryQuery = {
  search: '',
  tag: '',
  status: 'all',
  sort: 'updated'
}

export function uniqueWorkflowTags(items: WorkflowLibraryItem[]): string[] {
  return [...new Set(items.flatMap((item) => item.tags ?? []))].sort((a, b) => a.localeCompare(b))
}

export function publicationState(item: WorkflowLibraryItem): 'draft' | 'published' | 'unpublished-changes' {
  if (!item.headRevisionId && !item.headSemanticHash) return 'draft'
  if (item.draftSemanticHash && item.headSemanticHash && item.draftSemanticHash !== item.headSemanticHash) {
    return 'unpublished-changes'
  }
  return 'published'
}

export function filterWorkflowLibrary(
  items: WorkflowLibraryItem[],
  query: WorkflowLibraryQuery
): WorkflowLibraryItem[] {
  const search = query.search.trim().toLowerCase()
  const filtered = items.filter((item) => {
    if (item.archived) return false
    const state = publicationState(item)
    if (query.status === 'unsupported') {
      if (!item.unsupportedNodes?.length) return false
    } else if (query.status !== 'all' && state !== query.status) {
      return false
    }
    if (query.tag && !(item.tags ?? []).includes(query.tag)) return false
    if (!search) return true
    const haystack = [item.name, item.description ?? '', item.slug, (item.tags ?? []).join(' ')]
      .join(' ')
      .toLowerCase()
    return haystack.includes(search)
  })

  const sorted = [...filtered]
  sorted.sort((a, b) => {
    if (query.sort === 'name') return a.name.localeCompare(b.name)
    if (query.sort === 'lastRun') {
      const aTime = a.lastRunAt ?? a.updatedAt ?? ''
      const bTime = b.lastRunAt ?? b.updatedAt ?? ''
      return bTime.localeCompare(aTime)
    }
    const aTime = a.updatedAt ?? a.draftSemanticHash ?? ''
    const bTime = b.updatedAt ?? b.draftSemanticHash ?? ''
    return bTime.localeCompare(aTime)
  })
  return sorted
}
