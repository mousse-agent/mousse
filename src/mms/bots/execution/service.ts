import { randomUUID } from 'node:crypto'
import type { BotApprovalPort, BotRunEvents, BotRunRequest, BotRuntimeAdapter, BudgetLedger, CompartmentStore, ExecutionLedger, ExecutionRecord } from '../../net/contracts'
import type { BotId, ExecutionId, SpaceId } from '../../../shared/net'
import { NetError } from '../../../shared/net'
import { NetDatabase, json } from '../../net/store/database'
import { BotAdmissionService, BotOutbox, type AuthorizedMention, type PreparedBotReceipt } from '../admission'
import type { SqliteBotRegistry } from '../registry'
import { MmsBotMaterializer, type MaterializedBotWorkspace } from './materializer'
export interface BotExecutionOptions {
  db: NetDatabase; executions: ExecutionLedger; budgets: BudgetLedger; compartments: CompartmentStore
  registry: SqliteBotRegistry; admission: BotAdmissionService; output: BotOutbox; materializer: MmsBotMaterializer
  adapters: ReadonlyMap<string,BotRuntimeAdapter>
  approvals(record: ExecutionRecord, mention: AuthorizedMention, signal: AbortSignal): BotApprovalPort
  /** Receives only opaque state; public presence must never receive prompt/tool/private text. */
  onState?(record: ExecutionRecord): void
}
export class BotExecutionService {
  private active = new Map<ExecutionId, { controller: AbortController; settled: Promise<ExecutionRecord> }>()
  constructor(readonly options: BotExecutionOptions) {
    options.db.transaction(() => options.db.database.exec('CREATE TABLE IF NOT EXISTS net_bot_terminal_pending(execution TEXT PRIMARY KEY,code TEXT NOT NULL);CREATE TABLE IF NOT EXISTS net_bot_failure_evidence(execution TEXT PRIMARY KEY,evidence TEXT NOT NULL)'))
    options.registry.onChanged(bot => this.onRosterChanged(undefined, bot))
  }
  start(execution: ExecutionId): Promise<ExecutionRecord> {
    const existing = this.active.get(execution); if (existing) return existing.settled
    if (this.options.db.inTransaction) return Promise.reject(new NetError('bad_request'))
    const record = this.options.executions.get(execution)
    if (!record || record.state !== 'accepted') return Promise.reject(new NetError('conflict'))
    const controller = new AbortController()
    // Install ownership before running any synchronous setup/observer callback.
    const settled = Promise.resolve().then(() => this.run(record, controller)).finally(() => this.active.delete(execution))
    this.active.set(execution, { controller, settled }); return settled
  }
  cancel(execution: ExecutionId): Promise<ExecutionRecord> | undefined { const active = this.active.get(execution); active?.controller.abort(); return active?.settled }
  onMetaChanged(space: SpaceId): void { this.reconcile(space) }
  onRosterChanged(_user?: string, bot?: BotId): void { this.reconcile(undefined, bot) }
  onPrivateChanged(stream: string): void { for (const [id, active] of this.active) if (this.options.executions.get(id)?.binding?.stream === stream) active.controller.abort() }
  async stop(space: SpaceId, bot: BotId): Promise<void> { this.options.registry.stop(space, bot); await Promise.all([...this.active].filter(([id]) => this.options.executions.get(id)?.target === bot).map(([,active]) => active.settled));if(this.options.db.database.prepare('SELECT 1 FROM net_bot_admission_slots WHERE bot=? AND active=1 LIMIT 1').get(bot))throw new NetError('outcome_uncertain', 'Bot effects have not proved quiescence.') }
  recoverAfterRestart(): ExecutionRecord[] {
    if (this.active.size) throw new NetError('conflict')
    // Cannot fabricate a new receipt through revoked/unreadable private authority. Such rows remain local pending evidence.
    const recovered: ExecutionRecord[] = []
    for (;;) {
      const rows = this.options.db.database.prepare("SELECT e.id,e.state FROM net_executions e JOIN net_bot_admission_context c ON c.execution=e.id WHERE e.state IN ('accepted','running','waitingApproval') ORDER BY e.id LIMIT 100").all()
      if (!rows.length) break
      for (const row of rows) recovered.push(this.options.executions.transition(row.id as ExecutionId,row.state==='accepted'?'failed':'uncertain',this.options.db.clock.now(),{error:{code:row.state==='accepted'?'not_started':'outcome_uncertain',message:'Execution stopped before restart.'}},record=>{
        this.account(record); this.options.admission.release(record.id)
        this.options.db.charge(1); this.options.db.database.prepare('INSERT OR IGNORE INTO net_bot_terminal_pending VALUES(?,?)').run(record.id,record.error!.code)
        this.notify(record)
      }))
    }
    // A prior process may already have recorded uncertainty while retaining its live slot.
    // Startup proves that local process/effects are gone, never that its provider usage is known.
    for (;;) {
      const held=this.options.db.database.prepare("SELECT e.id FROM net_executions e JOIN net_bot_admission_slots s ON s.execution=e.id WHERE s.active=1 AND e.state='uncertain' LIMIT 100").all()
      if(!held.length)break
      for(const row of held)this.options.db.transaction(()=>{const record=this.options.executions.get(row.id as ExecutionId)!;this.account(record);this.options.admission.release(record.id)})
    }
    return recovered
  }

