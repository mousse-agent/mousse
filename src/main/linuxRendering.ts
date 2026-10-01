type RenderingApp = {
  commandLine: { appendSwitch(name: string): void }
}

/** Call before Electron is ready, so every GUI surface uses the same policy. */
export function configureLinuxRendering(app: RenderingApp, platform: NodeJS.Platform): void {
  if (platform !== 'linux') return

  // Linux drivers can leave stale text/image pixels when resized layers reuse
  // raster buffers or present only a damaged subrectangle. Repaint complete
  // tiles and swap complete frames; keep GPU acceleration and WebGL available.
  app.commandLine.appendSwitch('disable-partial-raster')
  app.commandLine.appendSwitch('ui-disable-partial-swap')
}
