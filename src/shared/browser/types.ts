export const BROWSER_CONTRACT_VERSION = 1 as const
export type BrowserLifecycle = 'starting' | 'ready' | 'agent-controlled' | 'human-controlled' | 'waiting-approval' | 'disconnected' | 'recovering' | 'closed'
export type BrowserCapabilityTier = 'structured' | 'hybrid' | 'native'

export interface BrowserHumanHandoff {
  requestId: string
  reason: string
  operation?: string
  state: 'requesting' | 'waiting-human' | 'resumed' | 'closed' | 'unknown'
  createdAt: string
  updatedAt: string
}

export interface BrowserSessionRecord {
  capabilities?: import('./capabilities').BrowserBackendCapabilities
  id: string
  profileId: string
  runId?: string
  threadId?: string
  workspaceId?: string
  persistent: boolean
  backend: 'managed-chromium' | 'electron-attached'
  browserVersion: string
  generation: number
  lifecycle: BrowserLifecycle
  controlLeaseId?: string
  humanHandoff?: BrowserHumanHandoff
  createdAt: string
  updatedAt: string
}
export interface BrowserPoint { x: number; y: number }
export interface BrowserBounds extends BrowserPoint { width: number; height: number }
export interface BrowserViewport {
  cssWidth: number
  cssHeight: number
  deviceScaleFactor: number
  scrollX: number
  scrollY: number
}
export interface BrowserScreenshot {
  artifactId: string
  pixelWidth: number
  pixelHeight: number
  cssToImageScaleX: number
  cssToImageScaleY: number
  cropOriginCss?: BrowserPoint
}
export interface BrowserArtifactMetadata {
  artifactId: string
  byteLength: number
  sha256: string
  mediaType: string
  displayName?: string
}
export interface BrowserElement {
  ref: string
  frameRef: string
  role?: string
  name?: string
  text?: string
  bounds?: BrowserBounds
  states: string[]
}
export interface BrowserTab { id: string; title: string; url: string }
export interface BrowserObservation {
  sessionId: string
  tabId: string
  generation: number
  observationId: string
  documentId: string
  capturedAt: string
  url: string
  title: string
  viewport: BrowserViewport
  tabs: BrowserTab[]
  elements: BrowserElement[]
  screenshot?: BrowserScreenshot
  truncated: boolean
  continuation?: string
  warnings: string[]
  provenance: 'untrusted-page'
}
export type BrowserTarget = { kind: 'ref'; ref: string } | { kind: 'image-point'; point: BrowserPoint }
export type BrowserAction =
  | { type: 'navigate'; url: string }
  | { type: 'back' | 'forward' | 'reload' }
  | { type: 'click' | 'double-click' | 'hover'; target: BrowserTarget; button?: 'left' | 'right' | 'middle' }
  | { type: 'fill' | 'type'; target: BrowserTarget; text: string }
  | { type: 'key'; key: string; target?: BrowserTarget }
  | { type: 'select'; target: BrowserTarget; values: string[] }
  | { type: 'check'; target: BrowserTarget; checked: boolean }
  | { type: 'scroll'; target?: BrowserTarget; deltaX: number; deltaY: number }
  | { type: 'drag'; from: BrowserTarget; to: BrowserTarget }
  | { type: 'upload'; target: BrowserTarget; artifactIds: string[]; /** MMS broker-injected, never model supplied. */ resolvedArtifacts?: BrowserResolvedArtifact[] }
  | { type: 'dialog'; accept: boolean; promptText?: string }

export type BrowserWaitCondition =
  | { type: 'url'; equals?: string; includes?: string }
  | { type: 'text'; text: string; present: boolean }
  | { type: 'element'; ref: string; state: 'visible' | 'hidden' | 'enabled' | 'disabled' }
  | { type: 'document-ready' }

export interface BrowserActionRequest {
  requestId: string
  sessionId: string
  tabId: string
  generation: number
  observationId: string
  controlLeaseId: string
  action: BrowserAction
  timeoutMs: number
  expected?: BrowserWaitCondition
}
export type BrowserActionOutcome = 'verified' | 'unverified' | 'blocked' | 'failed' | 'unknown-effect'
/** Whether an action a person's Take over cut short took effect: done, never sent, or can't be told. */
export type BrowserTakeoverEffect = 'applied' | 'not-applied' | 'unknown'

