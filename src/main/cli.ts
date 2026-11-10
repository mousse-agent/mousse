import { app } from 'electron'
import { configureWindowlessElectron } from '../cli/electronContext'

// Dedicated packaged CLI entry. Unlike the desktop binary's --cli compatibility
// mode, this executable has no renderer and always starts as mousse-cli.
// No GPU or network service process for it: set before the app is ready and before
// the CLI's own modules load.
configureWindowlessElectron(app)

const argv = process.argv.slice(1)

import('../cli/runCliMain')
  .then(({ runCliMain }) => runCliMain(argv))
  .then(() => app.exit(Number(process.exitCode ?? 0)))
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    app.exit(1)
  })
