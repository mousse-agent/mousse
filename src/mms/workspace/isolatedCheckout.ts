import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { GIT_NULL_DEVICE, NO_HOOKS_PATH } from '../git/gitNullDevice'
import { gitRunError, runGitProcess, type GitProcessObserver } from '../git/runGitProcess'
import { worktreeGit } from '../worktree/worktreeCheckout'

// Only built-in checkout settings can cross into the private config.
const CHECKOUT_KEYS = '^(checkout\\.(workers|thresholdforparallelism)|' +
  'core\\.(autocrlf|eol|safecrlf|symlinks|ignorecase|precomposeunicode|protecthfs|protectntfs|checkroundtripencoding|attributesfile|sparsecheckout|sparsecheckoutcone)|' +
  'index\\.sparse|extensions\\.objectformat)$'

async function copyIfPresent(from: string, to: string): Promise<void> {
  try { await copyFile(from, to) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

/**
 * Materialize an untrusted commit without letting the file-writing Git read any live program
 * configuration. Git uses the linked checkout's index and the project's object store, but discovers
 * its config through an empty, private Git directory. The registered checkout keeps its own HEAD.
 */
export async function runIsolatedCheckout(
  cwd: string, args: string[], input: string | undefined, environment: NodeJS.ProcessEnv, options?: { observer?: GitProcessObserver; timeout?: number }
): Promise<void> {
  const paths = ['objects', 'index', 'info/attributes', 'info/sparse-checkout']
  const [head, locations, config] = await Promise.all([
    worktreeGit(cwd, ['rev-parse', 'HEAD']),
    worktreeGit(cwd, ['rev-parse', '--path-format=absolute', ...paths.flatMap((path) => ['--git-path', path])]),
    worktreeGit(cwd, ['config', '-z', '--get-regexp', CHECKOUT_KEYS]).catch((error: { status?: number }) => {
      if (error.status !== 1) throw error
      return ''
    })
  ])
  const [objects, index, attributes, sparse] = String(locations).trimEnd().split(/\r?\n/)
  const directory = await mkdtemp(join(tmpdir(), 'mousse-checkout-'))
  try {
    await Promise.all([
      mkdir(join(directory, 'refs')),
      mkdir(join(directory, 'objects')),
      mkdir(join(directory, 'info')),
      writeFile(join(directory, 'HEAD'), String(head))
    ])
    await Promise.all([
      copyIfPresent(attributes!, join(directory, 'info', 'attributes')),
      copyIfPresent(sparse!, join(directory, 'info', 'sparse-checkout'))
    ])
    const settings = String(config).split('\0').filter(Boolean).map((entry) => entry.replace('\n', '='))
    const objectFormats = settings.filter((entry) => entry.startsWith('extensions.objectformat='))
    if (objectFormats.at(-1) === 'extensions.objectformat=sha256') {
      await writeFile(join(directory, 'config'), '[core]\n\trepositoryFormatVersion = 1\n[extensions]\n\tobjectFormat = sha256\n')
    }
    // Strip inherited repository and config overrides, including dynamically numbered config keys.
    const env = Object.fromEntries(Object.entries(environment).filter(([key]) => !/^GIT_(?:CONFIG|DIR|COMMON_DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|EXTERNAL_DIFF)/i.test(key)))
    const argv = [
      ...settings.filter((setting) => !objectFormats.includes(setting)).flatMap((setting) => ['-c', setting]),
      '-c', 'core.hooksPath=' + NO_HOOKS_PATH, '-c', 'core.fsmonitor=false', '-c', 'core.longpaths=true',
      '-c', 'submodule.recurse=false', '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', ...args
    ]
    const ran = await runGitProcess(argv, {
      cwd, input, ...options, preserveIndexLock: true,
      env: {
        ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: GIT_NULL_DEVICE,
        GIT_DIR: directory, GIT_WORK_TREE: cwd, GIT_OBJECT_DIRECTORY: objects, GIT_INDEX_FILE: index
      }
    })
    if (ran.error || ran.status !== 0) throw gitRunError(argv, ran)
    if (args[0] === 'sparse-checkout' && args[1] === 'set') {
      await mkdir(dirname(sparse!), { recursive: true })
      await copyFile(join(directory, 'info', 'sparse-checkout'), sparse!)
      await worktreeGit(cwd, ['config', '--worktree', 'core.sparseCheckout', 'true'])
      await worktreeGit(cwd, ['config', '--worktree', 'core.sparseCheckoutCone', String(args.includes('--cone'))])
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
