/** A frame as `Page.getFrameTree` lists it. */
export interface FrameTreeEntry { id?: string; parentId?: string; url?: string }
/** A node of `Page.getFrameTree`: a frame and the frames inside it that the same process holds. */
export interface FrameTreeNode { frame?: FrameTreeEntry; childFrames?: unknown }
/** A box in CSS pixels. */
export interface FrameBounds { x: number; y: number; width: number; height: number }

/**
 * A frame and every frame inside it. Each process lists only its own frames, so `trees` are the frame
 * trees of the tab and of every frame from another site attached in it: a same-site frame inside one
 * of those, which has no session of its own, links the frames inside it to the rest. How each frame
 * was attached (`attached`) links what the trees do not.
 */
export function framesInside(frameId: string, trees: ReadonlyArray<FrameTreeNode | undefined>, attached: ReadonlyArray<{ frameId: string; parentFrameId?: string }>): Set<string> {
  const parents = new Map<string, string | undefined>()
  const visit = (node: FrameTreeNode | undefined) => {
    if (node?.frame?.id && parents.get(node.frame.id) === undefined) parents.set(node.frame.id, node.frame.parentId)
    for (const child of Array.isArray(node?.childFrames) ? node.childFrames as FrameTreeNode[] : []) visit(child)
  }
  for (const tree of trees) visit(tree)
  for (const frame of attached) if (parents.get(frame.frameId) === undefined) parents.set(frame.frameId, frame.parentFrameId)
  const within = new Set<string>([frameId])
  for (const id of parents.keys()) {
    const seen = new Set<string>()
    for (let current: string | undefined = id; current && !seen.has(current); current = parents.get(current)) {
      if (current === frameId) {
        within.add(id)
        break
      }
      seen.add(current)
    }
  }
  return within
}

/** An attached frame, by the session that attached it. */
export interface OwnedFrame { sessionId: string; ownerSessionId: string }

/**
 * Where an attached frame sits in its tab's viewport: the box of its `<iframe>` in the viewport of
 * the session that attached it (`placeIn`), moved by where that session's own frame sits, and so on
 * up to the tab. Its `<iframe>` may sit in a same-site frame of that session, which has no session
 * of its own: the owner session, never the immediate parent frame, says whom to ask. Null when any
 * frame on the way is gone or not laid out.
 */
export async function placeAttachedFrame<F extends OwnedFrame>(
  frame: F,
  tabSessionId: string,
  attachedBySession: (sessionId: string) => F | undefined,
  placeIn: (frame: F, ownerSessionId: string) => Promise<FrameBounds | null>,
  visited = new Set<string>()
): Promise<FrameBounds | null> {
  if (visited.has(frame.sessionId)) return null
  visited.add(frame.sessionId)
  let origin = { x: 0, y: 0 }
  if (frame.ownerSessionId !== tabSessionId) {
    const owner = attachedBySession(frame.ownerSessionId)
    // The frame that held its `<iframe>` is gone: it cannot be placed.
    if (!owner) return null
    const ownerBounds = await placeAttachedFrame(owner, tabSessionId, attachedBySession, placeIn, visited)
    if (!ownerBounds) return null
    origin = ownerBounds
  }
  const box = await placeIn(frame, frame.ownerSessionId)
  return box ? { x: origin.x + box.x, y: origin.y + box.y, width: box.width, height: box.height } : null
}
