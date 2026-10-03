import type { ParsedArgs } from '../parseArgs';
import { connectDaemonClient, type DaemonClient } from '../daemonClient';
import { writeOutput } from '../output';
import { newId } from '../../shared/net';
import type { BridgeHubLocalMethod, BridgeHubLocalParams, BridgeHubRequestOptions, BridgeEntityRef } from '../../shared/bridge';
import { BRIDGE_HUB_THREAD_EVENT } from '../../shared/bridge';
import type { NodeId as NetNodeId } from '../../shared/net';
import { validateBridgeHubLocal } from '../../mms/bridge/hub/local';
import { netCliFailure } from './net';
export const BRIDGE_HUB_HELP = `  mousse-cli bridge projects <node-id>
  mousse-cli bridge threads <node-id> [--project <project-id>]
  mousse-cli bridge get <node-id> <thread-id>
  mousse-cli bridge search <node-id> <query> [--limit <count>]
  mousse-cli bridge create <node-id> <name> [--project <project-id>] [--id <rpc-id>] [--idem <key>]
  mousse-cli bridge send <node-id> <thread-id> <content> [--id <rpc-id>] [--idem <key>]
  mousse-cli bridge attach <node-id> <thread-id>
  mousse-cli bridge steer <node-id> <thread-id> <run-rpc-id> <text>
  mousse-cli bridge abort <node-id> <thread-id> <run-rpc-id>
  mousse-cli bridge dispatch <node-id> --repo <repo-id> --base <commit> --agent <id> --prompt <text> --turns <count> --tools <count> --elapsed <ms>
  mousse-cli bridge result <rpc-id>
  mousse-cli bridge cancel <rpc-id>
  mousse-cli bridge requests [node-id]

Mutations print their chosen rpc_ identifier so a lost reply can be recovered
with bridge result. Result lookup never re-executes an operation. Attach shows
verified display updates until interrupted. Provider, login and arbitrary path
arguments are rejected.
`;
export const BRIDGE_HUB_SUBCOMMANDS = ['projects', 'threads', 'get', 'search', 'create', 'send', 'attach', 'steer', 'abort', 'dispatch', 'result', 'cancel', 'requests'] as const;
export interface BridgeHubCliRequest {
    method: BridgeHubLocalMethod;
    params: BridgeHubLocalParams[BridgeHubLocalMethod];
    watch?: boolean;
}
export interface BridgeHubCliIO {
    emit(value: unknown, text: string): void;
    watch?(ref: BridgeEntityRef, ready: () => Promise<unknown>, update: (value: unknown) => void): Promise<void>;
    requestChosen?(id: string): void;
}
export type BridgeHubCliClient = Pick<DaemonClient, 'request'>;
function invalid(message: string): never { const error = new Error(message) as Error & {
    code: string;
}; error.code = 'bad_request'; throw error; }
function flag(args: ParsedArgs, key: string): string | undefined { const value = args.flags.get(key); if (value === undefined)
    return; if (typeof value !== 'string' || !value.length)
    return invalid(`--${key} requires a value.`); return value; }
function number(args: ParsedArgs, key: string, required = false): number | undefined { const value = flag(args, key); if (value === undefined)
    return required ? invalid(`--${key} is required.`) : undefined; const result = Number(value); if (!Number.isFinite(result) || result <= 0)
    return invalid(`--${key} requires a positive number.`); return result; }
