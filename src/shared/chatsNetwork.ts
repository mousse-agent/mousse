import type { BotId, BotProfile, DispatchId, Envelope, ExecutionId, NodeId, RpcArtifactRef, RpcId, SpaceId, StreamDescriptor, StreamHead, StreamId, UserId } from './net'
import type { BridgeDispatchInput, BridgeHubRequestStatus } from './bridge'
import type { SpaceLocalDelivery } from './spaces/local'

export const CHAT_NETWORK_METHODS = ['chats.publish', 'chats.publication', 'chats.bind', 'chats.work.get', 'chats.dispatch', 'chats.aside.create', 'chats.aside.send', 'chats.aside.get'] as const
export type ChatNetworkMethod = typeof CHAT_NETWORK_METHODS[number]
export interface ChatPublishInput { chatId: string; publicationId: string; name?: string }
export interface ChatBindInput { bindingId: string; space: SpaceId; channel: StreamId }
export interface ChatNetworkPageInput { after?: StreamHead; limit?: number }
export interface ChatWorkGetInput extends ChatNetworkPageInput { chatId:string; stream:StreamId }
export interface ChatWorkProjection {
  binding:ChatNetworkBinding; descriptor:StreamDescriptor; private:boolean; head:StreamHead; cursor:StreamHead; nextAfter?:StreamHead
  records:Array<{epoch:number;seq:number;recvTs:number;envelope:Envelope;privateBody?:unknown}>
}
export interface ChatTaskSelectionInput {chatId:string;taskId:RpcId;deviceId:NodeId;input:BridgeDispatchInput;bot?:BotId}
export interface ChatTaskSelection {kind:'bridge-task';chatId:string;taskId:RpcId;target:NodeId;validation:'pendingTargetValidation'|'authorized'|'rejected';status:BridgeHubRequestStatus}
export interface ChatTaskDispatchInput {chatId:string;taskId:RpcId}
/** Already verified against the original target/RPC/repository; paths and credentials are absent. */
export interface ChatTaskVerifiedResult {
  v:1;kind:'bridge.dispatch.result.v1';dispatch:DispatchId;execution:ExecutionId;rpc:RpcId;requestHash:string
  author:{user:UserId;node:NodeId;keyEpoch:number};issuedAt:number
  repoId:string;baseCommit:string;headCommit:string;branch:string;ref:string;bundleHash:string;artifact:RpcArtifactRef
  agent:{definitionId:string;revision:string;profileId:string};threadId:string;errors:[]
}
export interface ChatTaskDispatchResult {selection:ChatTaskSelection;result:ChatTaskVerifiedResult}
export interface ChatAsideCreateInput {chatId:string;asideId:string;participants:UserId[]}
export interface ChatAsideCreation {
  chatId:string;asideId:string;stream:StreamId;participants:UserId[];opening:import('./net').EventId;control:import('./net').EventId
  state:SpaceLocalDelivery['state'];parentDelivery:SpaceLocalDelivery;controlDelivery:SpaceLocalDelivery
}
export interface ChatAsideSendInput {chatId:string;stream:StreamId;text:string;clientMessageId:string}
export interface ChatAsideSendResult {chatId:string;stream:StreamId;delivery:SpaceLocalDelivery}
export type ChatAsideGetInput=ChatWorkGetInput
export interface ChatAsideProjection extends ChatWorkProjection {
  private:true;audience:{controller:UserId;participants:UserId[];keyEpoch:number;visibilityEpoch:number}
}
export interface NetworkChatParticipant {
  id: UserId | BotId; kind: 'person' | 'agent'; name: string; active: boolean
  deviceId?: NodeId; profile?: BotProfile
  slug?: never; definitionId?: never; definitionRevision?: never
}
/** A joined presentation allocates neither a local executable thread nor a workspace. */
export interface NetworkChatSummary {
  presentation: 'network'; id: string; kind: 'group'; name: string
  participants: NetworkChatParticipant[]; createdAt: string; updatedAt: string
  binding: ChatNetworkBinding
  threadId?: never; projectId?: never; run?: never; lastMessage?: never
}
export interface NetworkChatConversation extends NetworkChatSummary {
  messages: never[]; network: ChatNetworkProjection; pendingQuestions?: never
}
export interface ChatNetworkBinding {
  publicationId: string; space: SpaceId; channel: StreamId; owner: UserId; state: 'published'
  localHistory: { messageCount: number; lastMessageId?: string }
}
/** A rebuilt display projection, never a ChatStore record or execution input. */
export interface ChatNetworkProjection {
  binding: ChatNetworkBinding
  head: StreamHead
  cursor: StreamHead
  participants: NetworkChatParticipant[]
  offline: boolean
  readonly: boolean
  records: Array<{ epoch: number; seq: number; recvTs: number; envelope: Envelope }>
  nextAfter?: StreamHead
  delivery?: SpaceLocalDelivery
}
export interface ChatNetworkSendInput {
  chatId: string; text: string; clientMessageId: string; mentions?: import('./net').BotId[]
}
