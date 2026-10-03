/** Electron must receive its display backend before GTK initializes. */
export function linuxGuiLaunchArgs(args, platform = process.platform, env = process.env) {
  if (platform !== 'linux' || !env.DISPLAY || args.some(arg => /^--ozone-platform(?:=|$)/.test(arg))) return args
  return [...args, ...(args.includes('--') ? [] : ['--']), '--ozone-platform=x11']
}
