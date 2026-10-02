export const WINDOW_RESIZE_EDGES = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'] as const
export type WindowResizeEdge = (typeof WINDOW_RESIZE_EDGES)[number]
export const WINDOW_RESIZE_BORDER = 6
export const WINDOW_RESIZE_CORNER = 24

export function isWindowResizeEdge(value: unknown): value is WindowResizeEdge {
  return WINDOW_RESIZE_EDGES.includes(value as WindowResizeEdge)
}
