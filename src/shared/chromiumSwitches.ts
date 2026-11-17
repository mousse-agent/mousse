/** The part of Electron's `app.commandLine` that reads and sets Chromium switches. */
export interface SwitchCommandLine {
  getSwitchValue(name: string): string
  appendSwitch(name: string, value?: string): void
}

/**
 * Adds `item` to a comma-separated switch such as `enable-features`, keeping what is already there
 * from the command line or an earlier call. A second `appendSwitch` with the same name replaces the
 * first, so every addition to a list switch goes through here. Call before `app` is ready.
 */
export function addToSwitchList(commandLine: SwitchCommandLine, name: string, item: string): void {
  const items = commandLine.getSwitchValue(name).split(',').filter(Boolean)
  if (!items.includes(item)) commandLine.appendSwitch(name, [...items, item].join(','))
}

/**
 * Chromium writes a WebGL program to its disk cache (`GPUCache`) only when the page reads
 * `LINK_STATUS` straight after linking. The bot face renderer waits for the link by polling
 * `COMPLETION_STATUS_KHR` so the window keeps drawing, and that link was compiled again on every
 * launch (about 2.5 s on a Windows PC with ANGLE on Direct3D 11).
 *
 * `ANGLEPerContextBlobCache` (Chromium `gpu/config/gpu_finch_features.cc`) gives each GL context its
 * own ANGLE blob cache callback (`GL_ANGLE_blob_cache`), so a program reaches the disk cache however
 * its link is waited for. This covers every WebGL context, the in-app browser's pages included. Where
 * Skia draws through ANGLE's GL (Ganesh), it also sends ANGLE's programs for Skia to Skia's shader
 * cache and doubles that cache's size. It is off by default in Chromium 150 and later, on every
 * platform; Chromium added it in 2024 (crrev.com/c/5898398) and expects to turn it on by default.
 * An unknown feature name is ignored, so if Chromium drops it, programs are compiled each launch again.
 */
export const KEEP_GPU_PROGRAMS_FEATURE = 'ANGLEPerContextBlobCache'
