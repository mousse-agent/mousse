import { useLayoutEffect, useState, type RefObject } from 'react'

/** The element's width, kept up to date as it resizes. */
export function useWidth<T extends HTMLElement>(ref: RefObject<T | null>): number {
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    setWidth(element.getBoundingClientRect().width)
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width))
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref])
  return width
}

/** A smooth curve through the points that never overshoots them (monotone cubic). */
export function smoothPath(points: ReadonlyArray<readonly [number, number]>, move = true): string {
  const n = points.length
  if (n === 0) return ''
  const fmt = (value: number) => Math.round(value * 10) / 10
  let path = `${move ? 'M' : 'L'}${fmt(points[0][0])},${fmt(points[0][1])}`
  if (n === 1) return path
  const dx: number[] = []
  const slope: number[] = []
  for (let i = 0; i < n - 1; i++) {
    dx[i] = points[i + 1][0] - points[i][0]
    slope[i] = (points[i + 1][1] - points[i][1]) / dx[i]
  }
  const tangent: number[] = [slope[0]]
  for (let i = 1; i < n - 1; i++) {
    tangent[i] = slope[i - 1] * slope[i] <= 0
      ? 0
      : (3 * (dx[i - 1] + dx[i])) / ((2 * dx[i] + dx[i - 1]) / slope[i - 1] + (dx[i] + 2 * dx[i - 1]) / slope[i])
  }
  tangent[n - 1] = slope[n - 2]
  for (let i = 0; i < n - 1; i++) {
    const [x0, y0] = points[i]
    const [x1, y1] = points[i + 1]
    const h = dx[i] / 3
    path += ` C${fmt(x0 + h)},${fmt(y0 + tangent[i] * h)} ${fmt(x1 - h)},${fmt(y1 - tangent[i + 1] * h)} ${fmt(x1)},${fmt(y1)}`
  }
  return path
}
