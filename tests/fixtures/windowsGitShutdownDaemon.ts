import childProcess, { type ChildProcess } from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { WorktreeManager } from '../../src/mms/worktree/WorktreeManager'
import { GitService } from '../../src/mms/git/GitService'
import { userAction } from '../../src/mms/git/gitPolicy'
import { runDaemonForeground } from '../../src/cli/commands/service'
import { gitFile, gitEnvFor } from '../../src/mms/git/gitExecutable'
import { inBackgroundGitLane, spawnGit } from '../../src/mms/git/gitSpawn'

const [, , , home, , , cwd, script] = process.argv
const nativeSpawn = childProcess.spawn
childProcess.spawn = ((file: string, ...rest: unknown[]) => {
  const child = (nativeSpawn as (...args: unknown[]) => ChildProcess)(file, ...rest)
  if (file === process.execPath && (rest[1] as { serialization?: string })?.serialization === 'advanced') {
    process.stdout.write('Git helper PID ' + child.pid + '\n')
    const send = child.send.bind(child)
    child.send = ((message: { args?: string[] }, ...rest: unknown[]) => {
      if (message.args?.includes('refs/mousse/agents/shutdown-agent/base')) {
        process.stdout.write('Git launched the agent base-ref write\n')
      }
      return (send as (...args: unknown[]) => boolean)(message, ...rest)
    }) as typeof child.send
  }
  return child
}) as typeof nativeSpawn
syncBuiltinESMExports()

await runDaemonForeground({
  homeDir: home!,
  skipSignals: true,
  onLog(message) {
    process.stderr.write(message + '\n')
    if (!message.startsWith('Mousse MMS running')) return
    const mutate = async () => {
      await new WorktreeManager(cwd!, home!).createWorktree('shutdown-agent')
      await new GitService().commit(cwd!, userAction('button', 'Commit shutdown fixture'), 'pending commit')
    }
    void mutate().catch((error: unknown) => process.stderr.write(String(error) + '\n'))
    inBackgroundGitLane(() => {
      const child = spawnGit(gitFile(), ['-c', 'alias.job-tree=!node "' + script!.replace(/\\/g, '/') + '"', 'job-tree'], {
        cwd, env: gitEnvFor(process.env), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
      })
      child.stdout.resume()
      child.stderr.on('data', (bytes) => process.stderr.write(bytes))
      child.on('error', (error) => process.stderr.write(error.message + '\n'))
      child.once('spawn', () => process.stdout.write('Git root PID ' + child.pid + '\n'))
    })
  }
})
