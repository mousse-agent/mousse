import { exitWithError } from './output'
import { runCliMain } from './runCliMain'

runCliMain(process.argv.slice(2)).catch((err) => {
  const message = err instanceof Error ? err.message : String(err)
  exitWithError(message, 'text')
})
