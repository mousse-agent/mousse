import { NetError, isId } from '../../../shared/net'
import { canonicalJson } from '../../net/sync/codec'
import type { BridgeRemoteMethod } from './capabilities'

export function validateRemoteParams(method: BridgeRemoteMethod, value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Buffer.byteLength(canonicalJson(value)) > 128 * 1024) throw new NetError('bad_request')
  const p = value as Record<string, unknown>
  const keys = (required: string[], optional: string[] = []): void => {
    if (required.some(key => !Object.hasOwn(p,key)) || Object.keys(p).some(key => ![...required,...optional].includes(key))) throw new NetError('bad_request')
  }
  const text = (key: string, max = 256, optional = false): void => { if (optional && !Object.hasOwn(p,key)) return; if (typeof p[key] !== 'string' || !(p[key] as string).trim() || (p[key] as string).length > max) throw new NetError('bad_request') }
  const boolean = (key: string, optional = false): void => { if (optional && !Object.hasOwn(p,key)) return; if (typeof p[key] !== 'boolean') throw new NetError('bad_request') }
  switch (method) {
    case 'projects.list': keys([]); break
    case 'threads.list': keys([],['projectId']); text('projectId',256,true); break
    case 'threads.get': case 'thread.snapshot': case 'orchestrator.isTurnActive': case 'orchestrator.contextUsage': keys(['threadId']); text('threadId'); break
    case 'threads.search': keys(['query'],['limit']); text('query',512); if (p.limit !== undefined && (!Number.isSafeInteger(p.limit) || Number(p.limit)<1 || Number(p.limit)>200)) throw new NetError('bad_request'); break
    case 'threads.create': keys(['name'],['projectId','worktreeEnabled']); text('name',512);text('projectId',256,true);boolean('worktreeEnabled',true);break
    case 'threads.rename': keys(['threadId','name']);text('threadId');text('name',512);break
    case 'threads.pin': keys(['threadId','pinned']);text('threadId');boolean('pinned');break
    case 'threads.settle':keys(['threadId','settled']);text('threadId');boolean('settled');break
    case 'orchestrator.send': keys(['threadId','content']);text('threadId');text('content',64*1024);break
    case 'orchestrator.steer':keys(['threadId','run','text']);text('threadId');text('text',64*1024);if(!isId('rpc',p.run))throw new NetError('bad_request');break
    case 'orchestrator.abort':keys(['threadId','run']);text('threadId');if(!isId('rpc',p.run))throw new NetError('bad_request');break
  }
}