/** What an agent is told of its action when a person took the browser over while it ran (`who`: "A person", "Your owner"). */
export function browserTakeoverMessage(effect: BrowserTakeoverEffect, who = 'A person'): string {
  switch (effect) {
    case 'applied': return `${who} took over the browser just after this action was done: it was applied. The page may have changed since. Observe it again once you have the browser back, and do not repeat this action.`
    case 'not-applied': return `${who} took over the browser before this action ran: it was not applied. Once you have the browser back, observe the page again, then decide whether it is still needed.`
    case 'unknown': return `${who} took over the browser while this action ran: it may or may not have been applied. Once you have the browser back, observe the page again to see whether it took effect before you repeat it.`
  }
}
export interface BrowserActionResult {
  requestId: string
  outcome: BrowserActionOutcome
  dispatched: boolean
  /** A person took the browser over while this action ran (`code` `human_controlled`): whether it took effect. */
  takeover?: BrowserTakeoverEffect
  observation?: BrowserObservation
  code?: BrowserErrorCode
  message?: string
  artifactIds: string[]
  artifacts?: BrowserArtifactMetadata[]
  /** For navigate, back, forward and reload: whether the page is ready or still loading, and what it needs. */
  navigation?: import('./navigation').BrowserNavigation
}
export interface BrowserResolvedArtifact {
  artifactId: string
  path: string
  byteLength: number
  displayName: string
  mediaType?: string
}
/** A mouse button as CDP names it. */
export type BrowserMouseButton = 'left' | 'middle' | 'right'
/** Modifier keys held, as CDP counts them: Alt 1, Ctrl 2, Meta (Command) 4, Shift 8. */
export const BROWSER_MODIFIERS = { alt: 1, ctrl: 2, meta: 4, shift: 8 } as const
/**
 * The editing commands a shortcut runs in the page (a browser without a window has no menu to run
 * them). Copy and cut are not among them: the person's copy reads the selection (`copy`), and never
 * puts it on the browser's own clipboard.
 */
export type BrowserEditCommand = 'selectAll' | 'undo' | 'redo'
/** The most text one paste puts into a page. */
export const MAX_BROWSER_PASTE_CHARS = 64_000

/**
 * Input a person sends to a managed tab while they hold its control (a bot's browser view), at
 * viewport CSS pixels. Sent as trusted input; never a model's.
 *
 * - `click`, `scroll`, `type` and `key` are the plain forms (an older view sends them).
 * - `pointer` is one mouse event: a button going down or up, or the pointer moving (with the buttons
 *   held, so a move with a button down drags). `clicks` counts presses in a row (2 for a double click).
 * - `keys` is one key going down or up, with the modifiers held, the key's code, and the text it types;
 *   `command` runs the editing command its shortcut stands for.
 * - `compose` is IME composition text (and a dead key's mark) as it stands; `type` commits text.
 * - `paste` puts the person's clipboard text into the page; `copy` reads the page's selected text as
 *   plain text (and `cut` then deletes it in an editable field), for the person's clipboard only: the
 *   browser's own clipboard never holds it, and the page hears no copy.
 * - `dialog` answers the page's alert, confirm, prompt or leave-page question; `files` answers its
 *   file picker with files the person chose in this computer's own file dialog (none: cancelled).
 * - A positioned input (`click`, `scroll`, `pointer`) needs the spot of the picture it was made on;
 *   without one it is refused (a button the person holds is still let go of).
 * - `release` lets go of every key and button the person left down, and any composition.
 */
export type BrowserHumanInput =
  | { kind: 'click'; x: number; y: number }
  | { kind: 'scroll'; x: number; y: number; deltaX: number; deltaY: number; modifiers?: number }
  | { kind: 'type'; text: string }
  | { kind: 'key'; key: string }
  | { kind: 'pointer'; type: 'down' | 'up' | 'move'; x: number; y: number; button: BrowserMouseButton | 'none'; buttons: number; clicks?: number; modifiers?: number }
  | { kind: 'keys'; type: 'down' | 'up'; key: string; code: string; keyCode: number; modifiers: number; text?: string; repeat?: boolean; command?: BrowserEditCommand }
  | { kind: 'compose'; text: string; selectionStart: number; selectionEnd: number }
  | { kind: 'paste'; text: string }
  | { kind: 'copy'; cut?: boolean }
  | { kind: 'dialog'; accept: boolean; text?: string }
  | { kind: 'files'; paths: string[] }
  | { kind: 'release' }
  | { kind: 'navigate'; url: string }
  | { kind: 'back' }
  | { kind: 'forward' }
  | { kind: 'reload' }

/**
 * Where a picture the person acted on was taken: its document and scroll (`human.input`'s fence), and,
 * while a person holds the browser, what was on top at a grid of points of it (`hits`).
 */
export interface BrowserPictureSpot {
  documentId: string
  scrollX: number
  scrollY: number
  hits?: BrowserPictureHits
}

/**
 * The element on top at each point of a grid over a picture, read as it was taken: a press on an
 * older picture is checked against the same points now (the element under them, and where it sits on
 * the page), so a modal, a shift of the layout or an inner scroll since is not clicked through.
 * `samples` holds three numbers a point, row by row: the element's id in the reading world (0 for
 * none), and its left and top on the page in CSS pixels. `world` names the reading world: ids from
 * another one mean nothing.
 */
