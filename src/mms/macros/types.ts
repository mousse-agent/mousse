import type { CliType, MacroConfig, MacroStep } from '../../shared/types'

export interface MacroProvider {
  readonly cliType: CliType
  getConfig(): MacroConfig
  getCliCommand(): string
}

export interface MacroRunContext {
  prompt: string
}

export function describeSteps(steps: MacroStep[]): string {
  return steps
    .map((s) => {
      switch (s.type) {
        case 'delay':
          return `delay(${s.ms}ms)`
        case 'paste':
          return 'paste(prompt)'
        case 'key':
          return `key(${s.key})`
        case 'type':
          return `type(${s.text?.slice(0, 20)}...)`
        default:
          return s.type
      }
    })
    .join(' → ')
}
