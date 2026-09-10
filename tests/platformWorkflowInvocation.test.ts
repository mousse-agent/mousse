import { randomUUID } from 'node:crypto'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { tokenizeWorkflowCommand } from '../src/shared/workflows/commandTokenizer'
import type { WorkflowManifest } from '../src/shared/workflows'
import { WorkflowRegistry } from '../src/mms/workflows/registry/WorkflowRegistry'
import { bindWorkflowArguments, WorkflowInvocationResolver } from '../src/mms/workflows/commands/WorkflowInvocationResolver'

const roots: string[] = []
function manifest(): WorkflowManifest {
  return {
    schemaVersion: 1, id: randomUUID(), name: 'Release notes', slug: 'release_notes',
    inputSchema: { type: 'object', properties: { title: { type: 'string' }, count: { type: 'integer' }, preview: { type: 'boolean' }, files: { type: 'array', items: { type: 'string' } }, metadata: { type: 'object', additionalProperties: true } }, required: ['title'], additionalProperties: false },
    outputSchema: { type: 'object' }, entryNodeId: 'start',
    nodes: [{ id: 'start', type: 'start', version: 1, config: {} }, { id: 'end', type: 'end', version: 1, config: {} }],
    edges: [{ from: 'start', port: 'next', to: 'end' }],
    extensions: { mousse: { command: { restArgument: 'title' } } }
  }
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'mousse-command-domain-'))
  roots.push(root)
  const registry = new WorkflowRegistry({ profileId: 'profile-a', profileRoot: root })
  const source = manifest()
  const saved = registry.saveDraft({ bundle: { manifest: source, assets: [] } })
  const published = registry.publish({ definitionId: saved.definitionId, expectedDraftSemanticHash: saved.semanticHash })
  return { registry, source, published }
}
afterEach(() => {
  for (const root of roots.splice(0)) {
    const path = relative(realpathSync(tmpdir()), realpathSync(root))
    if (isAbsolute(path) || !path.startsWith('mousse-command-domain-') || path.includes('..')) throw new Error('Unexpected command fixture path')
    rmSync(root, { recursive: true, force: true })
  }
})

describe('shared workflow command tokenizer and binding', () => {
  it('parses quoted flags, booleans, numeric and repeated array fields without shell expansion', () => {
    const text = `--title 'Ship $(whoami) \`literal\` $HOME *' --count -2 --preview --files README.md --files '["docs/notes.md"]' --metadata '{"tag":"v2"}'`
    expect(bindWorkflowArguments(tokenizeWorkflowCommand(text), manifest())).toEqual({ title: 'Ship $(whoami) `literal` $HOME *', count: -2, preview: true, files: ['README.md', 'docs/notes.md'], metadata: { tag: 'v2' } })
    expect(bindWorkflowArguments(tokenizeWorkflowCommand('--title="quoted title" --preview false'), manifest())).toEqual({ title: 'quoted title', preview: false })
  })
  it('keeps Windows paths, escaped quotes and empty values and uses only declared rest fields', () => {
    expect(tokenizeWorkflowCommand(String.raw`"C:\work\file.txt" 'say \'hello\'' ""`).map((entry) => entry.value)).toEqual([String.raw`C:\work\file.txt`, "say 'hello'", ''])
    expect(bindWorkflowArguments(tokenizeWorkflowCommand('--count 2 -- prepare release notes'), manifest())).toEqual({ count: 2, title: 'prepare release notes' })
    expect(() => bindWorkflowArguments(tokenizeWorkflowCommand('unclaimed text'), { ...manifest(), extensions: undefined })).toThrow(/named arguments/)
    expect(() => tokenizeWorkflowCommand('"unfinished')).toThrow(/Unclosed/)
  })
  it('rejects unknown fields, duplicates, invalid JSON, missing inputs and prototype data before execution', () => {
    for (const text of ['--wrong x', '--title x --title y', '--title x --count NaN', '--title x --metadata \'{"__proto__":{}}\'', '--count 2']) {
      expect(() => bindWorkflowArguments(tokenizeWorkflowCommand(text), manifest())).toThrow()
    }
  })
})

describe('authoritative workflow invocation resolver', () => {
  it('preserves built-ins and literal slash, and requires explicit choice for skill collisions', async () => {
    const { registry } = fixture()
    const resolver = new WorkflowInvocationResolver(registry, async () => new Set(['release_notes']))
    const owner = { profileId: 'profile-a' }
    await expect(resolver.resolve('/help "unfinished', owner)).resolves.toMatchObject({ kind: 'builtin', name: 'help' })
    await expect(resolver.resolve('//release_notes text', owner)).resolves.toEqual({ kind: 'text', text: '/release_notes text' })
    await expect(resolver.resolve('/release_notes launch', owner)).resolves.toMatchObject({ kind: 'ambiguous', choices: ['/workflow release_notes', '/skill release_notes'] })
    await expect(resolver.resolve('/workflow release_notes launch', owner)).resolves.toMatchObject({ kind: 'workflow', input: { title: 'launch' } })
    await expect(resolver.resolve('/skill release_notes --flag "exact text"', owner)).resolves.toMatchObject({ kind: 'skill', arguments: '--flag "exact text"' })
  })
  it('pins a chosen immutable revision and rejects foreign owners, unpublished/archive and stale versions', async () => {
    const { registry, source, published } = fixture()
    const resolver = new WorkflowInvocationResolver(registry)
    const owner = { profileId: 'profile-a' }
    const edited = registry.saveDraft({ bundle: { manifest: { ...source, description: 'Changed draft' }, assets: [] }, expectedDraftSemanticHash: published.semanticHash })
    registry.publish({ definitionId: edited.definitionId, expectedDraftSemanticHash: edited.semanticHash })
    const exact = await resolver.resolve('/workflow release_notes --version ' + published.semanticHash + ' release', owner)
    expect(exact).toMatchObject({ kind: 'workflow', revisionId: published.semanticHash, input: { title: 'release' } })
    await expect(resolver.resolve('/release_notes release', { profileId: 'profile-b' })).rejects.toMatchObject({ code: 'profile_mismatch' })
    await expect(resolver.resolve('/workflow release_notes --version ' + '0'.repeat(64) + ' release', owner)).rejects.toMatchObject({ code: 'stale_revision' })
    await expect(resolver.resolve('/workflow release_notes --version ' + published.semanticHash + ' --version ' + edited.semanticHash + ' release', owner)).rejects.toThrow(/only one/)
    registry.archive(published.definitionId)
    await expect(resolver.resolve('/release_notes release', owner)).resolves.toMatchObject({ kind: 'unknown' })
    const draft = manifest()
    registry.saveDraft({ bundle: { manifest: draft, assets: [] } })
    await expect(resolver.resolve('/release_notes release', owner)).rejects.toMatchObject({ code: 'unpublished_workflow' })
  })
})
