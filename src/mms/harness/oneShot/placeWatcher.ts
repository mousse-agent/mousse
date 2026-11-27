/**
 * The per-request watcher on POSIX (`places.ts`). It runs as `process.execPath -e PLACE_WATCHER <pgid>` with
 * `ELECTRON_RUN_AS_NODE=1`, in a process group of its own, and holds a pipe from the daemon on its stdin. When that
 * pipe closes (the request stopped, or the daemon died) it SIGKILLs the request's whole process group, waits until
 * `kill(-pgid, 0)` says the group is gone (ESRCH), writes `empty` and exits. It is not resident: one per request,
 * gone with it.
 *
 * Kept as source text, not a file, so the bundled daemon can start it without shipping a loose script.
 */
export const PLACE_WATCHER = String.raw`
const pgid = Number(process.argv[1])
if (!Number.isInteger(pgid) || pgid <= 1) process.exit(2)
const gone = () => {
  try { process.kill(-pgid, 0); return false } catch (error) { return error.code === 'ESRCH' }
}
const kill = () => { try { process.kill(-pgid, 'SIGKILL') } catch {} }
let ending = false
const end = () => {
  if (ending) return
  ending = true
  const started = Date.now()
  const check = () => {
    if (gone()) {
      setTimeout(() => process.exit(0), 1000).unref()
      process.stdout.write('empty\n', () => process.exit(0))
      return
    }
    // A process stuck in the kernel can take a while; give up after five minutes rather than stay resident.
    if (Date.now() - started > 300000) process.exit(1)
    kill()
    setTimeout(check, 20)
  }
  kill()
  check()
}
process.stdout.on('error', () => {})
process.stdin.on('end', end)
process.stdin.on('close', end)
process.stdin.on('error', end)
for (const signal of ['SIGHUP', 'SIGINT', 'SIGTERM']) process.on(signal, end)
process.stdin.resume()
`

/**
 * The per-request launcher on POSIX (`places.ts`), run as `/bin/sh -c PLACE_LAUNCHER <command> <args…>` in a new
 * process group with the agent's environment and stdio, and a control pipe on fd 3. It waits for `go` on that pipe,
 * which the daemon sends only once the group is durable in the place's record, then closes the pipe and `exec`s the
 * agent: same pid, same group, nothing in between. If the pipe closes first (the daemon died), it exits and nothing ran.
 */
export const PLACE_LAUNCHER = 'IFS= read -r go <&3 && [ "$go" = go ] || exit 125; exec 3<&-; exec "$0" "$@"'
