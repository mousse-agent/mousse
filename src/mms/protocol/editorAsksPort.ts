import type { EditorAskReply } from '../../shared/bridge/editorAsk'
import type { NodeId } from '../../shared/net/ids'

/**
 * What the protocol handler of `editor.ask` needs from the Bridge service: the asks other computers made of this
 * one. Set while Bridge is on; without it the handler says the call cannot be answered here.
 */
export interface EditorAsksPort {
  /** One computer asks this one to allow its editor connections. Never changes a setting. */
  ask(node: NodeId): EditorAskReply
}
