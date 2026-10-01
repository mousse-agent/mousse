/**
 * Model-free local workflow bundle for Linux CLI qualification.
 * start → trusted-local node script → end. No provider, no network.
 */
import { randomUUID } from 'node:crypto'

export const SCRIPT_SOURCE =
  "let s='';for await(const c of process.stdin)s+=c;console.log(JSON.stringify({script:true,linux:true,input:JSON.parse(s)}))"

export function scriptOnlyWorkflowBundle({
  id = randomUUID(),
  slug = 'linux-qual-echo',
  name = 'Linux qualification echo'
} = {}) {
  return {
    assets: [
      {
        relativePath: 'scripts/echo.mjs',
        encoding: 'utf8',
        data: SCRIPT_SOURCE
      }
    ],
    manifest: {
      schemaVersion: 1,
      id,
      name,
      slug,
      description: 'Local trusted-local script with no model or external service.',
      entryNodeId: 'start',
      inputSchema: {
        type: 'object',
        properties: { count: { type: 'integer' } },
        required: ['count'],
        additionalProperties: false
      },
      outputSchema: { type: 'object' },
      permissions: { capabilities: ['script.trusted-local'] },
      nodes: [
        { id: 'start', type: 'start', version: 1, config: {} },
        {
          id: 'script',
          type: 'script',
          version: 1,
          inputs: { count: { ref: 'input', pointer: '/count' } },
          config: {
            runtime: 'node',
            file: 'scripts/echo.mjs',
            executionMode: 'trusted-local'
          }
        },
        {
          id: 'end',
          type: 'end',
          version: 1,
          config: {},
          inputs: { result: { ref: 'node', nodeId: 'script', pointer: '' } }
        }
      ],
      edges: [
        { from: 'start', port: 'next', to: 'script' },
        { from: 'script', port: 'success', to: 'end' }
      ]
    }
  }
}

export function passthroughWorkflowBundle({
  id = randomUUID(),
  slug = 'linux-qual-passthrough',
  name = 'Linux qualification passthrough'
} = {}) {
  return {
    assets: [],
    manifest: {
      schemaVersion: 1,
      id,
      name,
      slug,
      description: 'Passthrough start→end with no model, script, or external service.',
      entryNodeId: 'start',
      inputSchema: {
        type: 'object',
        properties: { ping: { type: 'string' } },
        required: ['ping'],
        additionalProperties: false
      },
      outputSchema: { type: 'object' },
      permissions: { capabilities: [] },
      nodes: [
        { id: 'start', type: 'start', version: 1, config: {} },
        {
          id: 'end',
          type: 'end',
          version: 1,
          config: {},
          inputs: { result: { ref: 'input', pointer: '' } }
        }
      ],
      edges: [{ from: 'start', port: 'next', to: 'end' }]
    }
  }
}
