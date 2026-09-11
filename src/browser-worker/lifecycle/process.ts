import {
  injectOwnedStopFailureForTests,
  isOwnedPid,
  isOwnedPidAlive,
  rootOnlyTree,
  stopOwnedProcessTree,
  type OwnedProcessTree
} from './ownedTree'

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  if (pid === process.pid) return true
  return isOwnedPidAlive(pid)
}

export { injectOwnedStopFailureForTests, isOwnedPid, isOwnedPidAlive }

/** Kill only this PID's tree via the recorded PID. Never matches by process name. */
export async function stopOwnedPid(pid: number, timeoutMs = 5_000): Promise<void> {
  if (!isOwnedPid(pid) || pid === process.pid) return
  if (!isOwnedPidAlive(pid)) return
  await stopOwnedProcessTree(rootOnlyTree(pid, { parentHandleAlive: true }), timeoutMs)
}

export async function stopOwnedTree(tree: OwnedProcessTree, timeoutMs = 5_000): Promise<void> {
  await stopOwnedProcessTree(tree, timeoutMs)
}
