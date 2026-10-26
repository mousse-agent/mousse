/**
 * `out/cli/chatgpt-token.js`: the token helper as a script of its own, so a Node-hosted daemon's
 * Codex runs it without loading the CLI bundle (whose packages load before any command runs).
 * Arguments: `<endpoint> <leaseId>`.
 */
import { runChatgptToken } from './chatgptToken'

void runChatgptToken(['engine', 'chatgpt-token', ...process.argv.slice(2)]).then(
  (code) => {
    process.exitCode = code
  },
  () => {
    process.exitCode = 1
  }
)
