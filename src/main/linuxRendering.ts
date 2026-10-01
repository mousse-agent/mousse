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
