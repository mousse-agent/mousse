type RenderingApp = {
  commandLine: { appendSwitch(name: string): void }
  disableHardwareAcceleration(): void
}

/** Call before Electron is ready, so every GUI surface uses the same policy. */
export function configureLinuxRendering(app: RenderingApp, platform: NodeJS.Platform): void {
  if (platform !== 'linux') return

  // Full repaint flags alone do not prevent trails on affected Linux/Wayland
  // drivers, including when moving the window without changing its layout.
  // Bypass accelerated raster/compositing before any GUI surface initializes.
  app.disableHardwareAcceleration()
  app.commandLine.appendSwitch('disable-partial-raster')
  app.commandLine.appendSwitch('ui-disable-partial-swap')
}
