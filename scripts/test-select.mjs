#!/usr/bin/env node
// Run the tests related to a change: the import graph Vitest already builds, plus the
// explicit runtime edges in tests/test-dependencies.json for tests that spawn built
// output or read data files, with a full run for anything that affects every test.
//
//   node scripts/test-select.mjs --changed            working tree vs HEAD (staged, unstaged, untracked)
//   node scripts/test-select.mjs --branch             merge base with the remote default branch, plus the working tree
//   node scripts/test-select.mjs --related a.ts b.ts  these source files
//   add --list to print the selection and its reasons without running anything
//
// This selection is the usual check before a PR; `npm test` is for very large multi-module changes.
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import picomatch from 'picomatch'

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** A change to any of these touches every test, so the whole suite runs. */
export const FULL_RUN_TRIGGERS = [
  'tests/setup/**',
  'tests/support/**',
  'tests/fixtures/**',
  'tests/test-dependencies.json',
  'tests/test-lanes.json',
  'vitest.config.*',
  'vite.config.*',
  'electron.vite.config.*',
  'package.json',
  'package-lock.json',
  'tsconfig*.json',
  'scripts/test-select.mjs'
]

/** Changed paths that need no test at all. */
const INERT = ['docs/**', '**/*.md', '.github/**', 'LICENSE*', '.gitignore', '.gitattributes', '.editorconfig', '.prettier*', 'eslint.config.*']

const toPosix = (path) => path.split(sep).join('/')
const match = (patterns) => picomatch(patterns, { dot: true })

/**
 * Vite and Vitest key modules by absolute path with forward slashes on every platform, so a native
 * Windows path (`E:\repo\src\a.ts`) never matches the module graph. The root is the same one Vitest
 * runs with, so the drive-letter case agrees by construction.
 */
export const moduleId = (path, root = projectRoot, { resolve: join = resolve, sep: separator = sep } = {}) =>
  join(root, path).split(separator).join('/')

export function loadManifest(root = projectRoot) {
  const path = resolve(root, 'tests/test-dependencies.json')
  const manifest = JSON.parse(readFileSync(path, 'utf8'))
  if (!Array.isArray(manifest.rules)) throw new Error('tests/test-dependencies.json must contain a "rules" array')
  for (const rule of manifest.rules) {
    if (!Array.isArray(rule.when) || !rule.when.length) throw new Error(`Rule "${rule.name}" needs a non-empty "when" list`)
    if (!rule.run?.length && !rule.projects?.length) throw new Error(`Rule "${rule.name}" needs "run" globs or "projects"`)
  }
  return manifest
}

/**
 * Decide what a set of changed repo-relative paths requires, before the import graph is consulted.
 * Pure: the same inputs always give the same plan, which is what the unit test checks.
 */
export function classifyChanges(changed, manifest) {
  const paths = [...new Set(changed.map(toPosix))].sort()
  const full = match(FULL_RUN_TRIGGERS)
  const inert = match(INERT)
  const trigger = paths.find((path) => full(path))
  if (trigger) return { mode: 'full', reason: `${trigger} affects every test`, paths }
  const matched = []
  const graph = []
  const inertPaths = []
  for (const path of paths) {
    const rules = manifest.rules.filter((rule) => match(rule.when)(path))
    for (const rule of rules) if (!matched.includes(rule)) matched.push(rule)
    if (inert(path)) inertPaths.push(path)
    else graph.push(path)
  }
  if (!graph.length && !matched.length) return { mode: 'none', reason: 'only documentation or inert files changed', paths }
  return {
    mode: 'select',
    paths,
    graph,
    inert: inertPaths,
    runGlobs: [...new Set(matched.flatMap((rule) => rule.run ?? []))],
    projects: [...new Set(matched.flatMap((rule) => rule.projects ?? []))],
    rules: matched.map((rule) => rule.name)
  }
}

function git(args) {
  return execFileSync('git', args, { cwd: projectRoot, encoding: 'utf8' })
}

function changedPaths({ base }) {
  const out = new Set()
  const add = (listing) => {
    for (const entry of listing.split('\0')) if (entry) out.add(toPosix(entry))
  }
  if (base) add(git(['diff', '--name-only', '--no-renames', '-z', `${base}...HEAD`]))
  add(git(['diff', '--name-only', '--no-renames', '-z', 'HEAD']))
  add(git(['ls-files', '--others', '--exclude-standard', '-z']))
  return [...out].sort()
}

