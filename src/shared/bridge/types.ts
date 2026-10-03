import type { NodeId, RpcId, StreamDescriptor, StreamHead, RpcArtifactRef, NetErrorCode } from '../net';
import type { AgentExecutionBudget } from '../agents/execution';
export interface BridgeEntityRef {
    nodeId: NodeId;
    entityId: string;
}
export interface BridgeDispatchInput {
    repoId: string;
    baseCommit: string;
    agent: string;
    prompt: string;
    limits: AgentExecutionBudget;
    inputBundle?: RpcArtifactRef;
    fetch?: boolean;
    push?: boolean;
}
export interface BridgeRemoteParams {
    'projects.list': Record<string, never>;
    'threads.list': {
        projectId?: string;
    };
    'threads.get': {
        threadId: string;
    };
    'threads.search': {
        query: string;
        limit?: number;
    };
    'thread.snapshot': {
        threadId: string;
    };
    'threads.create': {
        name: string;
        projectId?: string;
        worktreeEnabled?: boolean;
    };
    'threads.rename': {
        threadId: string;
        name: string;
    };
    'threads.pin': {
        threadId: string;
        pinned: boolean;
    };
    'threads.settle': {
        threadId: string;
        settled: boolean;
    };
    'orchestrator.send': {
        threadId: string;
        content: string;
    };
    'orchestrator.steer': {
        threadId: string;
        run: RpcId;
        text: string;
    };
    'orchestrator.abort': {
        threadId: string;
        run: RpcId;
    };
    'orchestrator.isTurnActive': {
        threadId: string;
    };
    'orchestrator.contextUsage': {
        threadId: string;
    };
    'bridge.thread.open': {
        threadId: string;
    };
    'bridge.artifacts.open': {
        forRpcId: RpcId;
        forMethod: 'bridge.dispatch';
    };
    'bridge.dispatch': BridgeDispatchInput;
}
export type BridgeMethod = keyof BridgeRemoteParams;
export interface BridgeThreadOpenResult {
    descriptor: StreamDescriptor;
    head: StreamHead;
}
export interface BridgeHubRequestOptions {
    id?: RpcId;
    idem?: string;
    deadlineMs?: number;
}
export type BridgeHubRequestState = 'prepared' | 'unknown' | 'completed' | 'failed' | 'cancelRequested';
export interface BridgeHubRequestStatus {
    id: RpcId;
    original: RpcId;
    target: NodeId;
    method: BridgeMethod;
    state: BridgeHubRequestState;
    createdAt: number;
    updatedAt: number;
    error?: NetErrorCode;
}
export const BRIDGE_HUB_LOCAL_METHODS = ['bridge.hub.projects', 'bridge.hub.threads', 'bridge.hub.get', 'bridge.hub.search', 'bridge.hub.create', 'bridge.hub.send', 'bridge.hub.steer', 'bridge.hub.abort', 'bridge.hub.attach', 'bridge.hub.detach', 'bridge.hub.dispatch', 'bridge.hub.result', 'bridge.hub.cancel', 'bridge.hub.requests'] as const;
export type BridgeHubLocalMethod = typeof BRIDGE_HUB_LOCAL_METHODS[number];
/** Trusted local ingress uses the already authenticated network capability. */
export const BRIDGE_HUB_LOCAL_CAPABILITY = 'net.v1';
export interface BridgeHubLocalParams {
    'bridge.hub.projects': {
        target: NodeId;
    };
    'bridge.hub.threads': {
        target: NodeId;
        projectId?: string;
    };
    'bridge.hub.get': {
        ref: BridgeEntityRef;
    };
    'bridge.hub.search': {
        target: NodeId;
        query: string;
        limit?: number;
    };
    'bridge.hub.create': {
        target: NodeId;
        name: string;
        projectId?: string;
        options?: BridgeHubRequestOptions;
    };
    'bridge.hub.send': {
        ref: BridgeEntityRef;
        content: string;
        options?: BridgeHubRequestOptions;
    };
    'bridge.hub.steer': {
        ref: BridgeEntityRef;
        run: RpcId;
        text: string;
        options?: BridgeHubRequestOptions;
    };
    'bridge.hub.abort': {
        ref: BridgeEntityRef;
        run: RpcId;
        options?: BridgeHubRequestOptions;
    };
    'bridge.hub.attach': {
        ref: BridgeEntityRef;
    };
    'bridge.hub.detach': {
        ref: BridgeEntityRef;
    };
    'bridge.hub.dispatch': {
        target: NodeId;
        input: BridgeDispatchInput;
        options?: BridgeHubRequestOptions;
    };
    'bridge.hub.result': {
        id: RpcId;
    };
    'bridge.hub.cancel': {
        id: RpcId;
    };
    'bridge.hub.requests': {
        target?: NodeId;
    };
}
export type BridgeHubThreadEvent = import('./display').BridgeDisplayPart;
export const BRIDGE_HUB_THREAD_EVENT = 'bridge.hub.thread';
