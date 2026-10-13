interface LinuxAppLauncher { relaunch(options: { args: string[] }): void; exit(code: number): void }

/** Client-side resizing needs global cursor/bounds support, which Wayland denies.
 * Use the Xwayland display when available; retain explicit backend overrides. */
export function configureLinuxWindowing(app: LinuxAppLauncher, platform: NodeJS.Platform, env: NodeJS.ProcessEnv, argv: readonly string[] = process.argv): boolean {
  if (platform !== 'linux' || !env.DISPLAY || argv.some((arg) => /^--ozone-platform(?:=|$)/.test(arg))) return false
  // GTK chooses its backend before main JS runs. Relaunch with a real argument;
  // changing commandLine here would mix Wayland GTK with X11 Chromium surfaces.
  // Development launchers pass this argument up front and skip this fallback.
  app.relaunch({ args: [...argv.slice(1), '--ozone-platform=x11'] })
  app.exit(0)
  return true
}

/** Alpha support is fixed at creation; retain it when acrylic is toggled off. */
export function linuxTransparencyOptions(platform: NodeJS.Platform): { transparent?: boolean; roundedCorners?: boolean } {
  return platform === 'linux' ? { transparent: true, roundedCorners: true } : {}
}

/** Software rendering is an explicit diagnostic fallback. Keep acceleration
 * enabled by default: CPU composition makes masked transcript scrolling costly. */
export function configureLinuxGraphics(
  app: { disableHardwareAcceleration(): void }, platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv, argv: readonly string[] = process.argv
): boolean {
  if (platform !== 'linux' || env.MOUSSE_SOFTWARE_RENDERING !== '1') return false
  if (argv.some(arg => /^--(?:use-gl|use-angle|ozone-platform)(?:=|$)/.test(arg) &&
    (arg.startsWith('--use-') || arg === '--ozone-platform=wayland'))) return false
  const ozoneIndex = argv.indexOf('--ozone-platform')
  if (ozoneIndex >= 0 && argv[ozoneIndex + 1] === 'wayland') return false
  app.disableHardwareAcceleration()
  return true
}

/** Xwayland may advertise GLX_OML_sync_control but fail its timing queries.
 * Disable that ANGLE extension, keeping accelerated composition and rendering. */
export function configureLinuxVsync(
  app: { commandLine: { getSwitchValue(name: string): string; appendSwitch(name: string, value: string): void } },
  platform: NodeJS.Platform, env: NodeJS.ProcessEnv, argv: readonly string[] = process.argv
): boolean {
  if (platform !== 'linux' || !env.DISPLAY || !env.WAYLAND_DISPLAY) return false
  if (argv.includes('--ozone-platform=wayland') ||
    (argv.includes('--ozone-platform') && argv[argv.indexOf('--ozone-platform') + 1] === 'wayland')) return false
  const feature = 'disableSyncControlSupport'
  const disabled = app.commandLine.getSwitchValue('disable-angle-features').split(',')
  if (disabled.includes(feature)) return false
  const enabled = app.commandLine.getSwitchValue('enable-angle-features').split(',').filter(Boolean)
  if (!enabled.includes(feature)) app.commandLine.appendSwitch('enable-angle-features', [...enabled, feature].join(','))
  return true
}
