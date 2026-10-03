import type { MmsProfileServices } from '../../MmsProfileServices'
import { dispatchMethod } from '../../protocol/handlers'
import { NetError } from '../../../shared/net'
import type { RemoteBackendPort } from './RemoteApi'
import { mmsJson } from './jsonOutput'
import type { BridgeOrdinaryMethod } from './capabilities'

/** Adapts the actual profile services, never a client-supplied ingress/profile/path. */
export class MmsRemoteBackend implements RemoteBackendPort {
  constructor(private readonly services: MmsProfileServices, private readonly revision:()=>number = ()=>0) {}
  async execute(method: BridgeOrdinaryMethod, params: Record<string, unknown>): Promise<unknown> {
    if(typeof params.threadId==='string'&&!this.services.threads.listAllThreads().some(thread=>thread.id===params.threadId))throw new NetError('stream_unknown','Thread is outside this profile inventory.')
    if(typeof params.projectId==='string'&&!this.services.projects.listProjects().some(project=>project.id===params.projectId))throw new NetError('bad_request','Project is outside this profile inventory.')
    return mmsJson(await dispatchMethod({mms:this.services,globalSequence:this.revision,emitEvent:(type,data)=>{if(type==='threads.updated')this.services.events.broadcast('threads:updated',data)}},method,params))
  }
  snapshot(threadId: string, maximumBytes=25*1024*1024): unknown {
    const s=this.services,thread=s.threads.listAllThreads().find(thread=>thread.id===threadId)
    if(!thread)throw new NetError('stream_unknown','Thread not found.')
    return mmsJson({thread,messages:s.orchestrator.getMessages(threadId),queue:s.orchestrator.listQueue(threadId),pendingQuestions:s.questions.listPendingForThread(threadId),activeTurn:{active:s.orchestrator.isTurnActive(threadId),running:s.orchestrator.isActiveTurnRunning(threadId)},revision:this.revision()},maximumBytes)
  }
  async run(threadId: string, content: string, control: Parameters<RemoteBackendPort['run']>[2]): Promise<unknown> {
    if(!this.services.threads.listAllThreads().find(thread=>thread.id===threadId))throw new NetError('stream_unknown','Thread not found.')
    // Existing MMS takes an owned cross-process lease and binds this exact signal to executeTurn.
    return mmsJson(await this.services.orchestrator.runChannelTurn(threadId,content,this.services.threads,{signal:control.signal,drainSteer:control.drainSteer}))
  }
}
