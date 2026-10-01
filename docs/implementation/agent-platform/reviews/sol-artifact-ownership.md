# Sol review: profile artifact ownership

Reviewed core: `89df8bdfc287202f65563020d389dba20cd26bb4`

Qualified implementation freeze: `746d8766424de96fd6eec30996e6968da71d024e`

Disposition: accepted after hardening `FileArtifactStore` for the profile-owned browser adapter and preserving the existing workflow `ArtifactStoreAdapter` contract.

## Findings fixed

1. Artifact reads allocated and parsed metadata and blob files without a size bound. Metadata is now limited to 64 KiB and blobs to 100 MiB, with an optional lower caller limit. File size and regular-file identity are checked before allocation, the descriptor is checked after open, reads are exact, and descriptor identity/size is checked again afterward.
2. A caller could learn or read an artifact blob before proving run ownership. Supplying the third `get` options object now requires exact run equality before the blob is inspected or opened. `{}` and `{ runId: undefined }` authorize only an artifact with no run owner. The legacy two-argument workflow read remains compatible.
3. Metadata was trusted after an unbounded `JSON.parse`. Reads now reject malformed structure, invalid or inconsistent identity/profile/run fields, unsafe byte lengths, invalid SHA-256, invalid timestamps, and oversized display fields before blob allocation. Profile ownership is checked before blob access, and byte length plus digest remain verified after the bounded read.
4. The store retained only a path string. It now retains the canonical profile and artifact roots plus their device/inode identity and revalidates them on every operation. Artifact roots, record directories, metadata, and blobs must be direct regular directories/files whose canonical paths remain within the retained root. Stable symlink or junction substitution and ordinary directory replacement fail closed.
5. Writes accepted unbounded buffers and required a run even though main browser sessions need profile-owned artifacts before a workflow run exists. Writes now enforce the store bound before hashing or creating a record, validate bounded metadata fields, and accept an optional run while remaining structurally compatible with workflow callers that require one. Blob and metadata writes remain same-directory atomic replacements.

## Evidence

- `npx vitest run tests/platformArtifactStore.test.ts tests/platformArtifactOwnership.test.ts --maxWorkers=1 --minWorkers=1 --pool=forks --testTimeout=60000 --hookTimeout=30000` — 2 files, 8 tests passed.
- `npx vitest run tests/platformArtifactStore.test.ts tests/platformArtifactOwnership.test.ts tests/platformWorkflowRuntime.test.ts --maxWorkers=1 --minWorkers=1 --pool=forks --testTimeout=60000 --hookTimeout=30000` — existing workflow runtime passed 21 tests; artifact suites passed 7 tests before the final added write-bound fixture. The final artifact-only run above passed all 8.
- `npm run typecheck` — node and web TypeScript projects passed.
- `npm run build:cli` — CLI bundle passed.
- `git diff --check` — passed; Git emitted only the repository's Windows line-ending notice.

The tests use temporary local profile roots and filesystem records. They cover cross-profile rejection, exact run and undefined-run ownership, ownership checks before a deliberately missing blob, malformed and oversized metadata, inconsistent declared size, per-read bounds before a missing blob, the write bound before hashing or directory creation, artifact-root junction substitution, same-path root replacement, record-directory junction substitution, profile-root junction construction, blob-file symlink substitution, and ordinary digest tampering. No live account, model, browser, channel, credential, or external server is used.

## Remaining guarantees

This store performs repeated path, canonical-containment, identity, descriptor, and size checks, but it does not provide portable immunity to a hostile process replacing filesystem entries between every check and open. Windows JavaScript file APIs do not expose a portable `openat`/directory-handle walk with no-follow semantics. The browser owner must continue to restrict artifact filesystem mutation to the trusted host and must apply its own profile/thread/run/session authorization before calling the shared store.

The store's default 100 MiB ceiling is a safety bound, not an execution budget. Browser and workflow owners must pass or enforce the smaller policy/session budget before publishing or returning an artifact. Existing two-argument workflow reads intentionally do not add a new run check; authoritative workflow collection still validates the returned reference's run, while new owner-sensitive callers must supply the third options object.
