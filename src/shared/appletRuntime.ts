import type { AppletBundle, AppletReference } from './applets'
import type { AppletAppearance } from './appletAppearance'

/** The smallest height an inline applet takes, so an empty or failed page still has a visible row. */
export const APPLET_MIN_HEIGHT = 32
/**
 * The tallest an inline applet grows; taller content scrolls inside it. 4096 CSS px stays under Chromium's
 * 16384 px bitmap edge at 200% zoom on a 2x display (4096 × 4), so the page stays one capturable surface for a PNG
 * export.
 */
export const APPLET_MAX_HEIGHT = 4096
/** The height an applet reported, bounded for its frame; null when the report is not a number. */
export function appletFrameHeight(reported: unknown): number | null {
  if (typeof reported !== 'number' || !Number.isFinite(reported)) return null
  return Math.max(APPLET_MIN_HEIGHT, Math.min(APPLET_MAX_HEIGHT, Math.round(reported)))
}
/**
 * An applet a bot of another computer's message shows: the bot by its qualified id, and the message. Main reads it from
 * that computer through the bot (`bots.remote.applet`) and saves its state there; `threadId` is then only a key here.
 */
export interface AppletBotRef { botId: string; messageId: string }
export interface AppletIdentity { threadId: string; appletId: string; revisionId: string; bot?: AppletBotRef }
export interface AppletMountRequest extends AppletIdentity { sourceHash: string; appearance?: AppletAppearance; host?: 'transcript' | 'panel' }
/** What a mount answers. `readOnly`: an applet of another computer's bot shown from the copy here while that computer is away. */
export type AppletMounted = { runtimeId: string; src: string; readOnly?: true } | { busy: true }
/**
 * What the window hears about one of its applets. `wheel`: a wheel turn the applet could not use (the browser chained
 * it on to the conversation); `deltaY` in CSS pixels. `escape`: the person pressed Escape in the applet, which gives the
 * keyboard back to the thread.
 */
export interface AppletUiEvent { runtimeId: string; type: 'ready' | 'resize' | 'error' | 'conversation-input' | 'state-changed' | 'wheel' | 'escape' | 'released'; height?: number; message?: string; text?: string; deltaY?: number }
export interface AppletApi {
  get(input: AppletIdentity): Promise<Pick<AppletBundle, 'appletId' | 'revisionId' | 'sourceHash' | 'title' | 'description' | 'source'>>
  /**
   * Prepares the applet's page; `src` is the one address the window's `<webview>` for it may load. `busy`: every slot
   * holds an applet on screen; try again once one is unmounted or leaves the screen.
   */
  mount(input: AppletMountRequest): Promise<AppletMounted>
  /** The applet's card left the screen (it may be released for a newer applet) or came back. */
  visible(input: {runtimeId: string; visible: boolean}): Promise<void>
  appearance(input:{runtimeId:string;appearance:AppletAppearance}):Promise<void>
  unmount(input: {runtimeId:string}): Promise<void>
  export(input: AppletIdentity & {format:'html'|'source'|'png';runtimeId?:string;appearance?:AppletAppearance}): Promise<{cancelled:boolean}>
  onEvent(callback:(event:AppletUiEvent)=>void):()=>void
}
export type { AppletReference }
