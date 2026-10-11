import {BridgeDisplayDecoder,type BridgeEntityRef,type BridgeDisplayPart} from '../../../src/shared/bridge'

// This bundle runs in the real isolated renderer. It accepts actual preload
// deliveries immediately, exercising the decoder's own bounded async queue.
const target=globalThis as unknown as {mousse:{bridge?:{onThreadPart(callback:(part:BridgeDisplayPart)=>void):()=>void}};display:any}
const state:any={parts:0,views:0,partialViews:0,errors:[],snapshot:null,renamed:false,afterDispose:0,disposed:false,lastPosition:null,transaction:null}
let decoder:BridgeDisplayDecoder|undefined
let off=()=>{}
target.display={
  state,
  api:typeof target.mousse.bridge?.onThreadPart==='function',
  configure(ref:BridgeEntityRef){decoder=new BridgeDisplayDecoder({ref});off=target.mousse.bridge?.onThreadPart(part=>{
    state.parts++;if(state.disposed)state.afterDispose++
    if(part.update.kind==='snapshot.begin')state.transaction={sha256:part.update.sha256,chunks:part.update.chunks,totalBytes:part.update.totalBytes}
    void decoder!.accept(part).then(event=>{
      if(!event){if(!state.snapshot&&state.views)state.partialViews++;return}
      state.lastPosition={stream:event.stream,epoch:event.epoch,seq:event.seq}
      if(event.update.kind==='snapshot'){state.snapshot=event.update.value;state.views++}
      else if(JSON.stringify(event).includes('GUI remote verified rename'))state.renamed=true
    },error=>state.errors.push(String(error?.code??error)))
  })??(()=>{})},
  dispose(){state.disposed=true;off()},
  async close(){off();await decoder?.drain();decoder?.close()}
}
