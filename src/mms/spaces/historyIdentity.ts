import type { IdentityService } from '../net/contracts'
import type { StreamStore } from '../net/contracts'
import { NetError } from '../../shared/net'
import type { BotDelegation as SignedBot, NodeDelegation as SignedNode, Roster as SignedRoster } from '../../shared/net'
import { verifyBytes, verifyDocument } from '../net/identity/crypto'
import { decodeEnvelope } from '../net/sync/codec'
import type { MetaProjection } from './host'
import type { RosterEvidence } from './RosterEvidence'

/** Signed meta supplies the historical root; retained documents supply keys only.
 * This adapter never pins users or grants current authority from replay evidence. */
export function spaceHistoryIdentity(identity:IdentityService,store:StreamStore,meta:MetaProjection,evidence:RosterEvidence):IdentityService {
  const verify:IdentityService['verifyAuthor']=(author,bytes,sig,at,purpose)=>{
    try{return identity.verifyAuthor(author,bytes,sig,at,purpose)}catch(error){
      if(purpose!=='history' || !(error instanceof NetError) || error.code!=='bad_delegation')throw error
      const envelope=decodeEnvelope(bytes).envelope,descriptor=store.getStream(envelope.stream)
      if(!descriptor?.space || !envelope.auth)throw error
      const bot=author.bot && !author.user ? meta.botAt(descriptor.space,author.bot,envelope.auth) : undefined
      const owner=author.user ?? (bot ? bot.owner : undefined)
      if(!owner || author.bot && !bot || author.user && author.bot)throw error
      const member=meta.memberAt(descriptor.space,owner,envelope.auth)
      if(!member || identity.pinnedRootKey(owner) && identity.pinnedRootKey(owner)!==member.rootKey)throw error
      const signed=author.bot ? evidence.forBot(author,owner,at,member.rootKey) : evidence.forAuthor(author,at,member.rootKey)
      if(!signed)throw error
      const roster=verifyDocument<SignedRoster>(signed,member.rootKey,'roster')
      if(roster.owner!==owner || roster.rootKey!==member.rootKey)throw new NetError('bad_delegation')
      if(author.bot && bot){
        const registered=verifyDocument<SignedBot>(bot.delegation,member.rootKey,'botDelegation')
        const delegated=roster.bots.map(row=>verifyDocument<SignedBot>(row,member.rootKey,'botDelegation'))
          .filter(row=>row.owner===owner && row.subject===author.bot && row.hostNode===author.node && row.keyEpoch===author.keyEpoch && row.issuedAt<=at && at<row.expiresAt)
          .sort((a,b)=>b.issuedAt-a.issuedAt)[0]
        if(!delegated || registered.subject!==delegated.subject || registered.owner!==owner || registered.hostNode!==delegated.hostNode || registered.keyEpoch!==delegated.keyEpoch || registered.keys.sign!==delegated.keys.sign || delegated.expiresAt-delegated.issuedAt>7*86400000)throw new NetError('bad_delegation')
        verifyBytes(bytes,sig,delegated.keys.sign)
        return {kind:'bot',user:owner,node:author.node,bot:author.bot,delegation:delegated,verifyOnly:true,revoked:roster.revoked.some(row=>row.subject===author.bot && row.throughKeyEpoch>=author.keyEpoch)}
      }
      const node=roster.nodes.map(row=>verifyDocument<SignedNode>(row,member.rootKey,'nodeDelegation'))
        .filter(row=>row.owner===owner && row.subject===author.node && row.keyEpoch===author.keyEpoch && row.issuedAt<=at && at<row.expiresAt)
        .sort((a,b)=>b.issuedAt-a.issuedAt)[0]
      if(!node || node.expiresAt-node.issuedAt>7*86400000)throw new NetError('bad_delegation')
      verifyBytes(bytes,sig,node.keys.sign)
      return {kind:'node',user:owner,node:author.node,delegation:node,verifyOnly:true,revoked:roster.revoked.some(row=>row.subject===author.node && row.throughKeyEpoch>=author.keyEpoch)}
    }
  }
  return new Proxy(identity,{get:(target,key)=>key==='verifyAuthor'?verify:typeof Reflect.get(target,key)==='function'?Reflect.get(target,key).bind(target):Reflect.get(target,key)})
}
