import type { BlobId, EventId, NodeId, Signed, SpaceId, StoredRecord, StreamDescriptor, StreamHead, StreamId, UserId } from '../../../shared/net'

/** Hard qualification bounds; rejected before an archive becomes visible. */
export const ARCHIVE_LIMITS = Object.freeze({ streams: 128, records: 1_000_000, bytes: 512 * 1024 * 1024, blobs: 4096, blobBytes: 512 * 1024 * 1024, rosters: 512, rosterBytes: 16 * 1024 * 1024, manifestBytes:64*1024, manifestDocumentBytes:192*1024 })
export type ArchiveState = 'frozen' | 'exporting' | 'exported' | 'failedFrozen' | 'retiring' | 'retired' | 'importing' | 'importedFrozen' | 'activating' | 'activeNew'
export interface ArchiveStream { descriptor: StreamDescriptor; head: StreamHead; retained: number }
export interface ArchiveBlobRef { stream: StreamId; event: EventId; blob: BlobId; bytes: number; sealed: boolean }
export interface ArchiveManifest {
  v: 1; kind: 'space.archive'; space: SpaceId; owner: { user: UserId; rootKey: string };
  exporter: NodeId; exportedAt: number; frozen: StreamHead;
  descriptors: Signed[]; streams: ArchiveStream[];
  counts: { records: number; rosters: number; refs: number; blobs: number };
  dataHash: string; blobs: Array<{ id: BlobId; bytes: number; sealed: boolean }>;
}
export interface SpaceArchiveSource {
  space: SpaceId; owner: ArchiveManifest['owner']; exporter: NodeId; frozen: StreamHead;
  streams(): Iterable<ArchiveStream>;
  records(stream: StreamId): Iterable<StoredRecord>;
  rosters(): Iterable<Signed>;
  refs(): Iterable<ArchiveBlobRef>;
  readBlob(blob: BlobId, offset: number, length: number): Uint8Array;
  /** Export authorization is separate from event signatures. */
  sign(manifest: ArchiveManifest): Signed;
  close(): void;
}
export interface VerifiedSpaceArchive {
  readonly manifest: ArchiveManifest; readonly digest: string; readonly authorization: Signed;
  streams(): Iterable<ArchiveStream>; records(stream: StreamId): Iterable<StoredRecord>;
  rosters(): Iterable<Signed>; refs(): Iterable<ArchiveBlobRef>;
  readBlob(blob: BlobId, offset: number, length: number): Uint8Array;
  close(): void;
}
