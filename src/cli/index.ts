import { exitWithError } from './output'
import { isElectronMainProcess, stripCliModeArgs } from './cliLaunch'
import { configureElectronContext, finishElectronCli } from './electronContext'
import { isChatgptTokenArgv } from './fastpath/chatgptToken'
import { isSshProxyArgv } from './fastpath/sshProxy'

async function main(): Promise<void> {
  const argv = stripCliModeArgs(process.argv.slice(2))
  // Codex runs the token command for every token it needs: it loads nothing else.
  if (isChatgptTokenArgv(argv)) {
    const { runChatgptToken } = await import('./fastpath/chatgptToken')
    const code = await runChatgptToken(argv)
    if (isElectronMainProcess()) (await import('electron')).app.exit(code)
    else process.exitCode = code
    return
  }
  // An editor's `ssh` runs the proxy on every reconnect: it loads nothing else.
  if (isSshProxyArgv(argv)) {
    const { runSshProxy } = await import('./fastpath/sshProxy')
    const code = await runSshProxy(argv)
    if (isElectronMainProcess()) (await import('electron')).app.exit(code)
    else process.exit(code)
    return
  }
  const { runCliMain } = await import('./runCliMain')
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
