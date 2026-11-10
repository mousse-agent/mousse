import type { Plugin as EsbuildPlugin } from 'esbuild'
import type { Plugin as RollupPlugin } from 'vite'

export function toAsciiSource(code: string): string
export function asciiSourcePlugin(): RollupPlugin
export function asciiSourceEsbuildPlugin(): EsbuildPlugin
