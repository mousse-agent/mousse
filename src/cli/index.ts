import { exitWithError } from './output'
import { runCliMain } from './runCliMain'
import { isElectronMainProcess, stripCliModeArgs } from './cliLaunch'
import { configureElectronContext, finishElectronCli } from './electronContext'

async function main(): Promise<void> {
  const argv = stripCliModeArgs(process.argv.slice(2))
  if (isElectronMainProcess()) {
    const { app } = await import('electron')
    configureElectronContext(app, argv)
    await app.whenReady()
    try {
      await runCliMain(argv)
      finishElectronCli(app)
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
      finishElectronCli(app, 1)
    }
    return
  }
  await runCliMain(argv)
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err)
  exitWithError(message, 'text')
})