function remoteDefaultBase() {
  let ref
  try {
    ref = git(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']).trim()
  } catch {
    throw new Error('Cannot resolve the remote default branch; run `git remote set-head origin --auto` first')
  }
  return git(['merge-base', 'HEAD', ref]).trim()
}

function parseArgs(argv) {
  const options = { mode: 'changed', list: false, related: [] }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--changed') options.mode = 'changed'
    else if (arg === '--branch') options.mode = 'branch'
    else if (arg === '--related') options.mode = 'related'
    else if (arg === '--list') options.list = true
    else if (arg.startsWith('--')) throw new Error(`Unknown option ${arg}`)
    else options.related.push(arg)
  }
  if (options.mode === 'related' && !options.related.length) throw new Error('--related needs at least one file')
  return options
}

function runFull(extra = []) {
  const result = spawnSync(process.execPath, [resolve(projectRoot, 'node_modules/vitest/vitest.mjs'), 'run', ...extra], {
    cwd: projectRoot,
    stdio: 'inherit'
  })
  return result.status ?? 1
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const manifest = loadManifest()
  let changed
  if (options.mode === 'related') {
    changed = options.related.map((path) => toPosix(relative(projectRoot, resolve(projectRoot, path))))
  } else {
    changed = changedPaths({ base: options.mode === 'branch' ? remoteDefaultBase() : null })
  }
  const plan = classifyChanges(changed, manifest)
  console.log(`[test-select] ${plan.paths.length} changed path(s)`)
  if (plan.mode === 'full') {
    console.log(`[test-select] full run: ${plan.reason}`)
    if (options.list) return 0
    return runFull()
  }
  if (plan.mode === 'none') {
    console.log(`[test-select] nothing to run: ${plan.reason}`)
    return 0
  }

  const { createVitest } = await import('vitest/node')
  const related = plan.graph.map((path) => moduleId(path))
  const vitest = await createVitest('test', { run: true, watch: false, related, root: projectRoot })
  try {
    const all = await vitest.globTestSpecifications()
    const byGraph = related.length ? await vitest.getRelevantTestSpecifications() : []
    const reasons = new Map()
    const note = (spec, why) => {
      const key = `${spec.project.name}:${spec.moduleId}`
      if (!reasons.has(key)) reasons.set(key, { spec, why: [] })
      reasons.get(key).why.push(why)
    }
    for (const spec of byGraph) note(spec, 'imports a changed file')
    const runGlob = plan.runGlobs.length ? match(plan.runGlobs) : null
    for (const spec of all) {
      const rel = toPosix(relative(projectRoot, spec.moduleId))
      if (runGlob?.(rel)) note(spec, `runtime edge: ${plan.rules.join(', ')}`)
      if (plan.projects.includes(spec.project.name)) note(spec, `project ${spec.project.name} selected by: ${plan.rules.join(', ')}`)
    }

    // A changed source file that no test imports and no rule names is not proven harmless; run everything.
    const uncovered = []
    for (const path of plan.graph) {
      if (!path.startsWith('src/') && !path.startsWith('scripts/')) continue
      const absolute = moduleId(path)
      const inGraph = vitest.projects.some((project) => project.vite.environments.ssr.moduleGraph.getModuleById(absolute))
      const byRule = manifest.rules.some((rule) => match(rule.when)(path))
      if (!inGraph && !byRule) uncovered.push(path)
    }
    if (uncovered.length) {
      console.log(`[test-select] full run: no test imports and no rule covers ${uncovered.join(', ')}`)
      await vitest.close()
      return options.list ? 0 : runFull()
    }

    const selected = [...reasons.values()]
    console.log(`[test-select] ${selected.length} of ${all.length} test files selected`)
    if (options.list) {
      for (const { spec, why } of selected.sort((a, b) => a.spec.moduleId.localeCompare(b.spec.moduleId))) {
        console.log(`  ${spec.project.name.padEnd(8)} ${toPosix(relative(projectRoot, spec.moduleId))}  (${[...new Set(why)].join('; ')})`)
      }
      await vitest.close()
      return 0
    }
    if (!selected.length) {
      console.log('[test-select] no test is related to these changes')
      await vitest.close()
      return 0
    }
    const result = await vitest.runTestSpecifications(selected.map((entry) => entry.spec), false)
    const failed = result.testModules.some((module) => !module.ok()) || result.unhandledErrors.length > 0
    await vitest.close()
    return failed ? 1 : 0
  } catch (error) {
    await vitest.close().catch(() => undefined)
    throw error
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => {
      process.exitCode = code
    },
    (error) => {
      console.error(`[test-select] ${error?.message ?? error}`)
      process.exitCode = 1
    }
  )
}
