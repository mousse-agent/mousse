import { readFileSync } from 'fs'
import { join } from 'path'
import type { MacroConfig } from '../../../shared/types'
import type { MacroProvider } from '../types'

export class ClaudeCodeMacroProvider implements MacroProvider {
  readonly cliType = 'claude-code' as const
  private config: MacroConfig

  constructor(macrosDir: string) {
    this.config = JSON.parse(
      readFileSync(join(macrosDir, 'claude-code.json'), 'utf-8')
    ) as MacroConfig
  }

  getConfig(): MacroConfig {
    return this.config
  }

  getCliCommand(): string {
    return this.config.cliCommand
  }
}
