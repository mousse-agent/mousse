import { readFileSync } from 'fs'
import { join } from 'path'
import type { MacroConfig } from '../../../shared/types'
import type { MacroProvider } from '../types'

export class OpenCodeMacroProvider implements MacroProvider {
  readonly cliType = 'opencode' as const
  private config: MacroConfig

  constructor(macrosDir: string) {
    this.config = JSON.parse(
      readFileSync(join(macrosDir, 'opencode.json'), 'utf-8')
    ) as MacroConfig
  }

  getConfig(): MacroConfig {
    return this.config
  }

  getCliCommand(): string {
    return this.config.cliCommand
  }
}
