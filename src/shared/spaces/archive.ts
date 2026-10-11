import type { SpaceId, StreamHead } from '../net'
export const SPACE_ARCHIVE_METHODS = [
  'spaces.archive.freeze',
  'spaces.archive.export',
  'spaces.archive.retire',
  'spaces.archive.import',
  'spaces.archive.activate',
  'spaces.archive.status'
] as const
export type SpaceArchiveMethod = (typeof SPACE_ARCHIVE_METHODS)[number]
export interface SpaceArchiveParams {
  'spaces.archive.freeze': { space: SpaceId; reason: string }
  'spaces.archive.export': { space: SpaceId; path: string }
  'spaces.archive.retire': { space: SpaceId }
  'spaces.archive.import': { path: string; mode: 'restore' | 'move' }
  'spaces.archive.activate': { space: SpaceId }
  'spaces.archive.status': { space?: SpaceId; after?: SpaceId; limit?: number }
}
export interface SpaceArchiveStatus {
  space: SpaceId
  operation: string
  state: string
  mode: 'source' | 'restore' | 'move'
  frozen: StreamHead
  digest?: string
  epoch?: number
}
