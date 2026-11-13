import type { AppletBundle, AppletReference } from './applets'
import type { AppletAppearance } from './appletAppearance'
export interface AppletBounds { x: number; y: number; width: number; height: number }

/** The smallest height an inline applet takes, so an empty or failed page still has a visible row. */
export const APPLET_MIN_HEIGHT = 32
/**
 * The tallest an inline applet grows; taller content scrolls inside it. 4096 CSS px stays under Chromium's
 * 16384 px bitmap edge at 200% zoom on a 2x display (4096 × 4), so the native view and its scroll snapshot are
 * still one capturable surface, and it is half the 8192 px bounds limit the runtime accepts.
 */
export const APPLET_MAX_HEIGHT = 4096
/** The height an applet reported, bounded for its frame; null when the report is not a number. */
export function appletFrameHeight(reported: unknown): number | null {
  if (typeof reported !== 'number' || !Number.isFinite(reported)) return null
  return Math.max(APPLET_MIN_HEIGHT, Math.min(APPLET_MAX_HEIGHT, Math.round(reported)))
}
export interface AppletIdentity { threadId: string; appletId: string; revisionId: string }
export interface AppletMountRequest extends AppletIdentity { sourceHash: string; title?: string; description?: string; bounds: AppletBounds; clip: AppletBounds; appearance?:AppletAppearance }
export interface AppletLayoutRequest { runtimeId: string; bounds: AppletBounds; clip: AppletBounds; visible?: boolean }
export interface AppletUiEvent { runtimeId: string; type: 'ready' | 'resize' | 'error' | 'conversation-input' | 'state-changed' | 'visual-changed' | 'released'; height?: number; message?: string; text?: string }
export interface AppletApi {
  get(input: AppletIdentity): Promise<AppletBundle>
  mount(input: AppletMountRequest): Promise<{runtimeId: string}>
  update(input: AppletLayoutRequest): Promise<void>
  appearance(input:{runtimeId:string;appearance:AppletAppearance}):Promise<void>
  snapshot(input: {runtimeId:string}): Promise<{image:string|null}>
  suspend(input: {runtimeId:string}): Promise<void>
  unmount(input: {runtimeId:string}): Promise<void>
  export(input: AppletIdentity & {format:'html'|'source'|'png';runtimeId?:string;appearance?:AppletAppearance}): Promise<{cancelled:boolean}>
  onEvent(callback:(event:AppletUiEvent)=>void):()=>void
}
export type { AppletReference }
