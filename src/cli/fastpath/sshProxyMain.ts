/**
 * `out/cli/ssh-proxy.js`: the editor proxy as a script of its own. The launcher runs it with
 * `ELECTRON_RUN_AS_NODE=1` for `mousse-cli net ssh-proxy`, so an editor's reconnect does not wait for the
 * app to start (about 0.7 s on Windows, against about 0.06 s). It imports Node's built-ins only.
 * Arguments: `net ssh-proxy <node-id> --profile <profile>`.
 */
import { runSshProxy } from './sshProxy'

void runSshProxy(process.argv.slice(2)).then(
  (code) => process.exit(code),
  () => process.exit(1)
)
