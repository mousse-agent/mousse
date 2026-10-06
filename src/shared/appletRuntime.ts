import type { AppletBundle, AppletReference } from './applets'
export interface AppletBounds { x: number; y: number; width: number; height: number }
export interface AppletIdentity { threadId: string; appletId: string; revisionId: string }
export interface AppletMountRequest extends AppletIdentity { sourceHash: string; title?: string; description?: string; bounds: AppletBounds; clip: AppletBounds }
export interface AppletLayoutRequest { runtimeId: string; bounds: AppletBounds; clip: AppletBounds; visible?: boolean }
export interface AppletUiEvent { runtimeId: string; type: 'ready' | 'resize' | 'error' | 'conversation-input'; height?: number; message?: string; text?: string }
export interface AppletApi {
  get(input: AppletIdentity): Promise<AppletBundle>
  mount(input: AppletMountRequest): Promise<{runtimeId: string}>
  update(input: AppletLayoutRequest): Promise<void>
  snapshot(input: {runtimeId:string}): Promise<{image:string|null}>
  suspend(input: {runtimeId:string}): Promise<void>
  unmount(input: {runtimeId:string}): Promise<void>
  export(input: AppletIdentity & {format:'html'|'source'|'png';runtimeId?:string}): Promise<{cancelled:boolean}>
  onEvent(callback:(event:AppletUiEvent)=>void):()=>void
}
export type { AppletReference }