  /** Retried publication is limited to generic terminal metadata, never model/effect execution. */
  flushTerminalPending(): number {
    if(this.options.db.inTransaction)throw new NetError('bad_request')
    let published=0
    const rows=this.options.db.database.prepare('SELECT execution FROM net_bot_terminal_pending ORDER BY execution LIMIT 100').all()
    for(const row of rows){
      const record=this.options.executions.get(row.execution as ExecutionId)
      if(!record?.binding)continue
      try{
        const mention=this.options.admission.mentionForExecution(record.id),body=record.state==='cancelled'?{by:mention.bot.owner}:record.state==='uncertain'?{summary:'Execution outcome requires owner review.'}:{code:record.error?.code??'not_started',message:'Bot execution stopped.'},prepared=this.options.output.prepareTerminal(mention,record.id,record.binding,`bot.run.${record.state}`,body)
        this.options.db.transaction(()=>{
          this.options.admission.mentionForExecution(record.id)
          this.options.output.enqueueTerminal(record,prepared);this.options.db.charge(1);this.options.db.database.prepare('DELETE FROM net_bot_terminal_pending WHERE execution=?').run(record.id)
        });published++
      }catch{/* Keep pending while current authorization, audience, clock or keys cannot qualify publication. */}
    }
    return published
  }
  private async run(record: ExecutionRecord, controller: AbortController): Promise<ExecutionRecord> {
    let mention: AuthorizedMention | undefined, workspace: MaterializedBotWorkspace | undefined
    try {
      const bot = this.options.admission.assertExecutionCurrent(record.id); mention = this.options.admission.mentionForExecution(record.id)
      workspace = this.options.materializer.materialize(record, bot)
      this.options.admission.assertExecutionCurrent(record.id); if (controller.signal.aborted) throw new NetError('cancelled')
      this.options.executions.transition(record.id,'running',this.options.db.clock.now(),undefined,next=>this.notify(next))
      const binding = record.binding!, request: BotRunRequest = { execution:record.id,bot:binding.bot,space:binding.space,profile:bot.profile,compartment:binding.compartment,prompt:mention.body.text,spendCeilingUnits:bot.runCeilingUnits,outputStream:binding.stream,backingThreadId:binding.backingThreadId,workspaceId:binding.workspaceId,definitionRevision:binding.definitionRevision,profileDigest:binding.profileDigest,...(binding.visibilityEpoch===undefined?{}:{visibilityEpoch:binding.visibilityEpoch,participantHash:binding.participantHash}),...(workspace.projectRoot?{projectRoot:workspace.projectRoot}:{}),spend:{authorizeCall:async maximum=>{this.current(record.id,workspace!,controller.signal);const id=randomUUID();this.options.budgets.authorizeCall(record.id,id,maximum);return{id}},settleCall:async(id,spent)=>this.options.budgets.settleCall(record.id,id,spent),remainingUnits:()=>this.remaining(record.id,bot.runCeilingUnits)},approvals:this.options.approvals(record,mention,controller.signal),signal:controller.signal }
      let progress=0
      const events: BotRunEvents = { onProgress:text=>{this.current(record.id,workspace!,controller.signal);if(++progress>256)throw new NetError('too_large');this.publish(record.id,mention!,'bot.run.progress',{text})},onToolSummary:(tool,summary)=>{this.current(record.id,workspace!,controller.signal);this.publish(record.id,mention!,'bot.run.toolSummary',{tool,summary})},onWaitingApproval:summary=>{this.current(record.id,workspace!,controller.signal);this.publish(record.id,mention!,'bot.run.waitingApproval',{summary})} }
      const adapter = this.options.adapters.get(bot.adapter); if (!adapter?.supports(bot.profile)) throw new NetError('profile_unsupported')
      const result = await adapter.run(request,events)
      this.current(record.id,workspace,controller.signal)
      const known = this.knownSpend(record.id)
      if (known === undefined || known !== result.spentUnits) throw new NetError('outcome_uncertain')
      const prepared = this.options.output.prepareTerminal(mention,record.id,binding,'bot.run.completed',{text:result.text})
      return this.options.executions.transition(record.id,'completed',this.options.db.clock.now(),{result:{text:result.text,spentUnits:known}},next=>{if(controller.signal.aborted)throw new NetError('cancelled');this.options.materializer.assertProjectCurrent(this.options.admission.assertAuthorityCurrent(record.id),workspace!);this.account(next);this.options.admission.release(record.id);this.options.compartments.appendTurn(binding.compartment,{role:'user',author:mention!.author,text:mention!.body.text,ts:mention!.envelope.ts});this.options.compartments.appendTurn(binding.compartment,{role:'assistant',author:binding.bot,text:result.text,ts:this.options.db.clock.now()});this.options.output.enqueueTerminal(next,prepared);this.notify(next)})
    } catch(error) {
      const current = this.options.executions.get(record.id)!
      if (['completed','failed','cancelled','uncertain'].includes(current.state)) return current
      const cause = error instanceof NetError?error:new NetError('internal',undefined,{cause:error}), unknown = this.knownSpend(record.id)===undefined
      const state = unknown||cause.code==='outcome_uncertain'?'uncertain':cause.code==='cancelled'?'cancelled':'failed'
      let prepared:PreparedBotReceipt|undefined
      try { if(mention&&record.binding){const body=state==='cancelled'?{by:mention.bot.owner}:state==='uncertain'?{summary:'Execution outcome requires owner review.'}:{code:cause.code,message:'Bot execution stopped.'};prepared=this.options.output.prepareTerminal(mention,record.id,record.binding,`bot.run.${state}`,body)} } catch { /* Authorization/keys changed; retain local pending receipt, never publish across a changed audience. */ }
      return this.options.executions.transition(record.id,state,this.options.db.clock.now(),{error:{code:cause.code,message:'Bot execution stopped.'}},next=>{if(cause.details&&typeof cause.details==='object'){const allowed=['callId','maximumUnits','reportedUnits','code','quiesced'],evidence=Object.fromEntries(Object.entries(cause.details).filter(([key,value])=>allowed.includes(key)&&['string','number','boolean'].includes(typeof value)).map(([key,value])=>[key,typeof value==='number'&&!Number.isSafeInteger(value)?String(value):value])),text=json(evidence);this.options.db.charge(1,Buffer.byteLength(text));this.options.db.database.prepare('INSERT OR REPLACE INTO net_bot_failure_evidence VALUES(?,?)').run(record.id,text)}this.account(next);if(!unknown||cause.details&&typeof cause.details==='object'&&(cause.details as {quiesced?:boolean}).quiesced===true)this.options.admission.release(record.id);if(prepared)this.options.output.enqueueTerminal(next,prepared);else{this.options.db.charge(1);this.options.db.database.prepare('INSERT OR IGNORE INTO net_bot_terminal_pending VALUES(?,?)').run(record.id,cause.code)}this.notify(next)})
    }
  }
  private publish(execution: ExecutionId, mention: AuthorizedMention, type: string, body: unknown): void {
    const record=this.options.executions.get(execution)!,prepared=this.options.output.prepareTerminal(mention,execution,record.binding!,type,body)
    this.options.db.transaction(()=>{this.options.admission.assertExecutionCurrent(execution);this.options.output.enqueueTerminal(record,prepared)})
  }
  private current(execution:ExecutionId,workspace:MaterializedBotWorkspace,signal:AbortSignal):void {if(signal.aborted)throw new NetError('cancelled');const bot=this.options.admission.assertExecutionCurrent(execution);this.options.materializer.assertProjectCurrent(bot,workspace)}
  private reconcile(space?:SpaceId,bot?:BotId):void {for(const[id,active]of this.active){const record=this.options.executions.get(id)!;if(space&&record.scope!==space||bot&&record.target!==bot)continue;try{this.options.admission.assertExecutionCurrent(id)}catch{active.controller.abort()}}}
  private remaining(execution:ExecutionId,ceiling:number):number {const rows=this.options.db.database.prepare('SELECT maximum,spent FROM net_budget_calls WHERE execution=?').all(execution);return ceiling-rows.reduce((n,row)=>n+Number(row.spent??row.maximum),0)}
  private knownSpend(execution:ExecutionId):number|undefined {const rows=this.options.db.database.prepare('SELECT spent FROM net_budget_calls WHERE execution=?').all(execution);if(rows.some(row=>row.spent===null))return undefined;const total=rows.reduce((n,row)=>n+Number(row.spent),0);if(!Number.isSafeInteger(total))throw new NetError('storage_corrupt');return total}
  private account(record:ExecutionRecord):void {const known=this.knownSpend(record.id);if(known!==undefined)this.options.budgets.settle(record.id,known)}
  private notify(record:ExecutionRecord):void {this.options.db.afterCommit(()=>this.options.onState?.(record))}
}
export const deniedBotApprovals: BotApprovalPort = { requestAction:async()=>{throw new NetError('forbidden')},consume:async()=>{throw new NetError('forbidden')} }
