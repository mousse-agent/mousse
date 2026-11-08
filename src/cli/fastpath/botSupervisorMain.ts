/**
 * `out/cli/bot-supervisor.js`: one bot dispatch's active-time supervisor as a script of its own
 * (Bot Phase 1 §5.9). The daemon starts it detached with its own runtime as plain Node
 * (`ELECTRON_RUN_AS_NODE=1`), so it keeps its deadline while the daemon's loop is busy or gone. It
 * imports Node's built-ins only. Arguments: `--dispatch <id> --pgid <n> --deadline <epochMs> --journal <path>`.
 */
import { BOT_SUPERVISOR_USAGE, parseBotSupervisorArgs, runBotSupervisor } from '../../mms/bots/supervisor/botSupervisor'

const args = parseBotSupervisorArgs(process.argv.slice(2))
if (!args) {
  process.stderr.write(`${BOT_SUPERVISOR_USAGE}\n`)
  process.exit(2)
}
// The daemon stops it when the dispatch settles; a hang-up of the session it left is ignored.
process.on('SIGTERM', () => process.exit(0))
process.on('SIGHUP', () => undefined)
void runBotSupervisor(args).then(
  (code) => process.exit(code),
  () => process.exit(1)
)