export function prepareBridgeHubCommand(args: ParsedArgs): BridgeHubCliRequest {
    if (args.command !== 'bridge' || !BRIDGE_HUB_SUBCOMMANDS.includes(args.subcommand as any))
        return invalid('Unknown Bridge Hub command.');
    if (args.globals.provider || args.globals.model || args.globals.apiKey || args.globals.continueSession || args.globals.sessionId || args.globals.print)
        return invalid('Bridge Hub commands do not accept provider or chat overrides.');
    const sub = args.subcommand!, mutate = ['create', 'send', 'steer', 'abort', 'dispatch'].includes(sub), permitted = new Set(['profile', 'mode', ...(mutate ? ['id', 'idem', 'deadline'] : []), ...(sub === 'threads' || sub === 'create' ? ['project'] : []), ...(sub === 'search' ? ['limit'] : []), ...(sub === 'dispatch' ? ['repo', 'base', 'agent', 'prompt', 'turns', 'tools', 'elapsed', 'input-tokens', 'output-tokens', 'cost'] : [])]);
    for (const key of args.flags.keys()) {
        if (!permitted.has(key))
            return invalid('Unsupported Bridge Hub flag.');
        flag(args, key);
    }
    const count: Record<string, number> = { projects: 1, threads: 1, get: 2, search: 2, create: 2, send: 3, attach: 2, steer: 4, abort: 3, dispatch: 1, result: 1, cancel: 1 };
    if (sub === 'requests' ? args.positional.length > 1 : args.positional.length !== count[sub])
        return invalid('Invalid positional arguments for this Bridge command.');
    const target = args.positional[0] as NetNodeId, method = `bridge.hub.${sub}` as BridgeHubLocalMethod;
    const options: BridgeHubRequestOptions = { id: (flag(args, 'id') ?? newId('rpc')) as BridgeHubRequestOptions['id'] };
    if (mutate) {
        options.idem = flag(args, 'idem') ?? options.id;
        const deadline = number(args, 'deadline');
        if (deadline !== undefined)
            options.deadlineMs = deadline;
    }
    const ref: BridgeEntityRef = { nodeId: target, entityId: args.positional[1] };
    let params: unknown;
    switch (sub) {
        case 'projects':
            params = { target };
            break;
        case 'threads':
            params = { target, ...(flag(args, 'project') ? { projectId: flag(args, 'project') } : {}) };
            break;
        case 'get':
        case 'attach':
            params = { ref };
            break;
        case 'search':
            params = { target, query: args.positional[1], ...(number(args, 'limit') ? { limit: number(args, 'limit') } : {}) };
            break;
        case 'create':
            params = { target, name: args.positional[1], options, ...(flag(args, 'project') ? { projectId: flag(args, 'project') } : {}) };
            break;
        case 'send':
            params = { ref, content: args.positional[2], options };
            break;
        case 'steer':
            params = { ref, run: args.positional[2], text: args.positional[3], options };
            break;
        case 'abort':
            params = { ref, run: args.positional[2], options };
            break;
        case 'result':
        case 'cancel':
            params = { id: args.positional[0] };
            break;
        case 'requests':
            params = args.positional.length ? { target } : {};
            break;
        case 'dispatch': {
            const limits: Record<string, number | undefined> = { maxTurns: number(args, 'turns', true), maxToolCalls: number(args, 'tools', true), maxElapsedMs: number(args, 'elapsed', true) };
            for (const [flagName, key] of [['input-tokens', 'maxInputTokens'], ['output-tokens', 'maxOutputTokens'], ['cost', 'maxCostUsd']]) {
                const value = number(args, flagName);
                if (value !== undefined)
                    limits[key] = value;
            }
            params = { target, options, input: { repoId: flag(args, 'repo'), baseCommit: flag(args, 'base'), agent: flag(args, 'agent'), prompt: flag(args, 'prompt'), limits } };
            break;
        }
    }
    return { method, params: validateBridgeHubLocal(method, params), ...(sub === 'attach' ? { watch: true } : {}) };
}
export async function executeBridgeHubCommand(request: BridgeHubCliRequest, client: BridgeHubCliClient, io: BridgeHubCliIO): Promise<number> {
    const params = validateBridgeHubLocal(request.method, request.params), id = (params as {
        options?: BridgeHubRequestOptions;
    }).options?.id;
    if (id)
        io.requestChosen?.(id);
    if (request.watch) {
        if (!io.watch)
            return invalid('Attach requires a local event subscription.');
        const ref = (params as {
            ref: BridgeEntityRef;
        }).ref;
        try {
            await io.watch(ref, () => client.request(request.method, params), value => io.emit(value, JSON.stringify(value)));
        }
        finally {
            await client.request('bridge.hub.detach', { ref });
        }
        ;
        return 0;
    }
    const result = await client.request(request.method, params);
    const value = id ? { id, result } : result;
    io.emit(value, JSON.stringify(value, null, 2));
    return 0;
}
export async function runBridgeHubCommand(args: ParsedArgs): Promise<void> {
    let client: DaemonClient | undefined;
    try {
        const request = prepareBridgeHubCommand(args);
        client = await connectDaemonClient({ homeDir: args.globals.homeDir || undefined, requestTimeoutMs: 60000 });
        const profile = args.globals.profile ?? (await client.request<{
            defaultProfileId: string;
        }>('profiles.status')).defaultProfileId;
        await client.request('profiles.bind', { profile });
        const local = client.client;
        process.exitCode = await executeBridgeHubCommand(request, client, { emit: (value, text) => writeOutput(args.globals.mode, value, () => text), requestChosen: id => process.stderr.write(`Request: ${id}\n`), watch: async (ref, ready, update) => {
                const off = local.onEvent(event => { if (event.type !== BRIDGE_HUB_THREAD_EVENT)
                    return; const data = event.data as {
                    ref?: BridgeEntityRef;
                    update?: unknown;
                }; if (data.ref?.nodeId === ref.nodeId && data.ref.entityId === ref.entityId)
                    update(data.update); });
                let stop: () => void = () => { };
                const interrupted = new Promise<void>(resolve => { stop = resolve; });
                process.once('SIGINT', stop);
                process.once('SIGTERM', stop);
                try {
                    await local.subscribe();
                    await ready();
                    await interrupted;
                }
                finally {
                    off();
                    process.removeListener('SIGINT', stop);
                    process.removeListener('SIGTERM', stop);
                }
            } });
    }
    catch (error) {
        const failure = netCliFailure(error);
        process.stderr.write(args.globals.mode === 'json' ? `${JSON.stringify({ code: failure.code, error: failure.error })}\n` : `Error [${failure.code}]: ${failure.error}\n`);
        process.exitCode = failure.exitCode;
    }
    finally {
        await client?.close();
    }
}
