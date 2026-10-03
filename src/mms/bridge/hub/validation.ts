import { NetError, isId } from '../../../shared/net';
import type { BridgeMethod, BridgeRemoteParams } from '../../../shared/bridge';
import { BRIDGE_REMOTE_METHODS, validateRemoteParams } from '../remote';
import { dispatchRequest } from '../dispatch/validate';
export const HUB_METHODS = { ...BRIDGE_REMOTE_METHODS, 'bridge.thread.open': { capability: 'read', mutating: false }, 'bridge.artifacts.open': { capability: 'write', mutating: true }, 'bridge.dispatch': { capability: 'write', mutating: true } } as const;
export function validateHubParams(method: BridgeMethod, value: unknown): BridgeRemoteParams[BridgeMethod] {
    if (!Object.hasOwn(HUB_METHODS, method))
        throw new NetError('forbidden');
    if (method === 'bridge.dispatch')
        return dispatchRequest(value);
    if (method === 'bridge.thread.open') {
        validateRemoteParams('threads.get', value);
        return structuredClone(value as {
            threadId: string;
        });
    }
    if (method === 'bridge.artifacts.open') {
        if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'forMethod,forRpcId' || !isId('rpc', (value as any).forRpcId) || (value as any).forMethod !== 'bridge.dispatch')
            throw new NetError('bad_request');
        return structuredClone(value) as BridgeRemoteParams['bridge.artifacts.open'];
    }
    validateRemoteParams(method, value);
    return structuredClone(value) as BridgeRemoteParams[BridgeMethod];
}
