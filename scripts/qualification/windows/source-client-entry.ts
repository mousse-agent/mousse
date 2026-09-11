/**
 * Qualification-only entry so the packaged-daemon fixture client is the
 * production LocalMmsClient, bundled from this worktree source. Not imported
 * by production CLI/daemon composition.
 */
export { LocalMmsClient, MmsProtocolError } from '../../../src/mms/protocol/client'
