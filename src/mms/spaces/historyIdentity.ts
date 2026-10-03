import type { IdentityService } from '../net/contracts'
import type { StreamStore } from '../net/contracts'
import { NetError } from '../../shared/net'
import type { NodeDelegation as SignedNode, Roster as SignedRoster } from '../../shared/net'
import { verifyBytes, verifyDocument } from '../net/identity/crypto'
import { decodeEnvelope } from '../net/sync/codec'
import type { MetaProjection } from './host'
import type { RosterEvidence } from './RosterEvidence'

/** Signed meta supplies the historical root; retained documents supply keys only.
 * This adapter never pins users or grants current authority from replay evidence. */
export function spaceHistoryIdentity(identity:IdentityService,store:StreamStore,meta:MetaProjection,evidence:RosterEvidence):IdentityService {
  const verify:IdentityService['verifyAuthor']=(author,bytes,sig,at,purpose)=>{
    try{return identity.verifyAuthor(author,bytes,sig,at,purpose)}catch(error){
      if(purpose!=='history' || !(error instanceof NetError) || error.code!=='bad_delegation' || !author.user || author.bot)throw error
      const envelope=decodeEnvelope(bytes).envelope,descriptor=store.getStream(envelope.stream)
      if(!descriptor?.space || !envelope.auth)throw error
      const member=meta.memberAt(descriptor.space,author.user,envelope.auth)
      if(!member || identity.pinnedRootKey(author.user) && identity.pinnedRootKey(author.user)!==member.rootKey)throw error
      const signed=evidence.forAuthor(author,at,member.rootKey)
      if(!signed)throw error
      const roster=verifyDocument<SignedRoster>(signed,member.rootKey,'roster')
      if(roster.owner!==author.user || roster.rootKey!==member.rootKey)throw new NetError('bad_delegation')
      const node=roster.nodes.map(row=>verifyDocument<SignedNode>(row,member.rootKey,'nodeDelegation'))
        .filter(row=>row.owner===author.user && row.subject===author.node && row.keyEpoch===author.keyEpoch && row.issuedAt<=at && at<row.expiresAt)
        .sort((a,b)=>b.issuedAt-a.issuedAt)[0]
      if(!node || node.expiresAt-node.issuedAt>7*86400000)throw new NetError('bad_delegation')
      verifyBytes(bytes,sig,node.keys.sign)
      return {kind:'node',user:author.user,node:author.node,delegation:node,verifyOnly:true,revoked:roster.revoked.some(row=>row.subject===author.node && row.throughKeyEpoch>=author.keyEpoch)}
    }
  }
  return new Proxy(identity,{get:(target,key)=>key==='verifyAuthor'?verify:typeof Reflect.get(target,key)==='function'?Reflect.get(target,key).bind(target):Reflect.get(target,key)})
}
