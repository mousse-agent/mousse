import { app } from 'electron'
import { runCliMain } from '../cli/runCliMain'

// Dedicated packaged CLI entry. Unlike the desktop binary's --cli compatibility
// mode, this executable has no renderer and always starts as mousse-cli.
const argv = process.argv.slice(1)

runCliMain(argv)
  .then(() => app.exit(0))
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    app.exit(1)
  })
