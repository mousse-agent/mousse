import { sha256Hex } from '../../../shared/agents/hashes'
import { stableStringify } from '../json'

/** Ledger digest of tool arguments (`ToolInvocationRecord.argsDigest`): sha256 of their stable JSON. */
export function toolArgsDigest(args: unknown): string {
  return sha256Hex(stableStringify(args ?? {}))
}