export interface BrowserPictureHits {
  world: string
  width: number
  height: number
  cols: number
  rows: number
  samples: number[]
}

/** A page's open alert, confirm, prompt or leave-page question, for the person watching. */
export interface BrowserPageDialog {
  type: 'alert' | 'confirm' | 'prompt' | 'beforeunload'
  /** The page's words (untrusted, bounded). */
  message: string
  /** A prompt's text as the page filled it in. */
  defaultPrompt?: string
}

/** A page's file picker waiting for the person (`Page.fileChooserOpened` while they hold the browser), and the site that asks. */
export interface BrowserFileChooser {
  multiple: boolean
  site?: string
}

/**
 * What became of one input in `human.input`: applied (with what a copy read, how far a point moved
 * because the page scrolled since its picture, or how a navigation went), or refused with a code:
 * `page_changed` (the picture was of another page, of what has scrolled out of view, or what was under
 * the press has changed; or the input came with no picture to place it), `dialog_open` (the page waits
 * for its dialog), `no_chooser`, `too_large`.
 */
export type BrowserHumanInputResult =
  | { applied: true; copied?: string; shifted?: { x: number; y: number }; navigation?: import('./navigation').BrowserNavigation }
  | { applied: false; code: 'page_changed' | 'dialog_open' | 'no_chooser' | 'too_large'; message: string }

/**
 * A live picture of a managed tab for a person watching (a bot's browser preview): not an
 * observation, never sent to a model, never stored. `data` is a JPEG in base64.
 */
export interface BrowserViewerFrame {
  tabId: string
  url: string
  title: string
  data: string
  mimeType: 'image/jpeg'
  /** The image's pixels. */
  width: number
  height: number
  /** The page's viewport in CSS pixels, which the image shows whole. */
  viewport: { width: number; height: number }
  capturedAt: string
  /** Where the agent last acted in this tab, while it is recent. */
  cursor?: import('./agentCursor').BrowserAgentCursor
  /** The document and scroll it shows (for a person's input on it). */
  spot?: BrowserPictureSpot
}

/**
 * A watcher's next update of a managed tab (`frame.next`): the tab's state each time, and its latest
 * picture when the watcher has not had it. Pass `frameSeq` and `stateSeq` back to wait for the next.
 */
export interface BrowserViewerUpdate {
  tabId: string
  url: string
  title: string
  /** The page's viewport in CSS pixels, which a picture shows whole. */
  viewport: { width: number; height: number }
  /** The tab is not the one in front: Chromium does not paint it, so its picture is a still. */
  behind: boolean
  /** The page is still loading. */
  loading?: boolean
  /** What the tab's last navigation ran into, or what its opened page needs (a sign-in, a human check). */
  problem?: import('./navigation').BrowserProblem
  /** The page's open dialog, waiting for an answer. */
  dialog?: BrowserPageDialog
  /** The page's file picker, waiting for files (only while a person holds the browser). */
  chooser?: BrowserFileChooser
  frameSeq: number
  stateSeq: number
  /**
   * A JPEG in base64; `sharp` when taken at full quality once the page was still. `spot`: the
   * document and scroll it shows, so a person's input on it lands on what they saw.
   */
  picture?: { data: string; width: number; height: number; at: number; sharp: boolean; spot?: BrowserPictureSpot }
  /** Where the agent last acted in this tab, while it is recent. */
  cursor?: import('./agentCursor').BrowserAgentCursor
  /** Nothing changed within the wait. */
  idle?: true
}

export type BrowserErrorCode = 'setup_required' | 'profile_mismatch' | 'session_closed' | 'stale_generation' | 'stale_observation' | 'stale_ref' | 'invalid_geometry' | 'not_actionable' | 'policy_denied' | 'approval_required' | 'human_controlled' | 'timeout' | 'cancelled' | 'worker_disconnected' | 'unsupported' | 'invalid_action' | 'no_progress' | 'download_failed' | 'artifact_denied'
  | import('./navigation').BrowserProblemCode

/** Private broker envelope: validated by MMS; never exposed to page or model JS. */
export interface BrowserWorkerRequest {
  version: 1
  id: string
  profileId: string
  method: 'session.open' | 'session.close' | 'tabs.list' | 'tabs.new' | 'tabs.close' | 'tabs.switch' | 'observe' | 'find' | 'act' | 'human.act' | 'wait' | 'extract' | 'control.take' | 'control.release' | 'frame' | 'frame.next' | 'frame.stop' | 'human.input'
  params: Record<string, unknown>
}
export interface BrowserWorkerResponse {
  version: 1
  id: string
  ok: boolean
  result?: unknown
  /** `details.problem`: a failed navigation's class and Chromium's own code (`BrowserProblem`). */
  error?: { code: BrowserErrorCode; message: string; details?: { problem?: import('./navigation').BrowserProblem } }
}
