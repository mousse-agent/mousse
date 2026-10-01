/** Alpha support is fixed at creation; retain it when acrylic is toggled off. */
export function linuxTransparencyOptions(platform: NodeJS.Platform): { transparent?: boolean } {
  return platform === 'linux' ? { transparent: true } : {}
}
